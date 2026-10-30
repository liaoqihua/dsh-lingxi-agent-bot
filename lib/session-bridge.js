// 灵犀 · 会话桥：IM 聊天 ↔ DSH 会话
//
// 一个聊天（QQ / 微信 / 飞书）绑定一个 DSH 会话：
// QQ 官方 Bot 也走这里：一个 QQ 私聊/群绑定一个 DSH 会话。
//   · 入站：拼一条 source.kind = companion-im 的 user 消息，走 agent.followup；
//   · 出站：监听 session/event 的 turn/end，把这一轮助手正文交给对应通道发出去；
//   · 主动搭话也走同一个 followup，因此回复会自然回到原聊天。
import { PATHS } from './config.js'
import { BOT_DEFAULT_PERMISSION, SCOPE_LABEL, sessionDefaultsFor } from './bots.js'
import { listModels, resolveModel } from './llm.js'
import { renderMemeMarkers, recordMemeConversion } from './meme.js'
import { nowLines, proactiveBody } from './time-context.js'
import {
  appendLog, contentText, derivedSessionId, readJsonSafe, sessionIdCandidates, sessionIdOf, shortId, text as asText, writeJsonAtomic,
} from './util.js'

const VERSION = 1
const DEDUPE_LIMIT = 400

const CHANNEL_LABEL = {
  qq: 'QQ',
  feishu: '飞书',
  webhook: '微信',
}

/** 标记「不许再往下兜底」的错误：工作区挂接失败时必须整体失败，不能换条路继续。 */
function fatal(message) {
  const error = new Error(message)
  error.fatal = true
  return error
}

function blankDb() {
  return { version: VERSION, records: {} }
}

/**
 * 会话级主动搭话开关。没有记录过（含旧数据）时按 scope 默认：
 * 私聊开、群聊关。冷却不在这里——它只属于「主动搭话」页的机器人级节奏参数。
 */
function normalizeProactive(raw, scope) {
  const row = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: row.enabled === undefined ? scope !== 'group' : row.enabled === true,
    lastSpokeAt: Number(row.lastSpokeAt) || 0,
  }
}

/**
 * 会话级主动语音开关（只对 QQ 官方 Bot 的聊天有意义）。
 * 默认同主动搭话：私聊开、群聊关——群里突然冒出一条语音比多一行文字打扰得多，
 * 想开就按会话单独开。总闸在设置页「语音」的 promptEnabled，这里只管单个聊天。
 */
function normalizeVoicePrompt(raw, scope) {
  const row = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: row.enabled === undefined ? scope !== 'group' : row.enabled === true,
  }
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object' || !raw.key) return null
  const scope = asText(raw.scope, 'c2c')
  return {
    key: String(raw.key),
    channel: asText(raw.channel, 'unknown'),
    botId: asText(raw.botId, ''),
    scope,
    peerId: String(raw.peerId ?? ''),
    title: asText(raw.title, ''),
    // 手动重命名过就锁住，不再被入站时的自动标题覆盖。
    renamed: raw.renamed === true,
    senderName: asText(raw.senderName, ''),
    sessionId: String(raw.sessionId ?? ''),
    target: raw.target && typeof raw.target === 'object' ? raw.target : {},
    proactive: normalizeProactive(raw.proactive, scope),
    voicePrompt: normalizeVoicePrompt(raw.voicePrompt, scope),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    lastHumanAt: Number(raw.lastHumanAt) || 0,
    lastAssistantAt: Number(raw.lastAssistantAt) || 0,
    lastProactiveAt: Number(raw.lastProactiveAt) || 0,
    messageCount: Math.max(0, Math.round(Number(raw.messageCount) || 0)),
  }
}

export function conversationKey({ channel, scope, peerId, botId }) {
  const base = `${channel}:${scope}:${String(peerId)}`
  return botId ? `${botId}:${base}` : base
}

export function conversationTitle({ channel, scope, peerId, senderName, botName }) {
  const label = CHANNEL_LABEL[channel] ?? channel
  const prefix = botName ? `${botName} · ` : ''
  if (scope === 'group') return `${prefix}${label}群 ${peerId}`
  return `${prefix}${label} ${senderName || peerId}`
}

function sessionTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export class SessionBridge {
  constructor(ctx, { getConfig, getChannel, getBot, getBotChannel, logger } = {}) {
    this.ctx = ctx
    this.getConfig = getConfig
    this.getChannel = getChannel
    this.getBot = getBot
    this.getBotChannel = getBotChannel
    this.logger = logger
    this.db = this.#load()
    this.handles = new Map()
    this.ensuring = new Map()
    this.turnBuffers = new Map()
    this.pendingMessages = new Map()
    this.seenMessageIds = new Set()
    this.disposed = false
  }

  #load() {
    const raw = readJsonSafe(PATHS.sessions, null)
    const db = blankDb()
    if (raw && typeof raw === 'object' && raw.records && typeof raw.records === 'object') {
      for (const [key, value] of Object.entries(raw.records)) {
        const record = normalizeRecord({ ...value, key })
        if (!record) continue
        db.records[key] = record
      }
    }
    return db
  }

  save() {
    writeJsonAtomic(PATHS.sessions, this.db)
  }

  dedupe(messageId) {
    const id = String(messageId ?? '').trim()
    if (!id) return false
    if (this.seenMessageIds.has(id)) return true
    this.seenMessageIds.add(id)
    if (this.seenMessageIds.size > DEDUPE_LIMIT) {
      const first = this.seenMessageIds.values().next().value
      if (first) this.seenMessageIds.delete(first)
    }
    return false
  }

  listConversations() {
    return Object.values(this.db.records)
      .map((record) => ({
        ...record,
        proactive: { ...record.proactive },
        voicePrompt: { ...record.voicePrompt },
        live: Boolean(this.agentFor(record.sessionId)),
      }))
      .sort((a, b) => (b.lastHumanAt || b.updatedAt) - (a.lastHumanAt || a.updatedAt))
  }

  recordForConversation(input) {
    const key = conversationKey(input)
    return this.db.records[key] ?? null
  }

  /**
   * 改一条会话记录：重命名 / 会话级主动搭话开关 / 会话级主动语音开关 / 上次开口时间。
   * 冷却不在这里：它只属于「主动搭话」页的机器人级节奏参数。
   * @param {string} key
   * @param {{title?: string, renamed?: boolean, proactive?: {enabled?: boolean, lastSpokeAt?: number}, voicePrompt?: {enabled?: boolean}}} patch
   */
  updateConversation(key, patch = {}) {
    const record = this.db.records[String(key ?? '')]
    if (!record) throw new Error('聊天不存在')
    if (patch.title !== undefined) {
      const title = asText(patch.title, '')
      if (!title) throw new Error('会话名不能为空')
      record.title = title.slice(0, 80)
      record.renamed = true
    }
    if (patch.renamed !== undefined) record.renamed = patch.renamed === true
    if (patch.proactive && typeof patch.proactive === 'object') {
      const next = patch.proactive
      if (next.enabled !== undefined) record.proactive.enabled = next.enabled === true
      if (next.lastSpokeAt !== undefined) record.proactive.lastSpokeAt = Number(next.lastSpokeAt) || 0
    }
    if (patch.voicePrompt && typeof patch.voicePrompt === 'object') {
      if (patch.voicePrompt.enabled !== undefined) record.voicePrompt.enabled = patch.voicePrompt.enabled === true
    }
    record.updatedAt = Date.now()
    this.save()
    return { ...record, proactive: { ...record.proactive }, voicePrompt: { ...record.voicePrompt } }
  }

  recordForSession(sessionId) {
    const ids = sessionIdCandidates(sessionId)
    if (!ids.length) return null
    for (const record of Object.values(this.db.records)) {
      if (ids.includes(record.sessionId)) return record
    }
    return null
  }

  #workspaces() {
    try { return this.ctx.workspaceRegistry?.list?.() ?? [] } catch { return [] }
  }

  #workspaceOwners(sessionId) {
    return this.#workspaces().filter((workspace) => (
      Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(sessionId)
    ))
  }

  async #workspaceAt(path, { create = false } = {}) {
    const registry = this.ctx.workspaceRegistry
    const cwd = asText(path, '')
    if (!registry || !cwd) return null
    let workspace = null
    if (typeof registry.resolveByPath === 'function') workspace = await registry.resolveByPath(cwd)
    else workspace = this.#workspaces().find((row) => row?.path === cwd) ?? null
    if (!workspace && create && typeof registry.create === 'function') workspace = await registry.create(cwd)
    return workspace ?? null
  }

  async #sessionHeader(sessionId) {
    try {
      const live = this.ctx.sessions?.get?.(sessionId) ?? this.agentFor(sessionId)?.session
      if (live?.header) return live.header
    } catch { /* 继续查持久化记录 */ }
    try {
      const rows = await this.ctx.sessionQuery?.listSessions?.() ?? []
      return rows.find((row) => String(row?.header?.id ?? row?.id ?? row?.sessionId ?? '') === sessionId)?.header ?? null
    } catch { return null }
  }

  async #attachWorkspace(workspace, sessionId) {
    if (!workspace) return null
    const before = this.#workspaceOwners(sessionId)
    if (before.length > 1 || before.some((row) => row.id !== workspace.id)) {
      throw new Error(`会话 ${sessionId} 已经属于其他工作区`)
    }
    await workspace.attachSession(sessionId)
    const after = this.#workspaceOwners(sessionId)
    if (after.length !== 1 || after[0].id !== workspace.id) {
      throw new Error(`会话 ${sessionId} 的工作区归属校验失败`)
    }
    return workspace
  }

  async #attachActualWorkspace(agent) {
    const sessionId = String(agent?.session?.id ?? agent?.id ?? '')
    if (!sessionId) return null
    const owners = this.#workspaceOwners(sessionId)
    if (owners.length > 1) throw new Error(`会话 ${sessionId} 同时属于多个工作区`)
    if (owners.length === 1) return owners[0]
    const cwd = agent?.session?.header?.cwd
    if (!cwd) return null
    const workspace = await this.#workspaceAt(cwd)
    return workspace ? this.#attachWorkspace(workspace, sessionId) : null
  }

  /** 手动绑定前校验并挂接：会话唯一、机器人工作区一致、Workspace 归属唯一。 */
  async validateBotSession(bot, sessionId, { chatKey = '', scope = 'c2c' } = {}) {
    const sid = String(sessionId ?? '').trim()
    if (!sid) throw new Error('缺少会话 id')
    const owner = this.recordForSession(sid)
    if (owner && (!chatKey || owner.key !== chatKey)) throw new Error('这个会话已经绑在另一个聊天上了')
    const scopeKey = scope === 'group' ? 'group' : 'c2c'
    const workspacePath = sessionDefaultsFor(bot, scopeKey).workspace
    if (!workspacePath) throw new Error(`机器人没有配置${SCOPE_LABEL[scopeKey]}会话的工作区`)
    const header = await this.#sessionHeader(sid)
    if (!header) throw new Error('这个会话不存在或不可读')
    if (header.origin === 'subagent' || header.parentSession) throw new Error('不能把子代理会话绑定为机器人聊天')
    const workspace = await this.#workspaceAt(workspacePath, { create: true })
    if (!workspace) throw new Error(`工作区不可用：${workspacePath}`)
    const owners = this.#workspaceOwners(sid)
    if (owners.length > 1 || owners.some((row) => row.id !== workspace.id)) {
      throw new Error('这个会话已经属于另一个工作区')
    }
    if (!owners.length) {
      if (!header.cwd) throw new Error('这个会话没有工作目录，不能按工作区绑定')
      const actual = await this.#workspaceAt(header.cwd)
      if (actual?.id !== workspace.id) throw new Error('这个会话不在机器人的工作区里')
    }
    await this.#attachWorkspace(workspace, sid)
    return { sessionId: sid, workspace, header }
  }

  /** 把一个聊天绑到已有会话；空 sessionId 表示下次消息自动新建。 */
  async bindSession(key, sessionId) {
    const record = this.db.records[String(key ?? '')]
    if (!record) throw new Error('聊天不存在')
    const sid = String(sessionId ?? '').trim()
    if (sid) {
      const bot = record.botId ? this.getBot?.(record.botId) : null
      if (bot) await this.validateBotSession(bot, sid, { chatKey: record.key, scope: record.scope })
      else {
        const owner = this.recordForSession(sid)
        if (owner && owner.key !== record.key) throw new Error('这个会话已经绑在另一个聊天上了')
        const header = await this.#sessionHeader(sid)
        if (!header) throw new Error('这个会话不存在或不可读')
        if (header.origin === 'subagent' || header.parentSession) throw new Error('不能把子代理会话绑定为机器人聊天')
        const workspace = header.cwd ? await this.#workspaceAt(header.cwd) : null
        if (workspace) await this.#attachWorkspace(workspace, sid)
      }
    }
    const next = sid || derivedSessionId(`companion:${record.key}:auto:${Date.now()}`)
    const previous = record.sessionId
    if (previous && previous !== next) {
      try { this.handles.get(previous)?.dispose?.() } catch { /* ignore */ }
      this.handles.delete(previous)
    }
    record.sessionId = next
    record.updatedAt = Date.now()
    this.save()
    appendLog(PATHS.diag, `聊天绑定会话：${record.title || record.key} → ${shortId(next)}`)
    return record
  }

  /** 内存里活着的 agent；两种 id 写法都认。 */
  agentFor(sessionId) {
    for (const candidate of sessionIdCandidates(sessionId)) {
      const agent = this.ctx.agents.get(candidate)
      if (agent) return agent
    }
    return undefined
  }

  /**
   * 机器人级称呼改过之后，已有 QQ 私聊的标签要立刻跟着变。
   *
   * 入站时 touchConversation 才会刷新标题，改完设置如果不动这里，「QQ 主人」会一直
   * 挂着到对方下一条消息为止。只碰 QQ 的 c2c：群聊用真实发言人昵称，微信/飞书的
   * senderName 来自桥接侧，都不能用这个设置覆盖。
   */
  relabelOwnerName(botId, ownerName) {
    const name = asText(ownerName, '')
    if (!botId || !name) return 0
    let changed = 0
    for (const record of Object.values(this.db.records ?? {})) {
      if (!record || record.botId !== botId) continue
      if (record.channel !== 'qq' || record.scope !== 'c2c' || record.renamed) continue
      record.senderName = name
      record.title = conversationTitle({ channel: 'qq', scope: 'c2c', peerId: record.peerId, senderName: name })
      changed += 1
    }
    if (changed) this.save()
    return changed
  }

  /** 入站消息先登记聊天；返回记录（不触发会话）。 */
  touchConversation({ channel, botId = '', botName = '', scope, peerId, senderName, title, target, sessionId }) {
    const key = conversationKey({ channel, scope, peerId, botId })
    const now = Date.now()
    let record = this.db.records[key]
    if (!record) {
      record = normalizeRecord({
        key, channel, botId, scope, peerId,
        title: title || conversationTitle({ channel, scope, peerId, senderName, botName }),
        senderName: senderName || '',
        sessionId: sessionId || derivedSessionId(`companion:${key}`),
        target: target || {},
        createdAt: now, updatedAt: now,
      })
      this.db.records[key] = record
      appendLog(PATHS.diag, `登记新聊天：${record.title}（${key}，主动搭话${record.proactive.enabled ? '开' : '关'}，主动语音${record.voicePrompt.enabled ? '开' : '关'}）`)
    } else {
      if (senderName) record.senderName = senderName
      // 手动重命名过的会话不再被入站标题覆盖。
      if (title && !record.renamed) record.title = title
      if (target) record.target = { ...record.target, ...target }
      if (sessionId) record.sessionId = sessionId
      record.updatedAt = now
    }
    this.save()
    return record
  }

  /** 新建会话时顺手起个名字，侧边栏里一眼能认出来。 */
  #labelSession(agent, record) {
    try {
      const service = this.ctx.get?.('sessionTitle')
      if (!service?.rename || !agent?.session) return
      const config = this.getConfig()
      const prefix = asText(config.sessions.titlePrefix, '') || '伴侣'
      const bot = record?.botId ? this.getBot?.(record.botId) : null
      const botName = asText(bot?.name, '') || asText(record.title, '') || asText(record.key, '')
      const title = `${prefix}·${botName}-${sessionTimestamp()}`
      service.rename(agent.session, title.slice(0, 80))
    } catch { /* 起名失败不影响会话 */ }
  }

  /**
   * get → resume → create；并发只跑一次。
   * 配置只有唯一来源：bot.sessionDefaults[record.scope]，没有兜底链。
   * 配置缺失或创建失败一律抛带原因的错，让入站管线把原因回给聊天。
   */
  ensureAgent(record) {
    if (!record?.sessionId) return Promise.resolve(undefined)
    const sessionId = record.sessionId
    const live = this.agentFor(sessionId)
    if (live) {
      return (async () => {
        try {
          await this.#attachActualWorkspace(live)
          return live
        } catch (error) {
          appendLog(PATHS.diag, `会话工作区挂接失败（${record.key}）：${error?.message ?? error}`)
          throw fatal(`这个会话的工作区挂接失败：${error?.message ?? error}`)
        }
      })()
    }
    const existing = this.ensuring.get(sessionId)
    if (existing) return existing
    const task = (async () => {
      const config = this.getConfig()
      if (!config.sessions.autoCreate) return undefined
      const bot = record.botId ? this.getBot?.(record.botId) : null
      const scope = record.scope === 'group' ? 'group' : 'c2c'
      const defaults = sessionDefaultsFor(bot, scope)
      const preset = defaults.preset
      // provider/model：宿主的 {{model}} 提示词变量取自 agent.options.model，
      // 恢复出来的 agent 若没有它，部署级 persona 模板会在渲染时直接抛错、整轮失败。
      // 所以恢复与新建都先算好这一份。
      const fallbackModel = resolveModel(this.ctx)
      let provider = defaults.provider || asText(fallbackModel?.provider, '')
      let model = defaults.model || asText(fallbackModel?.model, '')
      if (!provider || !model) {
        try {
          const catalog = await listModels(this.ctx)
          const first = catalog.find((row) => Array.isArray(row.models) && row.models.length > 0)
          if (first) {
            provider = provider || first.id
            model = model || first.models[0].id
          }
        } catch { /* 拿不到目录就按空模型走，让宿主自己报错 */ }
      }
      const agentOptions = {}
      if (provider && model) {
        agentOptions.provider = provider
        agentOptions.model = model
      }
      const hasAgentOptions = Object.keys(agentOptions).length > 0
      try {
        const liveGlobal = this.ctx.agents.get?.(sessionId)
        if (liveGlobal) {
          await this.#attachActualWorkspace(liveGlobal)
          return liveGlobal
        }
      } catch (error) {
        appendLog(PATHS.diag, `现存会话工作区挂接失败（${record.key}）：${error?.message ?? error}`)
        throw fatal(`这个会话的工作区挂接失败：${error?.message ?? error}`)
      }
      try {
        const handle = await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          ...(hasAgentOptions ? { agentOptions } : {}),
        })
        try {
          await this.#attachActualWorkspace(handle.agent)
        } catch (error) {
          try { await handle.dispose?.() } catch { /* ignore */ }
          appendLog(PATHS.diag, `恢复会话工作区挂接失败（${record.key}）：${error?.message ?? error}`)
          throw fatal(`恢复会话的工作区挂接失败：${error?.message ?? error}`)
        }
        this.handles.set(sessionId, handle)
        appendLog(PATHS.diag, `恢复会话 ${shortId(sessionId)}（${record.key}）`)
        return handle.agent
      } catch (error) {
        if (error?.fatal) throw error
        /* resume 失败 → create */
      }
      // ── 只有走到这里才真的要新建会话：此刻才要求新会话默认配置齐全 ──
      // 已经存在的会话用自己 header 里的 cwd，不需要这份默认值，所以恢复路径不拦。
      const configuredCwd = defaults.workspace
      if (!configuredCwd) throw new Error(`机器人没有配置${SCOPE_LABEL[scope]}会话默认：workspace`)
      const defaultPermission = defaults.defaultPermission || BOT_DEFAULT_PERMISSION
      // 权限必须走宿主的权限预设：它会把 preset 行与 sandbox/approval 开关一起写好。
      // 只 append sandbox/mode 会让界面算不出匹配的预设组合，显示成 custom。
      const applyPermission = (agent) => {
        const session = agent?.session
        if (!session) return
        try {
          const service = this.ctx.get?.('permissionPresets') ?? this.ctx.permissionPresets
          if (service && typeof service.set === 'function') {
            service.set(session, defaultPermission)
            return
          }
        } catch (error) {
          appendLog(PATHS.diag, `权限预设写入失败，回退 sandbox/mode：${error?.message ?? error}`)
        }
        try {
          if (typeof session.append === 'function') session.append('sandbox/mode', { mode: defaultPermission })
        } catch (error) {
          appendLog(PATHS.diag, `新会话默认权限写入失败：${error?.message ?? error}`)
        }
      }
      // 机器人没指定预设时落到宿主登记的默认预设：否则会话没有 preset 行，
      // 界面显示「无预设」，行为也和宿主自己建出来的会话不一致。
      let effectivePreset = preset
      if (!effectivePreset) {
        try {
          const service = this.ctx.get?.('agentPresets') ?? this.ctx.agentPresets
          if (service && typeof service.resolve === 'function') {
            const resolved = await service.resolve()
            effectivePreset = asText(resolved?.id, '')
          }
        } catch { /* 拿不到默认预设就按无预设走 */ }
      }
      const make = async (dir) => {
        const meta = { cwd: dir }
        if (effectivePreset) meta.agentPreset = effectivePreset
        return this.ctx.agents.create({
          sessionId,
          meta,
          ...(hasAgentOptions ? { agentOptions } : {}),
        })
      }
      try {
        const workspace = await this.#workspaceAt(configuredCwd, { create: true })
        if (!workspace) throw new Error(`工作区不可用：${configuredCwd}`)
        const cwd = workspace.path || configuredCwd
        const handle = await make(cwd)
        try {
          await this.#attachWorkspace(workspace, sessionId)
        } catch (error) {
          this.handles.delete(sessionId)
          try { await handle.dispose?.() } catch { /* ignore */ }
          throw error
        }
        this.handles.set(sessionId, handle)
        applyPermission(handle.agent)
        this.#labelSession(handle.agent, record)
        appendLog(PATHS.diag, `新建会话 ${shortId(sessionId)}（${record.key}，cwd=${cwd}${workspace ? `，workspace=${workspace.id}` : ''}${effectivePreset ? `，preset=${effectivePreset}` : ''}${provider && model ? `，model=${provider}/${model}` : ''}，权限=${defaultPermission}）`)
        return handle.agent
      } catch (error) {
        appendLog(PATHS.diag, `会话创建/工作区挂接失败（${record.key}）：${error?.message ?? error}`)
        throw new Error(`新建会话失败：${error?.message ?? error}`)
      }
    })().finally(() => this.ensuring.delete(sessionId))
    this.ensuring.set(sessionId, task)
    return task
  }

  async #saveImage(bytes, mediaType, name) {
    try {
      const ref = await this.ctx.attachments.saveImage({ data: bytes, mediaType, name })
      return { type: 'image', attachment: ref }
    } catch (error) {
      appendLog(PATHS.diag, `图片附件保存失败：${error?.message ?? error}`)
      return null
    }
  }

  /**
   * 收到一条 IM 消息：登记 → 确保会话 → followup。
   * 会话配置缺失等「拉不起来」的原因会带在 notify 里，由通道回一句提示给聊天。
   * @returns { ok, sessionId?, error?, notify?, record? }
   */
  async deliverInbound({
    channel, botId = '', botName = '', scope = 'c2c', peerId, senderName = '', senderId = '', title = '',
    text = '', images = [], quote = '', target = {}, meta = {},
  }) {
    try {
      const body = String(text ?? '').trim()
      const hasImages = Array.isArray(images) && images.length > 0
      if (!body && !hasImages) return { ok: false, error: '空消息' }
      const sourceBot = botId ? this.getBot?.(botId) : null
      if (!sourceBot) return { ok: false, error: '这个消息没有所属机器人' }
      if (sourceBot && scope === 'group' && sourceBot.groupEnabled !== true) {
        return { ok: false, error: '这个机器人还没开启群聊' }
      }
      if (sourceBot?.access && sourceBot.access.mode !== 'all') {
        const list = scope === 'group' ? (sourceBot.access.groups ?? []) : (sourceBot.access.users ?? [])
        const identity = scope === 'group' ? String(peerId ?? '') : String(senderId || peerId || '')
        const hit = list.includes(identity)
        if ((sourceBot.access.mode === 'allow' && !hit) || (sourceBot.access.mode === 'block' && hit)) {
          return { ok: false, error: '这个发送者不在机器人的访问名单里' }
        }
      }
      const record = this.touchConversation({
        channel, botId, botName, scope, peerId, senderName, title, target,
      })
      record.lastHumanAt = Date.now()
      record.messageCount += 1
      record.updatedAt = record.lastHumanAt
      if (senderName) record.senderName = senderName
      this.save()

      let agent = null
      try {
        agent = await this.ensureAgent(record)
      } catch (error) {
        const reason = String(error?.message ?? error)
        appendLog(PATHS.diag, `入站会话拉起失败（${record.key}）：${reason}`)
        return { ok: false, error: reason, notify: `我收到你的消息了，但这个聊天还没配置好：${reason}`, record }
      }
      if (!agent) return { ok: false, error: '会话拉不起来', record }

      const content = []
      const lines = []
      // 来源块：时间永远在，渠道/发送者/会话/增强提示看「上下文增强」开关。
      // 时间不做成可选项——模型看不到时钟就会自己猜，把「今天」说成「明天」。
      const enhance = sourceBot?.contextEnhancement
      const metaLines = nowLines(Date.now())
      if (enhance?.enabled) {
        metaLines.push(`channel: ${channel}`, `scope: ${scope}`)
        if (enhance.includeSender && senderName) metaLines.push(`sender: ${senderName}`)
        if (enhance.includeChat) metaLines.push(`chat: ${peerId}`)
        if (enhance.guidance) metaLines.push(`guidance: ${enhance.guidance}`)
      }
      lines.push(`<companion_context>\n${metaLines.join('\n')}\n</companion_context>`)
      // 场景行：私聊与群聊都显式标记，不依赖上下文增强是否开启。
      lines.push(scope === 'group'
        ? `（群聊${senderName ? ` · 发言人：${senderName}` : ''}）`
        : '（私聊）')
      if (quote) lines.push(`（引用：${quote}）`)
      if (body) lines.push(body)
      if (lines.length) content.push({ type: 'text', text: lines.join('\n') })
      for (const image of images.slice(0, 6)) {
        let block = null
        if (image?.bytes) block = await this.#saveImage(image.bytes, image.mediaType, image.name)
        if (block) content.push(block)
        else if (image?.path) content.push({ type: 'text', text: `[收到一张图片，已保存到：${image.path}]` })
        // 存不下来也要留痕：什么都没加的话，模型只看到一条空消息，会当成对方没说话。
        else content.push({ type: 'text', text: '[收到一张图片，但没能读取]' })
      }
      if (!content.length) content.push({ type: 'text', text: '[收到一条无法显示的消息]' })

      const messageId = meta.messageId
      const message = {
        id: `${channel}-${String(messageId || Date.now())}`.slice(0, 120),
        role: 'user',
        content,
        source: {
          kind: 'companion-im',
          channel,
          conversation: record.key,
          senderName: senderName || '',
          senderId: String(senderId || ''),
        },
      }
      appendLog(PATHS.diag, `入站 → ${record.key}（session=${record.sessionId}）`)
      if (sourceBot?.busyMessageMode === 'queue' && typeof agent.status === 'string' && agent.status !== 'idle') {
        const queue = this.pendingMessages.get(record.sessionId) ?? []
        queue.push({ message, at: Date.now() })
        if (queue.length > 20) queue.shift()
        this.pendingMessages.set(record.sessionId, queue)
        appendLog(PATHS.diag, `会话正忙，消息已排队（${record.key}，${queue.length} 条）`)
        return { ok: true, queued: true, sessionId: record.sessionId, record }
      }
      await Promise.resolve(agent.followup(message))
      appendLog(PATHS.diag, `入站已投递：${record.key}`)
      try { await this.ctx.sessions?.flush?.(agent.session) } catch { /* ignore */ }
      return { ok: true, sessionId: record.sessionId, record }
    } catch (error) {
      appendLog(PATHS.diag, `入站失败（${channel}:${scope}:${peerId}）：${error?.message ?? error}`)
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  /**
   * 主动搭话：走同一条 followup，回复由出站桥送回原聊天。
   *
   * 注入正文必须自带时钟：这条消息是插件直接塞进来的，没有宿主准备的回合上下文，
   * 模型看不到「现在几点」，就会把「昨晚」「明天」算错（时间幻觉）。
   * 正文由 time-context.js 拼：now / 时段 / 对方多久没说话 / 我上次开口是什么时候。
   */
  async deliverProactive(record, agent, promptText, { now = Date.now() } = {}) {
    const message = {
      id: `companion-proactive-${now}`,
      role: 'user',
      content: [{ type: 'text', text: proactiveBody({ record, promptText, now }) }],
      source: { kind: 'companion-proactive', channel: record.channel, conversation: record.key },
    }
    await Promise.resolve(agent.followup(message))
    try { await this.ctx.sessions?.flush?.(agent.session) } catch { /* ignore */ }
    const canonical = this.db.records[record.key] ?? record
    const at = Date.now()
    canonical.lastProactiveAt = at
    canonical.updatedAt = at
    if (canonical.proactive) canonical.proactive.lastSpokeAt = at
    this.save()
    return canonical
  }

  /**
   * 定时激活：和入站、主动搭话同一条 followup，所以回复照常由出站桥送回原聊天。
   * 来源显式标成 companion-schedule：回合收尾据此把这一轮排除在记忆/心情判断之外
   * （那是我自己定的任务，不是对方说的话）。不动主动搭话的时间线——那是另一种语义。
   */
  async deliverActivation(record, agent, promptText, { jobId = '' } = {}) {
    const message = {
      id: `companion-schedule-${jobId || Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text: String(promptText) }],
      source: {
        kind: 'companion-schedule',
        channel: record.channel,
        conversation: record.key,
        jobId: String(jobId || ''),
      },
    }
    await Promise.resolve(agent.followup(message))
    try { await this.ctx.sessions?.flush?.(agent.session) } catch { /* ignore */ }
    const canonical = this.db.records[record.key] ?? record
    canonical.updatedAt = Date.now()
    this.save()
    return canonical
  }

  /** 只走当前机器人的连接；没有机器人就不允许发送。 */
  channelFor(record) {
    if (record?.botId && this.getBotChannel) {
      try {
        const botChannel = this.getBotChannel(record.botId)
        if (botChannel) return botChannel
      } catch { /* ignore */ }
    }
    return null
  }

  /** 删除机器人时清掉它的聊天绑定，释放会话，避免“幽灵占用”。 */
  removeConversation(key) {
    const record = this.db.records[String(key ?? '')]
    if (!record) return false
    try { this.handles.get(record.sessionId)?.dispose?.() } catch { /* ignore */ }
    this.handles.delete(record.sessionId)
    delete this.db.records[record.key]
    this.save()
    appendLog(PATHS.diag, `移除聊天绑定：${record.title || record.key}`)
    return true
  }

  /** 供其它模块手动发一条到指定聊天。 */
  async sendToConversation(record, payload) {
    const channel = this.channelFor(record)
    if (!channel) throw new Error(`通道 ${record.channel} 没启用`)
    return channel.send({ record, ...payload })
  }

  /** 监听 DSH 回合结束，把这一轮正文发出去。 */
  installOutbound() {
    this.ctx.on('session/event', (session, event) => {
      try { this.#onSessionEvent(session, event) } catch (error) {
        appendLog(PATHS.diag, '出站事件处理失败：' + (error?.message ?? error))
      }
    })

    // 兜底：万一某个回合没有 turn/end（旧宿主/异常中断），2 分钟后把攒下来的正文发掉。
    // 阈值拉长是为了避免工具调用中途停顿时把半截话先发出去。
    this.ctx.effect(() => this.ctx.interval(() => {
      const now = Date.now()
      for (const [sessionId, buffer] of this.turnBuffers) {
        if (buffer.text && now - buffer.updatedAt > 120_000) {
          this.turnBuffers.delete(sessionId)
          void this.#flush(sessionId, buffer)
        }
      }
    }, 15_000), 'companion: outbound flush sweep')
  }

  #onSessionEvent(session, event) {
    const type = event?.type ?? event?.kind
    const sessionId = sessionIdOf(session)
    if (!sessionId) return
    const record = this.recordForSession(sessionId)
    if (!record) return
    if (type === 'assistant/message') {
      const data = event.data ?? event.payload ?? {}
      const message = data.message ?? data
      const textValue = contentText(message?.content)
      if (!textValue) return
      let buffer = this.turnBuffers.get(sessionId)
      if (!buffer) {
        buffer = { text: '', sessionId, record, updatedAt: Date.now(), error: '' }
        this.turnBuffers.set(sessionId, buffer)
      }
      buffer.text = buffer.text ? `${buffer.text}\n\n${textValue}` : textValue
      buffer.updatedAt = Date.now()
      buffer.record = record
      return
    }
    if (type === 'turn/end' || type === 'turn/error') {
      const data = event.data ?? event.payload ?? {}
      const reason = data.reason ?? {}
      const error = reason.kind === 'error'
        ? (reason.error?.message || reason.failure?.message || reason.message || '未知错误')
        : ''
      let buffer = this.turnBuffers.get(sessionId)
      this.turnBuffers.delete(sessionId)
      if (!buffer) {
        buffer = { text: '', sessionId, record, updatedAt: Date.now(), error: '' }
      }
      buffer.error = error
      buffer.record = record
      if (error) appendLog(PATHS.diag, `回合失败（${record.title || record.key}）：${error}`)
      if (buffer.text || error) void this.#flush(sessionId, buffer)
      void this.#drainQueue(sessionId)
      return
    }
    if (type === 'session/disposed') {
      this.turnBuffers.delete(sessionId)
    }
  }

  #drainQueue(sessionId) {
    const queue = this.pendingMessages.get(sessionId)
    if (!queue?.length) return
    const agent = this.agentFor(sessionId)
    if (!agent) return
    const next = queue.shift()
    if (!queue.length) this.pendingMessages.delete(sessionId)
    else this.pendingMessages.set(sessionId, queue)
    Promise.resolve(agent.followup(next.message)).catch((error) => {
      appendLog(PATHS.diag, `排队消息投递失败：${error?.message ?? error}`)
    })
  }

  async #flush(sessionId, buffer) {
    const config = this.getConfig()
    const record = buffer.record ?? this.recordForSession(sessionId)
    if (!record) return
    const channel = this.channelFor(record)
    if (!channel) return
    let textValue = String(buffer.text ?? '').trim()
    if (!textValue && buffer.error) {
      if (!/abort|cancel|Cancelled/i.test(buffer.error)) {
        textValue = '刚才那一步出错了，我没能说完。你再叫我一声，我接着说。'
      } else {
        return
      }
    }
    if (!textValue) return
    // dsh-meme 在 Web 会话只让模型写 [表情: 描述]，IM 里那只是一行方括号文字。
    // 出站前换成 ![表情](绝对路径)，由通道按图片发出去（QQ 官方 Bot / 微信 iLink / 飞书都支持）。
    // 开关与张数上限在「设置 → 灵犀 → 斗图」里。
    const memeSettings = config.meme ?? {}
    const memes = memeSettings.enabled === false
      ? { text: textValue, images: [], captions: [], matched: 0, missed: [] }
      : renderMemeMarkers(textValue, { maxImages: memeSettings.maxImages })
    if (memes.matched || memes.missed.length) {
      textValue = memes.text
      recordMemeConversion(memes)
      if (memes.matched) {
        appendLog(PATHS.diag, `表情包 → 原生图片 ${memes.matched} 张（${record.key}）`)
      }
      if (!textValue && !memes.matched) return
    }
    record.lastAssistantAt = Date.now()
    record.updatedAt = record.lastAssistantAt
    this.save()
    const limit = Number(config.channels?.[record.channel]?.maxChars) || 1_500
    appendLog(PATHS.diag, `出站回合：${record.key}（${textValue.length} 字）→ ${record.channel}`)
    const result = await channel.send({ record, text: textValue, limit }).catch((error) => ({
      ok: false, error: String(error?.message ?? error),
    }))
    if (!result?.ok) {
      appendLog(PATHS.diag, `出站失败（${record.key}）：${result?.error ?? 'unknown'}`)
    }
  }

  /** 让某个通道下一次说话时重新建会话（QQ 换工作目录/Preset/模型后使用）。 */
  async resetChannel(channel) {
    let count = 0
    for (const [key, record] of Object.entries(this.db.records)) {
      if (record.channel !== channel) continue
      const sessionId = record.sessionId
      delete this.db.records[key]
      this.turnBuffers.delete(key)
      if (sessionId && this.handles.has(sessionId)) {
        const handle = this.handles.get(sessionId)
        this.handles.delete(sessionId)
        try { await handle?.dispose?.() } catch { /* 旧会话清理失败不影响新会话 */ }
      }
      count += 1
    }
    if (count) this.save()
    return count
  }

  status() {
    return {
      conversations: this.listConversations().map((record) => ({
        key: record.key,
        title: record.title,
        channel: record.channel,
        botId: record.botId,
        scope: record.scope,
        peerId: record.peerId,
        sessionId: record.sessionId,
        senderName: record.senderName,
        lastHumanAt: record.lastHumanAt,
        lastAssistantAt: record.lastAssistantAt,
        lastProactiveAt: record.lastProactiveAt,
        messageCount: record.messageCount,
        proactive: { ...record.proactive },
        voicePrompt: { ...record.voicePrompt },
        live: record.live,
      })),
    }
  }

  dispose() {
    this.disposed = true
    for (const handle of this.handles.values()) {
      try { void handle.dispose?.() } catch { /* ignore */ }
    }
    this.handles.clear()
    this.turnBuffers.clear()
  }
}
