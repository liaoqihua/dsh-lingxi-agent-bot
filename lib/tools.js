// 灵犀 · 模型可调用的工具。工具是"插件内部能力"，不是通用命令面板。
import { PATHS } from './config.js'
import { forgetForTool, rememberForTool, searchForTool, sessionMemoryState } from './memory.js'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { moodSnapshot, moodToolText } from './mood.js'
import { sessionIdOf } from './util.js'
import { synthesizeToFile, cleanupVoiceFile } from './voice.js'
import { noteVoiceSent, readVoiceUsage } from './voice-prompt.js'

function requireSessionId(exec) {
  const sessionId = sessionIdOf(exec?.agent?.session) || String(exec?.sessionId ?? '')
  if (!sessionId) throw new Error('拿不到当前会话 id，这个工具只能在会话里用。')
  return sessionId
}

function botIdForExec(bridge, exec) {
  try {
    const sessionId = requireSessionId(exec)
    return bridge?.recordForSession?.(sessionId)?.botId || ''
  } catch {
    return ''
  }
}

function tool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        try {
          return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
        } catch {
          return [{ type: 'text', text: String(value ?? '') }]
        }
      },
    },
    async execute(args, exec) {
      return jsonSafe(await execute(args, exec))
    },
  }
}

/** 工具结果必须是「无损 JSON」：去掉 undefined/函数，非有限数字降级成 null。 */
function jsonSafe(value, seen = new WeakSet()) {
  if (value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function' || typeof value === 'symbol') return null
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return null
  seen.add(value)
  if (Array.isArray(value)) {
    const out = value.map((item) => jsonSafe(item, seen))
    seen.delete(value)
    return out
  }
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    out[key] = jsonSafe(item, seen)
  }
  seen.delete(value)
  return out
}

function findConversation(bridge, exec, target) {
  const rows = bridge.listConversations()
  if (target) {
    const needle = String(target).trim()
    const hit = rows.find((row) => row.key === needle || row.title === needle
      || row.sessionId === needle || row.key.endsWith(`:${needle}`))
    if (!hit) throw new Error(`找不到聊天「${needle}」。可用：${rows.map((r) => r.title || r.key).slice(0, 8).join('、') || '（还没有）'}`)
    return hit
  }
  const sessionId = sessionIdOf(exec?.agent?.session) || ''
  const own = rows.find((row) => row.sessionId === sessionId)
  if (own) return own
  if (rows.length === 1) return rows[0]
  if (!rows.length) throw new Error('还没有绑定任何聊天。先在 QQ / 微信 / 飞书里说一句话。')
  throw new Error(`当前会话没有绑定聊天，请用 to 指定一个：${rows.map((r) => r.title || r.key).slice(0, 8).join('、')}`)
}

export function installTools(ctx, deps) {
  const { getConfig, bridge, channels, botManager, proactive, botProactive, schedule, logger } = deps
  if (!getConfig().tools.enabled) return
  const disposers = []
  /** 机器人状态目录；拿不到就返回空串——工具照常工作，只是不记账。 */
  const stateDirOf = (botId) => {
    if (!botId) return ''
    try { return botManager?.registry?.stateDir?.(botId) ?? '' } catch { return '' }
  }
  const add = (definition) => {
    try {
      const dispose = ctx.tools.register(definition)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      logger?.warn?.(`companion: 注册工具 ${definition.name} 失败：${error?.message ?? error}`)
    }
  }

  add(tool(
    'memory_remember',
    '把一件值得长期记住的事写进灵犀的记忆。用于对方明确让你记住、或你自己判断以后会用到的事。同一件会变化的事（身高、住址、约定地点）请给 factKey（如「主人.身高」，键里不要写具体值），旧的会自动被标记为已取代。',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '一句话，第一人称记自己、用对方称呼记对方，带具体细节。' },
        importance: { type: 'integer', minimum: 0, maximum: 100, description: '重要度，默认 60。' },
        emotion: { type: 'integer', minimum: 0, maximum: 100, description: '这件事带多少情绪，默认 0。' },
        factKey: { type: 'string', description: '会变化的事给「对象.方面」，例如 主人.身高；不要写具体值。' },
        longTerm: { type: 'boolean', description: '画像/喜好/约定这种长期事实设为 true。' },
      },
      required: ['text'],
    },
    (args, exec) => rememberForTool(requireSessionId(exec), args, getConfig(), botIdForExec(bridge, exec)),
  ))

  add(tool(
    'memory_search',
    '在灵犀的记忆里找跟某句话有关的事。返回命中的记忆、日期和分数；找不到就如实说找不到，不要编。',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '要搜的话或关键词。' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '最多几条，默认 8。' },
      },
      required: ['query'],
    },
    (args, exec) => searchForTool(requireSessionId(exec), String(args.query ?? ''), args.limit ?? 8, getConfig(), botIdForExec(bridge, exec)),
  ))

  add(tool(
    'memory_forget',
    '删掉一条记忆（按 id 或原句匹配）。删除是软删除，内容仍留在文件里，只是不再被想起来；不要滥用。',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '记忆 id（memory_search 会给）。' },
        query: { type: 'string', description: '原句里能唯一匹配的一段文字。' },
      },
    },
    (args, exec) => forgetForTool(requireSessionId(exec), args, botIdForExec(bridge, exec)),
  ))

  add(tool(
    'mood_status',
    '看灵犀此刻的心情和情绪。每台机器人有自己的心情；返回数值、标签和最近一次变化的原因。',
    { type: 'object', additionalProperties: false, properties: {} },
    (args, exec) => {
      const botId = botIdForExec(bridge, exec)
      if (!botId) return { botId: '', mood: null, dims: [], text: '这个会话没有绑定机器人，心情只属于机器人。' }
      // 称呼用这台机器人的（没设过 moodLine 会回落插件级默认）。
      const ownerName = botManager?.registry?.get?.(botId)?.ownerName || ''
      return { text: moodToolText(getConfig(), botId, ownerName), ...moodSnapshot(getConfig(), botId, ownerName) }
    },
  ))

  add(tool(
    'persona_get',
    '查看当前机器人的人格文件；只有机器人会话有人格，普通 DSH 会话没有。',
    { type: 'object', additionalProperties: false, properties: {} },
    (_args, exec) => {
      const botId = botIdForExec(bridge, exec)
      const bot = botId ? botManager?.registry?.get?.(botId) : null
      if (!bot) return { botId: '', chars: 0, sources: [], preview: '' }
      const file = join(botManager.registry.stateDir(bot.id), 'persona.md')
      let text = ''
      try { text = readFileSync(file, 'utf8') } catch { /* 空人格 */ }
      return {
        botId: bot.id,
        botName: bot.name,
        chars: text.length,
        sources: [{ kind: 'bot', path: file }],
        preview: text.slice(0, 2_000),
      }
    },
  ))

  add(tool(
    'persona_set',
    '改写当前机器人的人格文件。只有机器人会话能用；会覆盖原文件，请先 persona_get 看清内容再改。',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '完整的新人格正文（Markdown）。' },
      },
      required: ['text'],
    },
    (args, exec) => {
      const botId = botIdForExec(bridge, exec)
      const bot = botId ? botManager?.registry?.get?.(botId) : null
      if (!bot) throw new Error('这个会话不属于任何机器人，不能写人格。')
      const dir = botManager.registry.stateDir(bot.id)
      mkdirSync(dir, { recursive: true })
      const text = String(args.text ?? '')
      if (text.length > 20_000) throw new Error('人格最多 20000 字')
      const file = join(dir, 'persona.md')
      writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 })
      return { botId: bot.id, path: file, chars: text.length }
    },
  ))

  add(tool(
    'companion_send',
    '主动往一个已绑定的聊天（QQ、微信、飞书）发一句话。不指定 to 时，默认发到当前会话绑定的那个聊天。它只发消息，不开新回合。',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '要发的内容。' },
        to: { type: 'string', description: '聊天 key / 标题 / 会话 id；不填=当前会话绑定的聊天。' },
      },
      required: ['text'],
    },
    async (args, exec) => {
      const record = findConversation(bridge, exec, args.to)
      const text = String(args.text ?? '').trim()
      if (!text) throw new Error('text 不能为空')
      const result = await bridge.sendToConversation(record, { text })
      if (!result?.ok) throw new Error(result?.error || '发送失败')
      return { ok: true, to: record.title || record.key, messageId: result.messageId ?? null }
    },
  ))

  add(tool(
    'companion_voice',
    '把一句话合成语音，作为一条真正的语音条发到 QQ（官方 Bot）。文字仍由通道正常发送，这条语音是额外的一条。气氛合适时就主动发（撒娇、安慰、道晚安、被夸），不用等对方开口；代码、网址、列表不适合朗读。',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '要念出来的话，口语短句最好。' },
        to: { type: 'string', description: '聊天 key / 标题 / 会话 id；不填=当前会话绑定的聊天。' },
      },
      required: ['text'],
    },
    async (args, exec) => {
      const config = getConfig()
      if (!config.voice.enabled) throw new Error('语音合成在设置里关着')
      const text = String(args.text ?? '').trim()
      if (!text) throw new Error('text 不能为空')
      const record = findConversation(bridge, exec, args.to)
      if (record.channel !== 'qq') throw new Error('语音条目前只支持 QQ')
      const channel = bridge.channelFor(record)
      if (!channel?.sendVoice) throw new Error('QQ 官方 Bot 还没连接')
      const voice = await synthesizeToFile(ctx, config, text)
      try {
        const result = await channel.sendVoice({ record, file: voice.file })
        if (!result?.ok) throw new Error(result?.error || '语音发送失败')
        // 记账：注入里靠这个判断「刚发过语音就先别又发」，跨进程也有效。
        noteVoiceSent(stateDirOf(botIdForExec(bridge, exec)), text)
        return {
          ok: true,
          transport: 'qq',
          to: record.title || record.key,
          bytes: voice.bytes.length,
          format: voice.format,
          messageId: result.messageId ?? null,
        }
      } finally {
        cleanupVoiceFile(voice.file)
      }
    },
  ))

  add(tool(
    'companion_status',
    '体检：看通信通道连没连上，以及当前机器人的心情、主动搭话、记忆和定时任务。回答"你现在能收到我消息吗"之前先用它确认，不要猜。',
    { type: 'object', additionalProperties: false, properties: {} },
    (_args, exec) => {
      const config = getConfig()
      const sessionId = sessionIdOf(exec?.agent?.session) || ''
      const botId = botIdForExec(bridge, { sessionId })
      const mood = botId ? moodSnapshot(config, botId, botManager?.registry?.get?.(botId)?.ownerName || '') : null
      return {
        channels: channels.status().map((row) => ({
          channel: row.name,
          enabled: row.enabled,
          connected: row.connected ?? (row.configured === true ? 'configured' : undefined),
          lastError: row.lastError || '',
          callback: row.callback || row.inbound || '',
        })),
        mood: botId ? {
          botId: mood.botId || botId,
          value: mood.mood,
          label: mood.label,
          reason: mood.lastReason,
        } : null,
        proactive: botId && botProactive ? botProactive.status(botId) : null,
        schedule: botId && schedule ? schedule.brief(botId) : null,
        memory: botId && sessionId ? sessionMemoryState(sessionId, config, botId) : null,
        voice: {
          enabled: config.voice.enabled,
          qq: channels.status().find((row) => row.name === 'qq') ?? null,
          // 语音注入的状态：模型被不被提醒「主动发语音」、上次发是什么时候。
          prompt: (() => {
            const usage = botId ? readVoiceUsage(stateDirOf(botId)) : { lastAt: 0, saidAt: [] }
            const today = new Date()
            today.setHours(0, 0, 0, 0)
            return {
              enabled: config.voice.enabled && config.voice.promptEnabled !== false,
              custom: Boolean(String(config.voice.prompt ?? '').trim()),
              lastSentAt: usage.lastAt || null,
              sentToday: usage.saidAt.filter((at) => Number(at) >= today.getTime()).length,
            }
          })(),
        },
        personaBotChars: (() => {
          try {
            const botId = botIdForExec(bridge, { sessionId })
            const bot = botId ? botManager?.registry?.get?.(botId) : null
            if (!bot) return 0
            return readFileSync(join(botManager.registry.stateDir(bot.id), 'persona.md'), 'utf8').length
          } catch { return 0 }
        })(),
        diag: PATHS.diag,
      }
    },
  ))

  // ---- 定时激活：到点把「任务内容」重新激活到这个聊天 ----
  // 没有定时服务时这三个工具不注册（老装配/测试里可能没传），别让缺依赖变成半残工具。
  if (schedule) {
    add(tool(
      'companion_schedule',
      '给自己定一个定时任务：等一段时间后，灵犀会把任务内容重新激活成一条消息，你像收到新消息一样处理它，回复照常回到这个聊天。适合「过十分钟提醒我」「半小时后再来看这件事」。',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: '任务内容：到点后要做什么、要说什么。写清楚，到点后你只看得到这一段。' },
          wait_minutes: { type: 'integer', minimum: 1, maximum: 10080, description: '等待间隔（分钟），从提交时刻算起，默认 30。' },
          repeat_minutes: { type: 'integer', minimum: 0, maximum: 10080, description: '重复间隔（分钟）；0 或不填 = 只激活一次。' },
          to: { type: 'string', description: '目标聊天 key / 标题 / 会话 id；不填=当前会话绑定的聊天。' },
        },
        required: ['text'],
      },
      (args, exec) => {
        // 这个会话是不是绑着聊天，决定「给自己定」有没有明确的主体。
        // 没绑又不指定 to 时不猜「那一台机器人」：定时任务最后是在某个聊天里开口的。
        const sessionId = sessionIdOf(exec?.agent?.session) || ''
        const own = (bridge.listConversations?.() ?? []).find((row) => row.sessionId === sessionId) ?? null
        if (!own && !String(args.to ?? '').trim()) {
          throw new Error('这个会话没有绑定聊天。想给它定时，请用 to 指定一个聊天。')
        }
        return schedule.create({
          record: findConversation(bridge, exec, args.to),
          text: String(args.text ?? ''),
          waitMinutes: args.wait_minutes,
          repeatMinutes: args.repeat_minutes,
        })
      },
    ))

    add(tool(
      'companion_schedule_list',
      '看这台机器人已有的定时激活记录：任务内容、提交时间、等待间隔、下次激活时间和状态。回答「你给我定了什么」之前先用它。',
      { type: 'object', additionalProperties: false, properties: {} },
      (_args, exec) => {
        const botId = botIdForExec(bridge, exec)
        if (!botId) return { botId: '', jobs: [], pending: 0, text: '这个会话没有绑定机器人，定时激活只属于机器人。' }
        const result = schedule.status(botId)
        return {
          botId,
          jobs: result.jobs,
          pending: result.pending,
          text: result.jobs.length
            ? result.jobs.map((job) => `#${job.id} ${job.statusText}｜${job.submittedAt} 提交，等 ${job.waitMinutes} 分钟`
              + `${job.repeatMinutes ? `、每 ${job.repeatMinutes} 分钟重复` : ''}｜${job.text}`).join('\n')
            : '还没有定时任务。',
        }
      },
    ))

    add(tool(
      'companion_schedule_cancel',
      '取消一条还没激活的定时任务。取消后记录仍留在页面上（状态变成「已取消」），不是删除。',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '任务 id（形如 sch_xxx），用 companion_schedule_list 查。' },
        },
        required: ['id'],
      },
      (args, exec) => {
        const botId = botIdForExec(bridge, exec)
        if (!botId) throw new Error('这个会话不属于任何机器人，不能取消定时任务。')
        return schedule.cancel(botId, String(args.id ?? ''))
      },
    ))
  }

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* ignore */ }
    }
  }, 'companion: tools')
}
