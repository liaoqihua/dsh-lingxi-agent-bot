// 灵犀 · 定时激活
//
// 模型（或人）提交一条定时任务：提交时间 + 等待间隔 + 任务内容。到点后把任务内容
// 重新激活到目标聊天，走会话桥的 followup —— 和一条新消息同一条路，所以回复自然
// 回到那个聊天。状态落在 bots/<botId>/schedule.json，重启不丢；ticker 每 15 秒看一次。
//
// 三条刻意的选择：
//   · 按聊天记账，不按会话：换绑会话后任务照样能激活到同一个聊天。
//   · 会话正忙时不排队、也不算失败，下个 tick 再看：定时任务晚几分钟没人在意，
//     插进正在说的半句话里才是打扰。
//   · 连续失败三次自动停用并保留记录：页面上要能看到「试过、没成、为什么」。
import { join } from 'node:path'

import { PATHS } from './config.js'
import { clockText, zoneText } from './time-context.js'
import { appendLog, clamp, localTime, readJsonSafe, text, truncate, writeJsonAtomic } from './util.js'

export const VERSION = 1

/** 等待间隔的下限：ticker 是 15 秒，1 分钟是能稳定兑现的最小粒度。 */
export const MIN_WAIT_MINUTES = 1
export const MAX_WAIT_MINUTES = 10_080 // 7 天
/** 一台机器人最多留多少条记录（含已完成）；超出时先删最老的已完成记录。 */
export const MAX_JOBS = 50
/** 还没激活的定时任务上限：防止模型一口气排几百条把自己吵死。 */
export const MAX_PENDING = 20
export const MAX_TEXT = 2_000
/** 连续失败几次就自动停用。 */
export const FAIL_LIMIT = 3
/** 错过太久（进程没开）就不再补激活：三天前让你「十分钟后喝口水」没有意义。 */
export const MISSED_AFTER_MS = 24 * 3600_000

export const STATUSES = Object.freeze(['pending', 'done', 'cancelled', 'failed'])
export const STATUS_TEXT = Object.freeze({
  pending: '待激活',
  done: '已激活',
  cancelled: '已取消',
  failed: '没激活成功',
})

const STATUS_SET = new Set(STATUSES)

export function statePath(botId) {
  if (!botId) throw new Error('定时激活只属于机器人，缺少 botId')
  const safe = String(botId).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160)
  return join(PATHS.root, 'bots', safe, 'schedule.json')
}

export function blankStore(botId) {
  return { version: VERSION, botId, jobs: [] }
}

/** 读盘时把形状收敛：旧数据/手改数据缺字段也不该让 ticker 抛错。 */
export function normalizeJob(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = text(raw.id)
  if (!id) return null
  const createdAt = Number(raw.createdAt) || Date.now()
  let waitMinutes = Number(raw.waitMinutes)
  let dueAt = Number(raw.dueAt)
  if (!Number.isFinite(waitMinutes) || waitMinutes <= 0) {
    waitMinutes = Number.isFinite(dueAt) && dueAt > createdAt
      ? Math.round((dueAt - createdAt) / 60_000)
      : MIN_WAIT_MINUTES
  }
  waitMinutes = Math.round(clamp(waitMinutes, MIN_WAIT_MINUTES, MAX_WAIT_MINUTES))
  if (!Number.isFinite(dueAt) || dueAt <= 0) dueAt = createdAt + waitMinutes * 60_000
  const repeatMinutes = Math.round(clamp(Number(raw.repeatMinutes) || 0, 0, MAX_WAIT_MINUTES))
  return {
    id,
    conversation: text(raw.conversation),
    sessionId: text(raw.sessionId),
    title: text(raw.title),
    text: String(raw.text ?? '').slice(0, MAX_TEXT),
    createdAt,
    waitMinutes,
    repeatMinutes,
    dueAt,
    status: STATUS_SET.has(raw.status) ? raw.status : 'pending',
    enabled: raw.status === 'done' || raw.status === 'cancelled' ? false : raw.enabled !== false,
    fireCount: Math.max(0, Math.round(Number(raw.fireCount) || 0)),
    firedAt: Number(raw.firedAt) || 0,
    attempts: Math.max(0, Math.round(Number(raw.attempts) || 0)),
    lastError: String(raw.lastError ?? '').slice(0, 300),
    cancelledAt: Number(raw.cancelledAt) || 0,
  }
}

export function normalizeStore(raw, botId) {
  const store = blankStore(botId)
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.jobs)) return store
  for (const row of raw.jobs) {
    const job = normalizeJob(row)
    if (job) store.jobs.push(job)
  }
  return store
}

export function loadStore(botId) {
  return normalizeStore(readJsonSafe(statePath(botId), null), botId)
}

export function saveStore(store) {
  writeJsonAtomic(statePath(store.botId), store)
  return store
}

/** 还没结束、且开着开关的任务（配额与展示都看这个口径）。 */
export function activeJobs(store) {
  return (store?.jobs ?? []).filter((job) => job.status === 'pending' && job.enabled)
}

/**
 * 记录上限：先删最老的「已取消」，再考虑其它已结束的记录；
 * 全是在等激活的任务时不再删——宁可拒绝新建，也不悄悄丢掉别人的安排。
 */
function makeRoom(store) {
  while (store.jobs.length >= MAX_JOBS) {
    const index = store.jobs.findIndex((job) => job.status === 'cancelled')
    const target = index >= 0 ? index : store.jobs.findIndex((job) => job.status !== 'pending')
    if (target < 0) {
      throw new Error(`定时任务记录已满（${MAX_JOBS} 条，还有 ${activeJobs(store).length} 条在等激活），先删掉几条旧记录`)
    }
    store.jobs.splice(target, 1)
  }
}

function newJobId(now = Date.now()) {
  return 'sch_' + now.toString(36) + Math.random().toString(36).slice(2, 6)
}

/**
 * 新建一条定时任务。校验全部在落盘之前做完，失败直接抛给调用方（工具会把它当错误返回）。
 * @returns 规范化后的任务对象
 */
export function createJob(botId, input = {}, now = Date.now()) {
  if (!botId) throw new Error('定时激活只属于机器人，缺少 botId')
  const body = String(input.text ?? '').trim()
  if (!body) throw new Error('任务内容不能为空')
  if (body.length > MAX_TEXT) throw new Error(`任务内容最多 ${MAX_TEXT} 字`)
  const conversation = text(input.conversation)
  if (!conversation) throw new Error('缺少目标聊天')
  const waitRaw = input.waitMinutes === undefined || input.waitMinutes === null || input.waitMinutes === ''
    ? 30
    : Number(input.waitMinutes)
  if (!Number.isFinite(waitRaw)) throw new Error('等待间隔要写分钟数')
  const waitMinutes = Math.round(waitRaw)
  if (waitMinutes < MIN_WAIT_MINUTES) throw new Error(`等待间隔不能小于 ${MIN_WAIT_MINUTES} 分钟`)
  if (waitMinutes > MAX_WAIT_MINUTES) throw new Error(`等待间隔最多 ${MAX_WAIT_MINUTES} 分钟（7 天）`)
  const repeatRaw = input.repeatMinutes === undefined || input.repeatMinutes === null || input.repeatMinutes === ''
    ? 0
    : Number(input.repeatMinutes)
  if (!Number.isFinite(repeatRaw)) throw new Error('重复间隔要写分钟数，0 = 只激活一次')
  const repeatMinutes = Math.round(repeatRaw)
  if (repeatMinutes < 0) throw new Error('重复间隔不能是负数')
  if (repeatMinutes > MAX_WAIT_MINUTES) throw new Error(`重复间隔最多 ${MAX_WAIT_MINUTES} 分钟（7 天）`)

  const store = loadStore(botId)
  if (activeJobs(store).length >= MAX_PENDING) {
    throw new Error(`这台机器人已经有 ${MAX_PENDING} 条在等激活的定时任务了，先取消几条`)
  }
  makeRoom(store)

  const job = {
    id: newJobId(now),
    conversation,
    sessionId: text(input.sessionId),
    title: text(input.title).slice(0, 80),
    text: body,
    createdAt: now,
    waitMinutes,
    repeatMinutes,
    dueAt: now + waitMinutes * 60_000,
    status: 'pending',
    enabled: true,
    fireCount: 0,
    firedAt: 0,
    attempts: 0,
    lastError: '',
    cancelledAt: 0,
  }
  store.jobs.push(job)
  saveStore(store)
  return job
}

export function findJob(store, id) {
  const key = String(id ?? '').trim()
  if (!key) return null
  return (store?.jobs ?? []).find((job) => job.id === key) ?? null
}

/** 到点、开着、还没结束的任务；按 dueAt 升序（先到点的先激活）。 */
export function dueJobs(store, now = Date.now()) {
  return activeJobs(store)
    .filter((job) => job.dueAt <= now)
    .sort((a, b) => a.dueAt - b.dueAt)
}

export function cancelJob(botId, id, now = Date.now()) {
  const store = loadStore(botId)
  const job = findJob(store, id)
  if (!job) throw new Error('定时任务不存在')
  if (job.status !== 'pending') throw new Error(`这条任务已经${STATUS_TEXT[job.status]}，不用再取消`)
  job.status = 'cancelled'
  job.enabled = false
  job.cancelledAt = now
  saveStore(store)
  appendLog(PATHS.diag, `定时激活 #${job.id} 已取消（${job.title || job.conversation}）`)
  return job
}

export function removeJob(botId, id) {
  const store = loadStore(botId)
  const before = store.jobs.length
  store.jobs = store.jobs.filter((job) => job.id !== String(id ?? '').trim())
  if (store.jobs.length === before) throw new Error('定时任务不存在')
  saveStore(store)
  return true
}

export function setEnabled(botId, id, enabled) {
  const store = loadStore(botId)
  const job = findJob(store, id)
  if (!job) throw new Error('定时任务不存在')
  if (job.status !== 'pending') throw new Error(`这条任务已经${STATUS_TEXT[job.status]}，不能再开关`)
  job.enabled = enabled === true
  saveStore(store)
  return job
}

/** 下一次会激活的时刻；已结束/停用/取消返回 0。 */
export function nextFireAt(job) {
  if (!job || job.status !== 'pending' || !job.enabled) return 0
  return Number(job.dueAt) || 0
}

/**
 * 激活时投递给会话的那段正文。
 * 写清楚「谁在什么时候提交、等了多久、现在几点」：模型要靠这些信息判断该说什么，
 * 而不是把自己定的任务当成对方刚发来的话。
 *
 * 为什么要单独给「现在」：这条消息是插件塞进来的，没有宿主准备的回合上下文，
 * 只给「提交时间 + 等了 N 分钟」时模型还得自己做加法，tick 有 15 秒粒度、
 * 卡顿后补激活还会更晚，算出来的时刻和真实时间对不上，就会说出错的时间。
 */
export function activationText(job, now = Date.now()) {
  const createdAt = Number(job.createdAt) || now
  const waited = Math.max(0, Math.round((now - createdAt) / 60_000))
  const head = `（定时激活 #${job.id} · ${localTime(createdAt)} 提交，等了 ${waited} 分钟）`
  return [
    head,
    `现在是 ${clockText(now)}（${zoneText(now)}）。`,
    '到点了，这是你自己之前给自己定的任务，现在处理它：',
    String(job.text ?? ''),
  ].join('\n')
}

/**
 * 页面/工具看到的投影。不返回内部字段，时间同时给原始毫秒和本地文案，
 * 前端只负责排版，不重复算时区。
 */
export function jobRow(job, { record = null, now = Date.now() } = {}) {
  const next = nextFireAt(job)
  return {
    id: job.id,
    status: job.status,
    statusText: STATUS_TEXT[job.status] || job.status,
    enabled: job.enabled === true,
    text: job.text,
    createdAt: job.createdAt,
    submittedAt: localTime(job.createdAt),
    waitMinutes: job.waitMinutes,
    repeatMinutes: job.repeatMinutes,
    dueAt: job.dueAt,
    dueText: localTime(job.dueAt),
    nextFireAt: next,
    nextText: next ? localTime(next) : '',
    remainingMinutes: next ? Math.max(0, Math.round((next - now) / 60_000)) : 0,
    firedAt: job.firedAt,
    fireCount: job.fireCount,
    attempts: job.attempts,
    lastError: job.lastError,
    conversation: job.conversation,
    conversationTitle: record?.title || job.title || job.conversation,
    channel: record?.channel || '',
    scope: record?.scope || '',
    sessionId: job.sessionId,
  }
}

function recordIndexOf(bridge) {
  const index = new Map()
  try {
    for (const record of bridge?.listConversations?.() ?? []) {
      if (record?.key && !index.has(record.key)) index.set(record.key, record)
    }
  } catch { /* 没有聊天时按空表处理 */ }
  return index
}

export function installSchedule(ctx, { getConfig, getBots, bridge, logger } = {}) {
  const firing = new Set()
  let timer = null
  let stopped = false

  const botIds = () => {
    try { return (getBots?.() ?? []).map((bot) => bot?.id).filter(Boolean) } catch { return [] }
  }

  function recordOf(job) {
    try {
      const rows = bridge?.listConversations?.() ?? []
      return rows.find((row) => row.key === job.conversation) ?? null
    } catch { return null }
  }

  /**
   * 出站通道现在就绪吗。三件真事：
   *   · 重启时 ticker 比 botManager.startAll() 先跑，通道可能还不存在；
   *   · QQ 还要等长连接真的连上——没连上时 send 一定失败；
   *   · 但别的通道不能拿 connected 一刀切：飞书的 status().connected 永远是 false，
   *     它是「配置齐了 + 按需取 token」，所以只看 configured。
   * 没有 channelFor 的装配（老宿主 / 单元测试）按就绪处理，别把测试和各处调用都拖死。
   */
  function channelState(record) {
    try {
      const bot = (getBots?.() ?? []).find((row) => row.id === record.botId)
      if (bot && bot.enabled === false) return { ready: false, reason: '机器人被停用了' }
    } catch { /* 拿不到机器人列表就按没停用处理 */ }
    if (typeof bridge?.channelFor !== 'function') return { ready: true }
    let channel = null
    try { channel = bridge.channelFor(record) } catch { channel = null }
    if (!channel) return { ready: false, reason: '机器人还没启动' }
    let status = {}
    try { status = channel.status?.() ?? {} } catch { status = {} }
    if (status.configured === false) return { ready: false, reason: '机器人还没配置好' }
    if (record.channel === 'qq' && status.connected !== true) {
      return { ready: false, reason: status.connecting === true ? 'QQ 正在连接' : 'QQ 还没连上' }
    }
    return { ready: true }
  }

  function status(botId = '') {
    const ids = botId ? [botId] : botIds()
    const index = recordIndexOf(bridge)
    const now = Date.now()
    const stores = ids.map((id) => {
      const store = loadStore(id)
      return {
        botId: id,
        jobs: store.jobs
          .slice()
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((job) => jobRow(job, { record: index.get(job.conversation) ?? null, now })),
        pending: activeJobs(store).length,
        total: store.jobs.length,
      }
    })
    // 有 botId 就只给这一台（页面永远这么问）；没有就给各台的摘要，不挑一台冒充全部。
    const primary = botId
      ? (stores[0] ?? { botId, jobs: [], pending: 0, total: 0 })
      : { botId: '', jobs: [], pending: 0, total: 0 }
    return {
      botId,
      jobs: primary.jobs,
      pending: primary.pending,
      total: primary.total,
      bots: stores.map((row) => ({
        botId: row.botId,
        pending: row.pending,
        total: row.total,
        nextAt: row.jobs.reduce((at, job) => (job.nextFireAt && (!at || job.nextFireAt < at) ? job.nextFireAt : at), 0),
      })),
      conversations: (() => {
        try {
          return (bridge?.listConversations?.() ?? [])
            .filter((row) => !botId || row.botId === botId)
            .map((row) => ({
              key: row.key,
              title: row.title || row.key,
              channel: row.channel,
              scope: row.scope,
              sessionId: row.sessionId,
              live: row.live === true,
            }))
        } catch { return [] }
      })(),
      caps: {
        minWaitMinutes: MIN_WAIT_MINUTES,
        maxWaitMinutes: MAX_WAIT_MINUTES,
        maxText: MAX_TEXT,
        maxJobs: MAX_JOBS,
        maxPending: MAX_PENDING,
        failLimit: FAIL_LIMIT,
      },
    }
  }

  function brief(botId) {
    try {
      const store = loadStore(botId)
      const pending = activeJobs(store)
      return {
        botId,
        total: store.jobs.length,
        pending: pending.length,
        nextAt: pending.reduce((at, job) => (!at || job.dueAt < at ? job.dueAt : at), 0),
      }
    } catch {
      return { botId, total: 0, pending: 0, nextAt: 0 }
    }
  }

  /**
   * 记账一律重读 → 改这条 → 写回：激活链路中间有 await（拉会话、followup），
   * 期间页面可能新建/取消别的任务，不能拿旧快照整个盖回去。
   */
  function patchJob(botId, jobId, mutate) {
    const store = loadStore(botId)
    const job = findJob(store, jobId)
    if (!job) return null
    mutate(job)
    saveStore(store)
    return job
  }

  function noteFail(botId, jobId, reason) {
    const job = patchJob(botId, jobId, (target) => {
      target.attempts = Math.max(0, Number(target.attempts) || 0) + 1
      target.lastError = truncate(String(reason ?? ''), 300)
      if (target.attempts >= FAIL_LIMIT) {
        target.status = 'failed'
        target.enabled = false
      }
    })
    if (!job) return { ok: false, reason: '定时任务不存在' }
    appendLog(PATHS.diag, job.status === 'failed'
      ? `定时激活 #${job.id} 连续 ${job.attempts} 次没激活成功，已停用：${job.lastError}`
      : `定时激活 #${job.id} 第 ${job.attempts} 次没激活成功，下个 tick 再试：${job.lastError}`)
    return { ok: false, reason: job.lastError, job: jobRow(job, { record: recordOf(job) }) }
  }

  /**
   * 真激活一条任务。ticker 与页面「立即激活」共用这一段，区别只在 manual：
   * manual 越过「会话忙」和「错过太久」的限制，因为是人当场点的。
   */
  async function activate(botId, jobId, { manual = false } = {}) {
    const store = loadStore(botId)
    const job = findJob(store, jobId)
    if (!job) return { ok: false, reason: '定时任务不存在' }
    if (job.status !== 'pending') {
      return { ok: false, reason: `这条任务已经${STATUS_TEXT[job.status] || job.status}` }
    }
    // 自动激活尊重停用开关；人点「立即激活」时不看开关——他就在屏幕前面。
    if (!manual && !job.enabled) return { ok: false, reason: '这条任务被停用了' }
    const now = Date.now()
    if (!manual && now - job.dueAt > MISSED_AFTER_MS) {
      const expired = patchJob(botId, job.id, (target) => {
        target.status = 'failed'
        target.enabled = false
        target.lastError = '错过太久（进程没开着、或机器人一直没连上，超过 24 小时），没有补激活'
      })
      appendLog(PATHS.diag, `定时激活 #${job.id} 错过太久，标记失败`)
      return { ok: false, reason: expired?.lastError ?? '错过太久', job: expired ? jobRow(expired) : null }
    }
    const guard = `${botId}:${job.id}`
    if (firing.has(guard)) return { ok: false, reason: '正在激活' }
    firing.add(guard)
    try {
      const record = recordOf(job)
      if (!record) return noteFail(botId, job.id, '找不到目标聊天了（可能已经删除）')
      if (!record.botId) return noteFail(botId, job.id, '目标聊天没有绑定机器人')
      // 重启后 ticker 会比通道先跑起来：这一刻发出去，回复没有通道可回，等于白跑一轮。
      // 通道没就绪就当「还没到时候」，不排队、不计失败，下个 tick 再看。
      const channel = channelState(record)
      if (!channel.ready) return { ok: false, reason: channel.reason, retry: true }
      let agent = null
      try {
        agent = await bridge.ensureAgent(record)
      } catch (error) {
        return noteFail(botId, job.id, `目标会话拉不起来：${error?.message ?? error}`)
      }
      if (!agent) return noteFail(botId, job.id, '目标会话拉不起来')
      if (!manual && typeof agent.status === 'string' && agent.status !== 'idle') {
        // 忙的时候不排队：这一条只是晚点激活，插进正在说的半句话里才是打扰。
        return { ok: false, reason: '会话正忙，等一下再激活', retry: true }
      }
      await bridge.deliverActivation(record, agent, activationText(job, now), { jobId: job.id })
      const fired = patchJob(botId, job.id, (target) => {
        target.fireCount = Math.max(0, Number(target.fireCount) || 0) + 1
        target.firedAt = Date.now()
        target.attempts = 0
        target.lastError = ''
        if (target.repeatMinutes > 0) {
          target.status = 'pending'
          target.enabled = true
          target.dueAt = target.firedAt + target.repeatMinutes * 60_000
        } else {
          target.status = 'done'
          target.enabled = false
        }
      })
      appendLog(PATHS.diag, `定时激活 #${job.id} ✓（${record.title || record.key}，第 ${fired?.fireCount ?? 1} 次）：${truncate(job.text, 60)}`)
      try { logger?.info?.(`companion 定时激活 ${botId} #${job.id}`) } catch { /* ignore */ }
      return { ok: true, job: fired ? jobRow(fired, { record }) : null }
    } catch (error) {
      return noteFail(botId, job.id, error?.message ?? error)
    } finally {
      firing.delete(guard)
    }
  }

  async function tick() {
    if (stopped) return 0
    let fired = 0
    for (const botId of botIds()) {
      try {
        const store = loadStore(botId)
        const due = dueJobs(store)
        for (const job of due) {
          const result = await activate(botId, job.id, { manual: false })
          if (result?.ok) fired += 1
        }
      } catch (error) {
        appendLog(PATHS.diag, `定时激活[${botId}] tick 出错：${error?.message ?? error}`)
      }
    }
    return fired
  }

  function start() {
    stopped = false
    // 15 秒粒度：等待间隔按分钟算，到点的误差压在 15 秒内，任务量小、读的是本地小文件。
    timer = ctx.interval(() => { void tick() }, 15_000)
    ctx.effect(() => () => stop())
    // 启动时立刻补一次：进程刚起来就有一批到点的任务在等。
    void tick()
  }

  function stop() {
    stopped = true
    try { timer?.() } catch { /* ignore */ }
    timer = null
  }

  function create({ record, text: body, waitMinutes, repeatMinutes } = {}) {
    if (!record?.botId) throw new Error('定时激活只属于机器人：这个会话没有绑定机器人')
    if (!record?.key) throw new Error('缺少目标聊天')
    const job = createJob(record.botId, {
      conversation: record.key,
      sessionId: record.sessionId,
      title: record.title,
      text: body,
      waitMinutes,
      repeatMinutes,
    }, Date.now())
    appendLog(
      PATHS.diag,
      `定时激活 + #${job.id}（${record.title || record.key}，等 ${job.waitMinutes} 分钟`
      + `${job.repeatMinutes > 0 ? `，每 ${job.repeatMinutes} 分钟重复` : ''}）：${truncate(job.text, 60)}`,
    )
    return jobRow(job, { record })
  }

  return {
    start,
    stop,
    tick,
    status,
    brief,
    create,
    activate,
    cancel: (botId, id) => jobRow(cancelJob(botId, id), { record: null }),
    remove: (botId, id) => removeJob(botId, id),
    toggle: (botId, id, enabled) => jobRow(setEnabled(botId, id, enabled), { record: null }),
    /** 兼容旧调用名：和 proactive 的 trigger 对齐。 */
    trigger: (botId, id) => activate(botId, id, { manual: true }),
  }
}