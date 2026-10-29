// 灵犀 · 设置页用的同源 HTTP API。浏览器半侧只走 fetch，不碰 RPC。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { PATHS, configFilePath } from './config.js'
import { missingSessionDefaults } from './bots.js'
import { addMemories, forgetForTool, sessionMemoryState } from './memory.js'
import { moodSnapshot, resetMood } from './mood.js'
import { cleanupVoiceFile, synthesizeToFile, voiceStatus } from './voice.js'
import { noteVoiceSent } from './voice-prompt.js'
import { listModels } from './llm.js'
import { clearMemeCache, memeStatus } from './meme.js'
import { injectionHealth } from './injection-health.js'
import { appendLog, truncate } from './util.js'

const SECRET_FIELDS = [
  ['channels', 'qq', 'appSecret'],
  ['channels', 'feishu', 'appSecret'],
  ['channels', 'feishu', 'verificationToken'],
  ['channels', 'feishu', 'encryptKey'],
  ['channels', 'webhook', 'secret'],
  ['voice', 'apiKey'],
]

function getPath(object, keys) {
  let current = object
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

function setPath(object, keys, value) {
  let current = object
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]
    if (!current[key] || typeof current[key] !== 'object') current[key] = {}
    current = current[key]
  }
  current[keys[keys.length - 1]] = value
}

function deletePath(object, keys) {
  let current = object
  for (let i = 0; i < keys.length - 1; i++) {
    current = current?.[keys[i]]
    if (!current || typeof current !== 'object') return
  }
  delete current[keys[keys.length - 1]]
}

function mask(value) {
  const s = String(value ?? '')
  if (!s) return ''
  if (s.length <= 6) return '••••'
  return `${s.slice(0, 3)}••••${s.slice(-3)}`
}

export function sanitizeConfig(config) {
  const copy = JSON.parse(JSON.stringify(config))
  const secretSet = {}
  for (const keys of SECRET_FIELDS) {
    const value = getPath(copy, keys)
    secretSet[keys.join('.')] = Boolean(value)
    // 不把掩码回传给输入框：页面留空即"不改"，只有真正输入新值才会覆盖。
    setPath(copy, keys, '')
  }
  return { config: copy, secretSet }
}

/** 把设置页传来的补丁洗干净：掩码/空白的密钥不覆盖已有的。 */
export function cleanUiPatch(patch, current) {
  const next = JSON.parse(JSON.stringify(patch ?? {}))
  const clear = new Set(Array.isArray(next.clearSecrets) ? next.clearSecrets : [])
  delete next.clearSecrets
  for (const keys of SECRET_FIELDS) {
    const id = keys.join('.')
    const value = getPath(next, keys)
    if (value === undefined) continue
    const textValue = String(value ?? '')
    if (clear.has(id)) {
      setPath(next, keys, '')
      continue
    }
    if (textValue === '' || textValue.includes('••••') || textValue === mask(getPath(current, keys))) {
      deletePath(next, keys)
    }
  }
  return next
}

async function readBody(req, max = 2_000_000) {
  if (typeof req.on !== 'function') {
    let raw = ''
    try {
      for await (const chunk of req) {
        raw += chunk
        if (raw.length > max) raw = raw.slice(0, max)
      }
    } catch { /* ignore */ }
    try { return raw ? JSON.parse(raw) : {} } catch { return {} }
  }
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > max) raw = raw.slice(0, max)
    })
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function installApi(ctx, deps) {
  const { getConfig, setConfig, bridge, channels, botManager, botProactive, proactive, schedule, logger } = deps

  // 宿主会话目录很贵（整目录解压+解析），按 30 秒缓存；换绑候选再按机器人缓存 15 秒。
  const HOST_SESSION_CACHE_MS = 30_000
  const BINDABLE_CACHE_MS = 15_000
  const TITLE_CACHE_LIMIT = 500
  let sessionSourceCache = { at: 0, rows: [] }
  let bindableCache = { at: 0, key: '', rows: [] }
  const titleCache = new Map()

  function publicBots() {
    try {
      const chats = bridge.listConversations?.() ?? []
      return (botManager?.status?.() ?? []).map((bot) => ({
        ...bot,
        credentials: {
          ...(bot.credentials ?? {}),
          appSecret: bot.credentials?.appSecret ? '••••••••' : '',
        },
        chats: chats.filter((chat) => chat.botId === bot.id),
      }))
    } catch { return [] }
  }

  function personaSnapshot(botId) {
    const bot = botManager?.registry?.get?.(botId)
    if (!bot) return { botId, name: '', effective: { chars: 0, preview: '', sources: [] } }
    const file = join(botManager.registry.stateDir(bot.id), 'persona.md')
    let value = ''
    try { value = readFileSync(file, 'utf8') } catch { /* 空人格 */ }
    return {
      botId: bot.id,
      name: bot.name,
      effective: {
        chars: value.length,
        preview: value.slice(0, 2_000),
        sources: [{ kind: 'bot', botId: bot.id, path: file }],
      },
    }
  }

  async function workspaceCatalog() {
    const details = []
    const ownerBySession = new Map()
    try {
      for (const row of ctx.workspaceRegistry?.list?.() ?? []) {
        const path = String(row?.path ?? row?.directory ?? row?.dir ?? row?.root ?? '')
        if (!path) continue
        const item = {
          id: String(row?.id ?? path),
          title: String(row?.title ?? path),
          path,
          sessionIds: Array.isArray(row?.sessionIds) ? [...row.sessionIds] : [],
        }
        details.push(item)
        for (const sessionId of item.sessionIds) if (!ownerBySession.has(sessionId)) ownerBySession.set(sessionId, item)
      }
    } catch { /* 没有工作区服务时按空目录处理 */ }
    return { details, ownerBySession }
  }

  /**
   * 宿主会话目录（不含标题）。
   *
   * 宿主把每个会话存成 `<DSH_HOME>/sessions/<workspace>/session-<id>/session.v4.jsonl.zstd`，
   * 没有索引文件：列一次会话目录要把整个 sessions 目录解压+解析一遍，实测 61 个会话
   * ≈ 65MB 压缩 / 350MB 原文，接近一秒到数秒。所以这里按 30 秒缓存，别在每次打开
   * 设置页时都重扫。会话列表变化只影响「换绑候选」，30 秒的陈旧度对设置页够用。
   */
  async function sessionSource({ force = false } = {}) {
    const now = Date.now()
    if (!force && sessionSourceCache.rows.length && now - sessionSourceCache.at < HOST_SESSION_CACHE_MS) {
      return sessionSourceCache.rows
    }
    const rows = await scanHostSessions()
    sessionSourceCache = { at: Date.now(), rows }
    return rows
  }

  /** 真正去问宿主（贵）。 */
  async function scanHostSessions() {
    const catalog = await workspaceCatalog()
    try {
      const rows = await ctx.sessionQuery?.listSessions?.()
      if (!Array.isArray(rows)) return []
      const resolved = new Map()
      const result = []
      for (const row of rows) {
        const header = row?.header ?? {}
        const id = String(row?.id ?? row?.sessionId ?? header?.id ?? '')
        if (!id) continue
        const cwd = String(row?.cwd ?? header?.cwd ?? '')
        const explicit = catalog.ownerBySession.get(id)
        let workspace = explicit ?? null
        if (!workspace && cwd) {
          if (!resolved.has(cwd)) {
            resolved.set(cwd, await (async () => {
              try { return await ctx.workspaceRegistry?.resolveByPath?.(cwd) ?? null } catch { return null }
            })())
          }
          workspace = resolved.get(cwd)
        }
        result.push({
          id,
          title: String(row?.title ?? header?.title ?? row?.name ?? ''),
          cwd,
          updatedAt: Number(row?.updatedAt ?? header?.updatedAt ?? row?.lastActivity ?? 0) || 0,
          live: Boolean(row?.live),
          origin: String(header?.origin ?? ''),
          parentSession: String(header?.parentSession ?? ''),
          workspaceId: String(workspace?.id ?? ''),
          workspacePath: String(workspace?.path ?? ''),
          grouped: Boolean(explicit),
        })
      }
      return result
    } catch { return [] }
  }

  /** 聊天的会话绑定反查：一个 DSH 会话只能绑一个聊天。 */
  function chatKeyBySession() {
    const bySession = new Map()
    try {
      for (const record of bridge.listConversations?.() ?? []) {
        const sid = String(record?.sessionId ?? '')
        if (sid && !bySession.has(sid)) bySession.set(sid, String(record.key))
      }
    } catch { /* ignore */ }
    return bySession
  }

  /**
   * 标题不在 Session header 里，而在日志的 `session/title` 投影里；读一次要过宿主会话日志。
   * 只给真正要在界面上显示名字的那几行读，并按 (id, updatedAt) 缓存。
   */
  async function attachTitles(rows) {
    if (!rows.length || typeof ctx.sessionQuery?.readTitleSnapshots !== 'function') return rows
    const pending = []
    for (const row of rows) {
      const hit = titleCache.get(row.id)
      if (hit && row.updatedAt && hit.updatedAt === row.updatedAt) {
        row.title = hit.title
        continue
      }
      pending.push(row)
    }
    if (!pending.length) return rows
    try {
      const observations = await ctx.sessionQuery.readTitleSnapshots(pending.map((row) => row.id))
      const byId = new Map(pending.map((row) => [row.id, row]))
      for (const observation of Array.isArray(observations) ? observations : []) {
        if (observation?.status !== 'fulfilled') continue
        const value = observation.value
        const title = value?.title?.title
        const id = String(value?.session?.id ?? '')
        if (!id || typeof title !== 'string' || !title) continue
        const row = byId.get(id)
        if (!row) continue
        row.title = title
        if (row.updatedAt) {
          if (titleCache.size >= TITLE_CACHE_LIMIT) titleCache.clear()
          titleCache.set(id, { updatedAt: row.updatedAt, title })
        }
      }
    } catch { /* 标题读不到时保持未命名，不阻塞接口 */ }
    return rows
  }

  /**
   * 换绑候选 + 已绑会话：只保留跟这台机器人两段工作区有关、或已经绑在它聊天上的会话。
   * 界面上只有「会话管理」需要这份数据，所以从 /state 里摘出来单独给接口；
   * 结果按（机器人 + 工作区 + 绑定集）缓存，切页/刷新不会反复过宿主会话日志。
   */
  async function bindableSessions(botId = '', { force = false } = {}) {
    const wantedWorkspaces = new Set()
    for (const bot of botManager?.registry?.list?.() ?? []) {
      if (botId && bot.id !== botId) continue
      for (const scope of ['c2c', 'group']) {
        const path = String(bot.sessionDefaults?.[scope]?.workspace || '').trim()
        if (path) wantedWorkspaces.add(path)
      }
    }
    const bySession = chatKeyBySession()
    const boundKeys = new Set()
    for (const [sid, key] of bySession) {
      if (botId && (!key.startsWith(`${botId}:`))) continue
      boundKeys.add(sid)
    }
    const cacheKey = [botId, [...wantedWorkspaces].sort().join('|'), [...boundKeys].sort().join('|')].join('::')
    const now = Date.now()
    if (!force && bindableCache.key === cacheKey && now - bindableCache.at < BINDABLE_CACHE_MS) return bindableCache.rows

    const source = await sessionSource({ force })
    const rows = source.filter((row) => {
      if (!row.id) return false
      if (wantedWorkspaces.has(row.workspacePath) || wantedWorkspaces.has(row.cwd)) return true
      return boundKeys.has(row.id)
    }).map((row) => ({
      ...row,
      // 已经被某个聊天绑走就不能再选；界面上用 boundKey 判重。
      boundKey: bySession.get(row.id) ?? '',
    }))
    await attachTitles(rows)
    bindableCache = { at: now, key: cacheKey, rows }
    return rows
  }

  async function state(sessionId, cwd) {
    const config = getConfig()
    const sanitized = sanitizeConfig(config)
    const catalog = await workspaceCatalog()
    const bots = publicBots()
    const session = String(sessionId ?? '')
    let resolvedCwd = String(cwd ?? '')
    if (!resolvedCwd && session) {
      try { resolvedCwd = ctx.agents.get(session)?.session?.header?.cwd ?? '' } catch { /* ignore */ }
      if (!resolvedCwd) {
        try { resolvedCwd = ctx.sessions.get?.(session)?.header?.cwd ?? '' } catch { /* ignore */ }
      }
    }
    if (!resolvedCwd) resolvedCwd = process.cwd()
    const origin = ctx.webServer?.getOrigin?.() ?? ''
    return {
      ok: true,
      version: 1,
      origin,
      cwd: resolvedCwd,
      configPath: configFilePath(),
      root: PATHS.root,
      diagPath: PATHS.diag,
      identity: config.identity,
      config: sanitized.config,
      secretSet: sanitized.secretSet,
      workspaceDetails: catalog.details,
      sessionsLive: (() => {
        try {
          return (ctx.sessions?.list?.() ?? []).map((session) => ({
            id: String(session?.id ?? ''),
            cwd: String(session?.header?.cwd ?? ''),
            agentPreset: String(session?.header?.agentPreset ?? ''),
          })).filter((row) => row.id)
        } catch { return [] }
      })(),
      channels: channels.status(),
      bots,
      moods: bots.map((bot) => ({
        botId: bot.id,
        name: bot.name,
        mood: moodSnapshot(config, bot.id, bot.ownerName || ''),
      })),
      proactives: bots.map((bot) => ({
        botId: bot.id,
        name: bot.name,
        proactive: botProactive?.status?.(bot.id) ?? null,
      })),
      // 定时任务只给摘要：完整记录在 /api/companion/schedule，进那一页才拉。
      schedules: bots.map((bot) => ({
        botId: bot.id,
        name: bot.name,
        schedule: schedule?.brief?.(bot.id) ?? null,
      })),
      memories: bots.map((bot) => ({
        botId: bot.id,
        name: bot.name,
        memory: sessionMemoryState('', config, bot.id),
      })),
      sessions: bridge.status(),
      personas: bots.map((bot) => personaSnapshot(bot.id)),
      // 有预设把灵犀的上下文从装配里拿掉时，这里会有条目（正常为空数组）。
      injectionWarnings: injectionHealth(),
      voice: {
        enabled: config.voice.enabled,
        provider: config.voice.provider,
        endpoint: config.voice.endpoint,
        format: config.voice.format,
      },
    }
  }

  const route = (path, handler) => {
    try {
      return ctx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (error) {
            appendLog(PATHS.diag, `API ${path} 失败：${error?.message ?? error}`)
            try { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) } catch { /* ignore */ }
          }
        },
      })
    } catch (error) {
      appendLog(PATHS.diag, `API ${path} 注册失败（可能重复装载）：${error?.message ?? error}`)
      return () => {}
    }
  }

  const disposers = []
  const add = (path, handler) => disposers.push(route(path, handler))

  add('/api/companion/state', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    return sendJson(res, 200, await state(url.searchParams.get('sessionId'), url.searchParams.get('cwd')))
  })

  // 宿主会话目录：只有「会话管理」需要，单独一个接口 + 缓存，别拖慢每次打开设置页。
  add('/api/companion/sessions', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const botId = String(url.searchParams.get('botId') ?? '')
    if (botId && !botManager?.registry?.get?.(botId)) return sendJson(res, 404, { ok: false, error: '机器人不存在' })
    // refresh=1 绕过缓存重新扫宿主会话目录（界面上「刷新候选会话」用）。
    const force = ['1', 'true'].includes(String(url.searchParams.get('refresh') ?? ''))
    const sessions = await bindableSessions(botId, { force })
    return sendJson(res, 200, { ok: true, botId, sessions })
  })

  // 诊断：确认宿主 sessionTitle 服务是否可用，以及一个会话当前的真实标题。
  add('/api/companion/session-title', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let body = {}
    if (req.method === 'POST') body = await readBody(req)
    if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET/POST' })
    const sessionId = String(body.sessionId ?? url.searchParams.get('sessionId') ?? '')
    if (!sessionId) return sendJson(res, 400, { ok: false, error: 'sessionId' })
    let agent = ctx.agents?.get?.(sessionId) ?? null
    let resumed = false
    if (!agent && typeof ctx.agents?.resume === 'function') {
      try {
        const handle = await ctx.agents.resume({ resumeSessionId: sessionId })
        agent = handle?.agent ?? null
        resumed = Boolean(agent)
      } catch { /* 读不到就按未找到处理 */ }
    }
    const session = agent?.session ?? ctx.sessions?.get?.(sessionId) ?? null
    if (!session) return sendJson(res, 404, { ok: false, error: 'session not found' })
    const service = ctx.get?.('sessionTitle')
    const before = service?.get?.(session) ?? null
    let after = before
    if (req.method === 'POST') {
      const title = String(body.title ?? '').trim()
      if (!title) return sendJson(res, 400, { ok: false, error: 'title' })
      if (typeof service?.rename !== 'function') {
        return sendJson(res, 500, { ok: false, error: 'sessionTitle.rename unavailable', before, resumed })
      }
      try {
        after = service.rename(session, title.slice(0, 80))
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error?.message ?? error), before, resumed })
      }
    }
    return sendJson(res, 200, {
      ok: true,
      sessionId,
      resumed,
      serviceAvailable: typeof service?.rename === 'function',
      headerTitle: String(session.header?.title ?? ''),
      before,
      after,
    })
  })

  add('/api/companion/config', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST' })
    const body = await readBody(req)
    const current = getConfig()
    const rawPatch = body.config ?? body
    const patch = cleanUiPatch(rawPatch, current)
    const next = deps.patchConfig(patch) ?? current
    setConfig(next)
    // 只有连接相关的设置变了才重启机器人；工作区、会话和语音设置都不打断连接
    // （语音参数是懒读取的，改完下一句合成就用新的，把 QQ 连接踢掉纯属自伤）。
    try {
      const channelPatch = patch.channels ?? {}
      const connectionKeys = new Set([
        'enabled', 'appId', 'appSecret', 'verificationToken', 'encryptKey',
        'outboundUrl', 'secret', 'mode', 'webhook', 'token', 'aesKey', 'corpId', 'agentId',
      ])
      const connectionChanged = Object.values(channelPatch).some((group) => (
        group && typeof group === 'object'
        && Object.keys(group).some((key) => connectionKeys.has(key))
      ))
      if (connectionChanged) {
        botManager.stopAll()
        await botManager.startAll()
      }
    } catch (error) {
      logger?.warn?.(`companion: 重启通道失败：${error?.message ?? error}`)
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    return sendJson(res, 200, await state(url.searchParams.get('sessionId'), url.searchParams.get('cwd')))
  })

  add('/api/companion/persona', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let body = {}
    if (req.method === 'POST') body = await readBody(req)
    if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET/POST' })
    const botId = String(body.botId ?? url.searchParams.get('botId') ?? '')
    const bot = botManager?.registry?.get?.(botId)
    if (!bot) return sendJson(res, 400, { ok: false, error: '人格只属于机器人；请先选择/接入一台机器人' })
    const file = join(botManager.registry.stateDir(bot.id), 'persona.md')
    if (req.method === 'GET') {
      let text = ''
      try { text = readFileSync(file, 'utf8') } catch { /* 空人格 */ }
      return sendJson(res, 200, { ok: true, botId: bot.id, botName: bot.name, path: file, text, chars: text.length })
    }
    const text = String(body.text ?? '')
    if (text.length > 20_000) return sendJson(res, 400, { ok: false, error: '人格最多 20000 字' })
    mkdirSync(botManager.registry.stateDir(bot.id), { recursive: true })
    writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 })
    appendLog(PATHS.diag, `机器人人格已保存（${bot.id}，${text.length} 字）`)
    return sendJson(res, 200, { ok: true, botId: bot.id, botName: bot.name, path: file, chars: text.length })
  })

  add('/api/companion/memory', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let body = {}
    if (req.method === 'POST') body = await readBody(req)
    if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET/POST' })
    const sessionId = String(body.sessionId ?? url.searchParams.get('sessionId') ?? '')
    const explicitBotId = String(body.botId ?? url.searchParams.get('botId') ?? '')
    if (explicitBotId && !botManager?.registry?.get?.(explicitBotId)) {
      return sendJson(res, 400, { ok: false, error: '机器人不存在' })
    }
    const botId = explicitBotId || bridge.recordForSession?.(sessionId)?.botId || ''
    if (!botId && !sessionId) return sendJson(res, 400, { ok: false, error: '缺少 botId 或 sessionId' })
    if (req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ...sessionMemoryState(sessionId, getConfig(), botId) })
    }
    if (body.action === 'forget') {
      return sendJson(res, 200, { ok: true, ...forgetForTool(sessionId, body, botId) })
    }
    if (body.action === 'remember') {
      const { added } = addMemories(sessionId, [{ text: body.text, importance: body.importance, emotion: body.emotion, factKey: body.factKey, longTerm: body.longTerm }], { config: getConfig(), source: 'tool', botId })
      return sendJson(res, 200, { ok: true, added })
    }
    return sendJson(res, 400, { ok: false, error: '未知 action' })
  })

  // 挂饰问路：页面当前这个会话属于哪台机器人？没绑定就 bound:false。
  // 判定只有 bridge.recordForSession 一个来源（与 /memory 同口径）：会话先登记在某个聊天上，
  // 那个聊天的 botId 才说明它是机器人的会话；机器人被删掉时按未绑定处理。
  add('/api/companion/session', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const sessionId = String(url.searchParams.get('sessionId') ?? '')
    if (!sessionId) return sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
    const record = bridge.recordForSession?.(sessionId) ?? null
    const botId = String(record?.botId ?? '')
    const bot = botId ? (botManager?.registry?.get?.(botId) ?? null) : null
    return sendJson(res, 200, {
      ok: true,
      sessionId,
      bound: Boolean(bot),
      botId: bot ? botId : '',
      botName: bot ? String(bot.name ?? '') : '',
      chatKey: record?.key ?? '',
      scope: record?.scope ?? '',
      channel: record?.channel ?? '',
      title: record?.title ?? '',
    })
  })

  add('/api/companion/mood', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const botId = String(url.searchParams.get('botId') ?? '')
    const defaultBot = (() => {
      try { return botManager?.status?.()[0]?.id ?? '' } catch { return '' }
    })()
    const targetBotId = botId || defaultBot
    if (!targetBotId) return sendJson(res, 400, { ok: false, error: '心情只属于机器人；请先接入一台机器人' })
    const ownerOf = (id) => {
      try { return String(botManager?.registry?.get?.(id)?.ownerName ?? '') } catch { return '' }
    }
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, mood: moodSnapshot(getConfig(), targetBotId, ownerOf(targetBotId)) })
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET/POST' })
    const body = await readBody(req)
    if (body.action === 'reset') {
      const target = String(body.botId || targetBotId)
      const mood = resetMood(getConfig(), target, ownerOf(target))
      return sendJson(res, 200, { ok: true, mood })
    }
    return sendJson(res, 400, { ok: false, error: '未知 action' })
  })

  add('/api/companion/proactive', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const botId = String(url.searchParams.get('botId') ?? '')
    if (!botProactive) return sendJson(res, 503, { ok: false, error: '机器人主动搭话服务不可用' })
    if (req.method === 'GET') {
      return sendJson(res, 200, { ok: true, proactive: botProactive.status(botId) })
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET/POST' })
    const body = await readBody(req)
    if (body.action === 'update') {
      const status = botProactive.update(String(body.botId ?? botId), body.patch ?? {})
      return sendJson(res, 200, { ok: true, proactive: status })
    }
    try {
      const result = await botProactive.trigger(String(body.botId ?? botId), String(body.target ?? ''))
      return sendJson(res, 200, {
        ok: true,
        result,
        proactive: botProactive.status(String(body.botId ?? botId)),
      })
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  })

  // 定时激活：记录里的提交时间 / 等待间隔 / 任务内容就是页面要展示的全部。
  // 新建只在页面上点提交时用，模型侧走 companion_schedule 工具——两边都落同一份存储。
  add('/api/companion/schedule', async (req, res) => {
    if (!schedule) return sendJson(res, 503, { ok: false, error: '定时激活服务不可用' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const queryBotId = String(url.searchParams.get('botId') ?? '')
    if (req.method === 'GET') {
      if (!queryBotId) return sendJson(res, 400, { ok: false, error: '缺少 botId' })
      return sendJson(res, 200, { ok: true, ...schedule.status(queryBotId) })
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET/POST' })
    const body = await readBody(req)
    const botId = String(body.botId ?? queryBotId ?? '')
    if (!botId) return sendJson(res, 400, { ok: false, error: '缺少 botId' })
    const id = String(body.id ?? '')
    const action = String(body.action ?? 'create')
    try {
      if (action === 'create') {
        const conversation = String(body.conversation ?? '')
        const record = (bridge.listConversations?.() ?? [])
          .find((row) => row.key === conversation && row.botId === botId)
        if (!record) return sendJson(res, 404, { ok: false, error: '这个聊天不属于这台机器人' })
        const job = schedule.create({
          record,
          text: body.text,
          waitMinutes: body.waitMinutes,
          repeatMinutes: body.repeatMinutes,
        })
        appendLog(PATHS.diag, `定时激活（页面新建）#${job.id}：${truncate(String(job.text), 60)}`)
        return sendJson(res, 200, { ok: true, job, ...schedule.status(botId) })
      }
      if (action === 'cancel') {
        return sendJson(res, 200, { ok: true, job: schedule.cancel(botId, id), ...schedule.status(botId) })
      }
      if (action === 'remove') {
        schedule.remove(botId, id)
        return sendJson(res, 200, { ok: true, ...schedule.status(botId) })
      }
      if (action === 'toggle') {
        return sendJson(res, 200, {
          ok: true,
          job: schedule.toggle(botId, id, body.enabled === true),
          ...schedule.status(botId),
        })
      }
      if (action === 'fire') {
        const result = await schedule.activate(botId, id, { manual: true })
        return sendJson(res, 200, { ok: true, result, ...schedule.status(botId) })
      }
      return sendJson(res, 400, { ok: false, error: '未知 action' })
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  })

  add('/api/companion/channels/restart', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST' })
    botManager.stopAll()
    await botManager.startAll()
    return sendJson(res, 200, { ok: true, channels: channels.status() })
  })

  // 斗图：图库清单 + 最近一次「转成图片 / 没配上」，开关写在 config.json 的 meme 段。
  add('/api/companion/meme', async (req, res) => {
    if (req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (['1', 'true'].includes(String(url.searchParams.get('refresh') ?? ''))) clearMemeCache()
      return sendJson(res, 200, memeStatus(getConfig().meme))
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET/POST' })
    const body = await readBody(req)
    const patch = {}
    if (body.enabled !== undefined) patch.enabled = body.enabled === true || body.enabled === 'true'
    if (body.maxImages !== undefined) patch.maxImages = Number(body.maxImages)
    if (!Object.keys(patch).length) return sendJson(res, 400, { ok: false, error: '没有要改的字段（enabled / maxImages）' })
    const next = deps.patchConfig({ meme: patch }) ?? getConfig()
    setConfig(next)
    appendLog(PATHS.diag, `斗图设置更新：${JSON.stringify(patch)}`)
    return sendJson(res, 200, memeStatus(next.meme))
  })

  add('/api/companion/voice', async (req, res) => {
    if (req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const botId = String(url.searchParams.get('botId') ?? '')
      // 合成状态是全局一份，两页都用；「能发给谁」只有 QQ 机器人有，按 botId 取。
      // 带 botId 时再顺手把「这台机器人上次什么时候发过语音」交给注入状态一起显示。
      const stateDir = botId ? (botManager?.registry?.stateDir?.(botId) ?? '') : ''
      const voice = await voiceStatus(ctx, getConfig(), { stateDir })
      const qq = channels.status().find((row) => row.name === 'qq') ?? null
      if (!botId) return sendJson(res, 200, { ok: true, voice, qq, bot: null, targets: [] })
      const bot = (botManager?.status?.() ?? []).find((row) => row.id === botId)
      if (!bot) return sendJson(res, 404, { ok: false, error: '机器人不存在' })
      const targets = (bridge.listConversations?.() ?? [])
        .filter((row) => row.channel === 'qq' && row.botId === botId)
        .map((row) => ({
          key: row.key,
          title: row.title,
          peerId: row.peerId,
          botId: row.botId,
          scope: row.scope,
          lastHumanAt: Number(row.lastHumanAt) || 0,
          // 有回复目标才真发得出去；群聊要先在群里说一句话。
          ready: Boolean(row.target?.scope && row.target?.targetId),
        }))
      return sendJson(res, 200, { ok: true, voice, qq, bot, targets })
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET/POST' })
    const body = await readBody(req)
    const config = getConfig()
    const text = String(body.text ?? '').trim() || '这是一句测试语音，能听到就说明通了。'
    const voice = await synthesizeToFile(ctx, config, text)
    try {
      let sent = null
      if (body.sendTo) {
        const rows = bridge.listConversations()
        const record = rows.find((row) => row.key === body.sendTo || row.title === body.sendTo)
          ?? rows.find((row) => row.channel === 'qq' && (!body.botId || row.botId === body.botId))
        if (!record || record.channel !== 'qq') return sendJson(res, 400, { ok: false, error: '找不到要发送的 QQ 聊天，先在 QQ 里说一句话' })
        if (body.botId && record.botId && record.botId !== body.botId) {
          return sendJson(res, 400, { ok: false, error: '这个聊天不属于当前机器人' })
        }
        const channel = bridge.channelFor(record)
        if (!channel?.sendVoice) return sendJson(res, 400, { ok: false, error: 'QQ 官方 Bot 还没连接' })
        sent = await channel.sendVoice({ record, file: voice.file })
        // 设置页发出的也是真语音条：记账，下一轮的注入才知道「刚发过，先别又发」。
        if (sent?.ok !== false) {
          const botId = record.botId || body.botId || ''
          noteVoiceSent(botId ? (botManager?.registry?.stateDir?.(botId) ?? '') : '', text)
        }
      }
      const dataUrl = voice.bytes.length <= 2_000_000
        ? `data:audio/${voice.format};base64,${voice.bytes.toString('base64')}`
        : null
      const sendFailed = sent ? sent.ok === false : false
      return sendJson(res, 200, {
        ok: !sendFailed,
        ...(sendFailed ? { error: sent.error || '语音发送失败' } : {}),
        source: voice.source,
        format: voice.format,
        bytes: voice.bytes.length,
        audio: dataUrl,
        sent,
      })
    } finally {
      cleanupVoiceFile(voice.file)
    }
  })

  add('/api/companion/bots', async (req, res) => {
    if (!botManager) return sendJson(res, 503, { ok: false, error: '机器人运行时还没就绪' })
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, bots: publicBots() })
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET/POST' })
    const body = await readBody(req)
    const action = String(body.action ?? '')
    try {
      if (action === 'add') {
        const bot = botManager.addBot({
          channel: body.channel || 'qq',
          name: String(body.name ?? '').trim(),
          credentials: body.credentials && typeof body.credentials === 'object' ? body.credentials : {},
          ...(body.sessionDefaults && typeof body.sessionDefaults === 'object' ? { sessionDefaults: body.sessionDefaults } : {}),
        })
        return sendJson(res, 200, { ok: true, bot, bots: publicBots() })
      }
      if (action === 'update') {
        const current = botManager.registry?.get?.(String(body.botId ?? ''))
        if (!current) return sendJson(res, 404, { ok: false, error: '机器人不存在' })
        const patch = body.patch ?? {}
        if (patch.sessionDefaults !== undefined) {
          const missing = missingSessionDefaults(patch.sessionDefaults)
          if (missing.length) {
            return sendJson(res, 400, {
              ok: false,
              error: `新会话默认配置不完整：${missing.join('、')}`,
              missing,
            })
          }
        }
        const bot = botManager.updateBot(String(body.botId ?? ''), patch)
        // 称呼改了：QQ 私聊的标签立刻跟着变，不用等她下一条消息才刷新。
        if (patch.ownerName !== undefined) {
          try { bridge.relabelOwnerName(bot.id, bot.ownerName) } catch { /* 标签是附属信息，失败不影响保存 */ }
        }
        return sendJson(res, 200, { ok: true, bot, bots: publicBots() })
      }
      if (action === 'chat.update') {
        const key = String(body.key ?? '')
        if (!key) return sendJson(res, 400, { ok: false, error: '缺少会话 key' })
        const chat = bridge.listConversations?.().find((row) => row.key === key)
        if (!chat) return sendJson(res, 404, { ok: false, error: '会话不存在' })
        if (body.botId && chat.botId !== body.botId) return sendJson(res, 400, { ok: false, error: '会话不属于这台机器人' })
        const patch = body.patch && typeof body.patch === 'object' ? body.patch : {}
        const nextPatch = {}
        if (patch.title !== undefined) nextPatch.title = String(patch.title ?? '')
        const proactive = {}
        if (patch.proactiveEnabled !== undefined) proactive.enabled = patch.proactiveEnabled === true
        if (Object.keys(proactive).length) nextPatch.proactive = proactive
        const voicePrompt = {}
        if (patch.voicePromptEnabled !== undefined) voicePrompt.enabled = patch.voicePromptEnabled === true
        if (Object.keys(voicePrompt).length) nextPatch.voicePrompt = voicePrompt
        const updated = bridge.updateConversation(key, nextPatch)
        return sendJson(res, 200, { ok: true, chat: updated, bots: publicBots() })
      }
      if (action === 'remove') {
        const removed = botManager.removeBot(String(body.botId ?? ''))
        return sendJson(res, 200, { ok: true, removed, bots: publicBots() })
      }
      if (action === 'getPersona') {
        const bot = botManager.registry?.get?.(String(body.botId ?? ''))
        if (!bot) return sendJson(res, 404, { ok: false, error: '机器人不存在' })
        let textValue = ''
        try { textValue = readFileSync(join(botManager.registry.stateDir(bot.id), 'persona.md'), 'utf8') } catch { /* 空人格 */ }
        return sendJson(res, 200, { ok: true, botId: bot.id, text: textValue })
      }
      if (action === 'setPersona') {
        const bot = botManager.registry?.get?.(String(body.botId ?? ''))
        if (!bot) return sendJson(res, 404, { ok: false, error: '机器人不存在' })
        const textValue = String(body.text ?? '')
        if (textValue.length > 20_000) return sendJson(res, 400, { ok: false, error: '人格最多 20000 字' })
        const dir = botManager.registry.stateDir(bot.id)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'persona.md'), textValue, { encoding: 'utf8', mode: 0o600 })
        return sendJson(res, 200, { ok: true, botId: bot.id, chars: textValue.length })
      }
      if (action === 'provisionQr') {
        const channel = String(body.channel ?? 'qq')
        const result = await botManager.startProvisionChannel(channel, { name: String(body.name ?? '') })
        return sendJson(res, 200, { ok: true, ...result, bots: publicBots() })
      }
      if (action === 'provisionStatus') {
        const channel = String(body.channel ?? 'qq')
        return sendJson(res, 200, { ok: true, ...botManager.provisionChannelStatus(channel), bots: publicBots() })
      }
      if (action === 'provisionVerify') {
        const channel = String(body.channel ?? 'webhook')
        const result = await botManager.verifyProvision(channel, String(body.code ?? ''))
        return sendJson(res, 200, { ok: true, ...result, bots: publicBots() })
      }
      if (action === 'cancelProvision') {
        const channel = String(body.channel ?? 'qq')
        return sendJson(res, 200, { ok: true, ...botManager.cancelProvisionChannel(channel), bots: publicBots() })
      }
      if (action === 'bindSession') {
        const chatKey = String(body.chatKey ?? '')
        const record = bridge.listConversations?.().find((row) => row.key === chatKey)
        if (!record) return sendJson(res, 404, { ok: false, error: '聊天不存在' })
        if (body.botId && record.botId !== body.botId) return sendJson(res, 400, { ok: false, error: '聊天不属于这台机器人' })
        const bound = await bridge.bindSession(chatKey, body.sessionId ?? '')
        return sendJson(res, 200, { ok: true, chat: bound, bots: publicBots() })
      }
      if (action === 'test') {
        const result = await botManager.testConnection(String(body.botId ?? ''))
        return sendJson(res, result.ok ? 200 : 400, { ...result, bots: publicBots() })
      }
      if (action === 'qr') {
        const qr = await botManager.startQr(String(body.botId ?? ''))
        return sendJson(res, 200, { ok: true, qr, bots: publicBots() })
      }
      if (action === 'cancelQr') {
        botManager.cancelQr(String(body.botId ?? ''))
        return sendJson(res, 200, { ok: true, qr: botManager.qrStatus(String(body.botId ?? '')), bots: publicBots() })
      }
      if (action === 'reconnect') {
        await botManager.restart(String(body.botId ?? ''))
        return sendJson(res, 200, { ok: true, bots: publicBots() })
      }
      return sendJson(res, 400, { ok: false, error: '未知机器人操作：' + action })
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  })

  add('/api/companion/presets', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET' })
    try {
      const service = ctx.get?.('agentPresets') ?? ctx.agentPresets
      const listed = typeof service?.list === 'function' ? await service.list() : []
      const items = (Array.isArray(listed) ? listed : [])
        .filter((row) => row && typeof row.id === 'string' && row.id && row.broken === undefined)
        .map((row) => ({ id: row.id, name: String(row.name || row.label || row.id) }))
      return sendJson(res, 200, { ok: true, defaultId: String(service?.defaultId || ''), items })
    } catch (error) {
      return sendJson(res, 200, { ok: true, defaultId: '', items: [], error: String(error?.message ?? error) })
    }
  })

  add('/api/companion/models', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET' })
    return sendJson(res, 200, { ok: true, providers: await deps.listModels() })
  })

  add('/api/companion/directory/pick', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST' })
    try {
      const service = ctx.get?.('directoryPickerController') ?? ctx.directoryPickerController
      if (!service || typeof service.pick !== 'function') {
        return sendJson(res, 501, { ok: false, error: '宿主没有提供目录选择服务' })
      }
      const path = await service.pick(AbortSignal.timeout(300_000))
      return sendJson(res, 200, { ok: true, path: path == null ? null : String(path) })
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  })

  add('/api/companion/diag', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const lines = Math.max(10, Math.min(1_000, Number(url.searchParams.get('lines')) || 200))
    let rows = []
    try {
      rows = readFileSync(PATHS.diag, 'utf8').split('\n').filter(Boolean).slice(-lines)
    } catch { /* 还没有日志 */ }
    return sendJson(res, 200, { ok: true, path: PATHS.diag, lines: rows })
  })

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* ignore */ }
    }
  }, 'companion: api')

  return { state }
}

export function maskSecretValue(value) {
  return mask(value)
}
