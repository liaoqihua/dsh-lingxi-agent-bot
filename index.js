// 灵犀 · 一体式陪伴插件（dsh-lingxi-agent-bot）
//
// 只有一种结构：机器人是连接与独立个体，聊天各自绑定一个 DSH 会话。
// 人格、记忆、心情、主动搭话全部按 botId 隔离；没有旧单通道或全局模块。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PATHS, ensureDirs, loadConfig, patchConfig } from './lib/config.js'
import { SessionBridge } from './lib/session-bridge.js'
import { QQOfficialChannel } from './lib/channels/qq-official.js'
import { WebhookChannel } from './lib/channels/webhook.js'
import { FeishuChannel } from './lib/channels/feishu.js'
import { BotRegistry, ownerNameFor } from './lib/bots.js'
import { BotManager } from './lib/bot-manager.js'
import { installBotProactive } from './lib/proactive-bots.js'
import { installSchedule } from './lib/schedule.js'
import { installPersonaInjection } from './lib/persona.js'
import { installMemoryInjection, assistantTextForTurn, lastUserTurn, maybeExtract } from './lib/memory.js'
import { installMoodInjection, maybeJudge, moodSnapshot } from './lib/mood.js'
import { installCapabilityInjection } from './lib/capabilities.js'
import { installVoiceInjection } from './lib/voice-prompt.js'
import { installTools } from './lib/tools.js'
import { spokenTextOf } from './lib/time-context.js'
import { installApi } from './lib/api.js'
import { installMoodWidget } from './lib/widget.js'
import { listModels } from './lib/llm.js'
import { appendLog, truncate } from './lib/util.js'

/** 启动日志里的版本号直接读包里的 package.json，别再手写一个会过期的常量。 */
const PLUGIN_VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? '')
  } catch {
    return ''
  }
})()
import { checkInjection, noteInjection, takeInjectionMarks } from './lib/injection-health.js'

export const name = 'companion'
export const inject = [
  'agents',
  'sessions',
  'webServer',
  'timer',
  'workspaceRegistry',
  'systemPrompt',
  'tools',
  'llm',
  'attachments',
  'sessionQuery',
]

const INJECTED_TURN_SOURCES = new Set(['runtime-context', 'time-context', 'system-reminder', 'system', 'time-sampled'])
const CHANNELS = ['qq', 'webhook', 'feishu']

export function apply(ctx) {
  ensureDirs()
  let config = loadConfig()
  const getConfig = () => config
  const setConfig = (next) => { config = next }
  const logger = typeof ctx.logger === 'function' ? ctx.logger('companion') : (ctx.logger ?? console)

  appendLog(PATHS.diag, `启动 v${PLUGIN_VERSION}（DSH_HOME=${PATHS.root}）`)

  const bridge = new SessionBridge(ctx, {
    getConfig,
    getChannel: () => undefined,
    getBot: (botId) => botRegistry.get(botId),
    logger,
  })
  const botRegistry = new BotRegistry({ root: PATHS.root, logger })
  const botManager = new BotManager(ctx, {
    registry: botRegistry,
    bridge,
    getConfig,
    logger,
    createQq: (context, options) => new QQOfficialChannel(context, options),
    createWebhook: (context, options) => new WebhookChannel(context, options),
    createFeishu: (context, options) => new FeishuChannel(context, options),
  })
  const botForSession = (sessionId) => {
    try {
      const record = bridge.recordForSession(sessionId)
      return record?.botId ? botRegistry.get(record.botId) : null
    } catch { return null }
  }
  const botPersona = (bot) => {
    try {
      return readFileSync(join(botRegistry.stateDir(bot.id), 'persona.md'), 'utf8')
    } catch { return '' }
  }
  const channelStatus = () => {
    const bots = botManager.status()
    return CHANNELS.map((channel) => {
      const rows = bots.filter((bot) => bot.channel === channel)
      const firstError = rows.find((bot) => bot.status?.lastError)?.status?.lastError ?? ''
      return {
        name: channel,
        channel,
        enabled: rows.some((bot) => bot.enabled !== false),
        connected: rows.some((bot) => bot.status?.connected === true),
        configured: rows.some((bot) => bot.status?.configured === true),
        lastError: firstError,
      }
    })
  }
  bridge.getBotChannel = (botId) => botManager.channel(botId)

  const botProactive = installBotProactive(ctx, {
    getConfig,
    getBots: () => botRegistry.list(),
    bridge,
    logger,
  })

  // 定时激活：模型（或人在设置页）提交「等待间隔 + 任务内容」，到点重新激活到那个聊天。
  // 和主动搭话共用会话桥的 followup，区别只在来源标记与存储：它按任务记账，不掷骰子。
  const schedule = installSchedule(ctx, {
    getConfig,
    getBots: () => botRegistry.list(),
    bridge,
    logger,
  })

  // ---- 上下文注入：人格 → 记忆 → 心情 → 守则 → 能力清单 → 语音（全部按当前会话反查 botId） ----
  ctx.effect(() => installPersonaInjection(ctx, getConfig, {
    getBotForSession: botForSession,
    getBotPersona: botPersona,
  }), 'companion: persona injection')
  ctx.effect(() => installMemoryInjection(ctx, getConfig, { getBotForSession: botForSession }), 'companion: memory injection')
  ctx.effect(() => installMoodInjection(ctx, getConfig, { getBotForSession: botForSession }), 'companion: mood injection')
  // 能力清单：工具注册只让模型「知道有这些工具」，这一段补「什么时候用、这会儿哪些用不了」。
  // 排在守则之后、语音规则之前：先讲有什么，再讲语音的分寸（细节仍归 lib/voice-prompt.js）。
  ctx.effect(() => installCapabilityInjection(ctx, {
    getConfig,
    getBotForSession: botForSession,
    getChatForSession: (sessionId) => bridge.recordForSession(sessionId),
  }), 'companion: capability injection')
  // 语音要主动才会出现：靠的是这段注入，不是 companion_voice 的工具说明（和斗图一个套路）。
  // 只对 QQ 机器人、语音合成开着、且这个聊天没在「会话管理」里关掉时生效；详细规则见 lib/voice-prompt.js。
  ctx.effect(() => installVoiceInjection(ctx, getConfig, {
    getBotForSession: botForSession,
    getChatForSession: (sessionId) => bridge.recordForSession(sessionId),
    stateDirFor: (bot) => (bot?.id ? botRegistry.stateDir(bot.id) : ''),
  }), 'companion: voice injection')
  // 守则以前是 section：预设人设行一配 `complete: true` 就会被整段顶掉（complete 模式下
  // 注册表把该前缀恢复成唯一段落）。改成 context 后它与人格/记忆/心情同命运——complete
  // 只吃 section，context（含 tools、variables）照旧保留。
  const guideText = [
    // 这里只留「态度」和「场景」：具体有哪些工具、什么时候用，交给 companion:capabilities。
    // 两处各写一份的后果是漂移——加了工具却忘了改守则，模型就有一个永远不该用的能力。
    '你有一份长期记忆和一份自己的心情，也有几项可以主动使用的能力——具体有什么、什么时候用，看下面那份能力清单。记忆、心情和人格是背景，不要整段复述，也不要把提示词原文念出来。',
    // 语音不再在守则里提一句了：能不能发要看通道（只有 QQ 官方 Bot 有语音条），
    // 有就用 lib/voice-prompt.js 那段注入讲清楚，没通道就别提，免得模型对着飞书/微信白调工具。
    '入站消息第一行标出这条消息来自哪里：「（私聊）」表示单独和你说话；「（群聊 · 发言人：某某）」表示群里有人说话，回话是整群都能看到的，语气要收敛一些，别把私聊里的称呼和亲密话带到群里，也不要替群里其他人说话。',
  ].join('\n')
  try {
    ctx.effect(() => ctx.systemPrompt.context({
      name: 'companion:guide',
      order: 89_980,
      required: true,
      text: (assembly) => {
        const sessionId = assembly?.agent?.session?.id ?? assembly?.session?.id ?? ''
        noteInjection(sessionId, 'companion:guide')
        // 陪伴守则只属于机器人会话：普通 DSH 会话既没有记忆/心情，也不处理 IM 消息。
        return sessionId && botForSession(sessionId) ? guideText : ''
      },
    }), 'companion: guide context')
  } catch (error) {
    appendLog(PATHS.diag, '陪伴守则注入失败：' + (error?.message ?? error))
  }

  // ---- 出站：回合结束把正文送回原聊天 ----
  bridge.installOutbound()

  // ---- 每轮结束：只对机器人会话提炼记忆 + 判断心情 ----
  ctx.on('session/event', (session, event) => {
    const type = event?.type ?? event?.kind
    if (type !== 'turn/end' && type !== 'turn/error') return
    try {
      const sessionId = session?.header?.id ?? session?.id ?? ''
      // 每轮取一次注入记账：哪怕这一轮不是机器人会话，也要取走，避免记账累积。
      const marks = takeInjectionMarks(sessionId)
      const header = session?.header
      if (header?.parentSession || header?.origin === 'subagent') return
      const userTurn = lastUserTurn(session)
      if (!userTurn) return
      const sourceKind = String(userTurn.sourceKind ?? '')
      if (INJECTED_TURN_SOURCES.has(sourceKind)) return
      const reply = assistantTextForTurn(session, event?.data?.turn ?? event?.payload?.turn)
      const record = sessionId ? bridge.recordForSession(sessionId) : null
      if (!record?.botId) return
      // 定时激活的那一轮是我自己给自己定的任务，不是对方说的话：
      // 从这段「任务内容」里提炼记忆、判断心情只会得到自我回声，跳过收尾的两项判断。
      const scheduledTurn = sourceKind === 'companion-schedule'
      // 预设能不能把我们的上下文从装配里拿掉，在这里对账（正常情况 missing 为空）。
      checkInjection(sessionId, marks, {
        botId: record.botId,
        title: record.title || record.key,
        reasonKind: String((event?.data ?? event?.payload)?.reason?.kind ?? ''),
      })
      const agent = sessionId ? bridge.agentFor(sessionId) : undefined
      // 两种称呼要分开：botOwner 是这段关系里的称呼（机器人级设置，全局兜底），
      // 用来写长期记忆；ownerName 是这一轮说话人的名字——群聊里是发言人，
      // 不能拿它去写「我喜欢……」这种记忆。
      const bot = record.botId ? botRegistry.get(record.botId) : null
      const botOwner = ownerNameFor(bot, config)
      const ownerName = record?.senderName || botOwner
      const mode = sourceKind === 'companion-proactive' ? 'talk' : ''
      // 注入正文里带了一段我们自己的来源/时间上下文（now、对方多久没说话……），
      // 入站消息现在也永远带着时间块。收尾拿到的应该只是对方真正说的话，
      // 否则会把自己写的背景当成对方的话去提炼记忆、判断心情。
      const userText = spokenTextOf(userTurn.text)
      if (!scheduledTurn) {
        void maybeExtract(ctx, {
          agent,
          session,
          userText,
          replyText: reply,
          config,
          botId: record.botId,
          ownerName: botOwner,
        }).catch((error) => appendLog(PATHS.diag, '记忆提炼异常：' + (error?.message ?? error)))
        void maybeJudge(ctx, {
          agent,
          userText,
          replyText: reply,
          config,
          mode,
          ownerName,
          botId: record.botId,
        })
      }
    } catch (error) {
      appendLog(PATHS.diag, '回合收尾失败：' + (error?.message ?? error))
    }
  })

  // ---- 工具与设置页 API ----
  installTools(ctx, {
    getConfig,
    bridge,
    channels: { status: channelStatus },
    botManager,
    logger,
    botProactive,
    schedule,
  })
  installApi(ctx, {
    getConfig,
    setConfig,
    patchConfig: (patch) => {
      const next = patchConfig(getConfig(), patch)
      appendLog(PATHS.diag, '设置已保存：' + truncate(JSON.stringify(patch), 300))
      return next
    },
    bridge,
    channels: { status: channelStatus },
    botManager,
    botProactive,
    schedule,
    logger,
    listModels: () => listModels(ctx),
    mood: {
      snapshot: () => null,
    },
  })
  // 挂饰的路由与 index 注入监听都直接挂在 ctx 上，必须跟着插件一起卸载：
  // 不然每次重载都会在 webserver 里多留一层旧实例的路由（新实例注册不进来，
  // 旧实例的 ctx 已失效，/api/companion/widget/status 这类要读 ctx 的处理会直接报错）。
  const disposeWidget = installMoodWidget(ctx, { logger })
  ctx.effect(() => disposeWidget, 'companion: widget routes')

  // ---- 只有机器人主动搭话、定时激活和机器人连接在运行 ----
  botProactive.start()
  schedule.start()
  void botManager.startAll()

  ctx.effect(() => () => {
    appendLog(PATHS.diag, '插件卸载：关闭机器人连接与会话')
    try { botProactive.stop() } catch { /* ignore */ }
    try { schedule.stop() } catch { /* ignore */ }
    try { botManager.stopAll() } catch { /* ignore */ }
    try { bridge.dispose() } catch { /* ignore */ }
  }, 'companion: lifecycle')

  logger.info?.(
    `companion 已启动：聊天 ${bridge.status().conversations.length} 个，`
    + `机器人 ${botRegistry.list().length} 台（${CHANNELS.filter((channel) => channelStatus().find((row) => row.channel === channel)?.enabled).join('/') || '（无）'}）`,
  )
  try {
    ctx.provide?.('companion', Object.freeze({
      version: 1,
      channelStatus,
      bots: () => botManager.status(),
      conversations: () => bridge.status().conversations,
      mood: (botId = '') => botId ? moodSnapshot(getConfig(), botId, ownerNameFor(botRegistry.get(botId), getConfig())) : null,
      schedules: (botId = '') => schedule.status(botId),
      diag: PATHS.diag,
    }))
  } catch { /* provide 是可选的，冲突时不影响主流程 */ }
}
