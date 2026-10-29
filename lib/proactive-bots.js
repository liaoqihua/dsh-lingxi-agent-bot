// 灵犀 · 机器人级主动搭话
//
// 每台机器人有自己的节奏、冷却和统计；「在哪个聊天里开口」由会话级开关决定
// （record.proactive.enabled），状态源唯一化为 sessions.json 的 record。
import { join } from 'node:path'
import { PATHS } from './config.js'
import { appendLog, dayKey, readJsonSafe, writeJsonAtomic } from './util.js'

const VERSION = 1

export function statePath(botId) {
  if (!botId) throw new Error('主动搭话只属于机器人，缺少 botId')
  const safe = String(botId).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160)
  return join(PATHS.root, 'bots', safe, 'proactive.json')
}

export function blankState(config, botId) {
  const source = config?.proactive ?? {}
  // 注意：这些字段里 0 是有意义的（命中线 0 = 不靠骰子开口、安静时段 0 点）。
  // 早先用 `Number(x) || 默认值` 会把 0 吃成默认值，导致「命中线 0」实际变成 30。
  const num = (value, fallback) => {
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
  }
  return {
    version: VERSION,
    botId,
    enabled: source.enabled !== false,
    intervalMinutes: num(source.intervalMinutes, 30),
    hitLine: num(source.hitLine, 30),
    missBonus: num(source.missBonus, 10),
    bonusCap: num(source.bonusCap, 40),
    quietStart: num(source.quietStart, 23),
    quietEnd: num(source.quietEnd, 7),
    minIdleMinutes: num(source.minIdleMinutes, 60),
    cooldownMinutes: num(source.cooldownMinutes, 20),
    maxPerDay: num(source.maxPerDay, 6),
    prompt: String(source.prompt || ''),
    misses: 0,
    lastSpokeAt: 0,
    lastTickAt: 0,
    lastRollAt: 0,
    lastRoll: null,
    saidAt: [],
    logs: [],
  }
}

/** 旧数据里的 targets / target 直接忽略：目标选择只认 record.proactive。 */
export function normalizeState(raw, config, botId) {
  const base = blankState(config, botId)
  if (!raw || typeof raw !== 'object') return base
  for (const key of ['enabled', 'intervalMinutes', 'hitLine', 'missBonus', 'bonusCap', 'quietStart', 'quietEnd', 'minIdleMinutes', 'cooldownMinutes', 'maxPerDay']) {
    if (raw[key] !== undefined) base[key] = raw[key]
  }
  base.enabled = raw.enabled !== false
  base.prompt = String(raw.prompt ?? base.prompt)
  base.misses = Math.max(0, Math.round(Number(raw.misses) || 0))
  base.lastSpokeAt = Number(raw.lastSpokeAt) || 0
  base.lastTickAt = Number(raw.lastTickAt) || 0
  base.lastRollAt = Number(raw.lastRollAt) || 0
  base.lastRoll = raw.lastRoll && typeof raw.lastRoll === 'object' ? raw.lastRoll : null
  base.saidAt = Array.isArray(raw.saidAt) ? raw.saidAt.map(Number).filter((x) => x > 0).slice(-300) : []
  base.logs = Array.isArray(raw.logs) ? raw.logs.slice(-80) : []
  return base
}

export function loadState(botId, config) {
  return normalizeState(readJsonSafe(statePath(botId), null), config, botId)
}

export function saveState(state) {
  writeJsonAtomic(statePath(state.botId), state)
  return state
}

export function inQuietHours(hour, start, end) {
  if (start === end) return false
  if (start < end) return hour >= start && hour < end
  return hour >= start || hour < end
}

export function hitLineOf(state) {
  const bonus = Math.min(state.bonusCap, Math.max(0, state.misses) * state.missBonus)
  return { bonus, line: Math.min(100, Math.max(0, state.hitLine + bonus)) }
}

export function todaySaid(state) {
  const key = dayKey()
  return (state.saidAt ?? []).filter((at) => dayKey(at) === key).length
}

function shortConv(record) {
  return `${record.channel}:${record.scope}:${String(record.peerId ?? '').slice(-8)}`
}

function lastHumanOf(record) {
  return Number(record.lastHumanAt) || Number(record.createdAt) || 0
}

function conversationRows(bridge, botId) {
  return (bridge.listConversations?.() ?? []).filter((row) => row.botId === botId)
}

function proactiveOf(record) {
  return record?.proactive && typeof record.proactive === 'object' ? record.proactive : {}
}

/** 冷却只按机器人级那一个值算（冷却属于「主动搭话」页的节奏参数，不按会话分设）。 */
export function coolingDown(record, botCooldownMinutes, now = Date.now()) {
  const minutes = Number(botCooldownMinutes) || 0
  const lastAt = Number(proactiveOf(record).lastSpokeAt) || 0
  if (minutes <= 0 || !lastAt) return false
  return (now - lastAt) / 60_000 < minutes
}

/**
 * 挑这一次开口的聊天：bot 内、开了会话级主动搭话、按最近有人说话降序取第一个，
 * 且不在会话级冷却里。manual（用户点“现在说一句”）只跳过冷却与节奏闸门，
 * 仍然尊重会话开关；显式指定 targetKey 时按用户意图直取。
 */
function pickConversation(rows, state, { manual = false, targetKey = '' } = {}) {
  if (targetKey) {
    const hit = rows.find((row) => row.key === targetKey)
    return hit ? { record: hit } : { record: null, reason: '指定的聊天现在没绑定' }
  }
  if (!rows.length) return { record: null, reason: '这台机器人还没有聊天' }
  const pool = rows.filter((row) => proactiveOf(row).enabled === true)
  if (!pool.length) return { record: null, reason: '还没有开启主动搭话的聊天' }
  const sorted = [...pool].sort((a, b) => lastHumanOf(b) - lastHumanOf(a))
  if (manual) return { record: sorted[0] }
  const open = sorted.filter((row) => !coolingDown(row, state.cooldownMinutes))
  if (!open.length) return { record: null, reason: '开着主动搭话的聊天都还在冷却里' }
  return { record: open[0] }
}

/**
 * 记一条尝试日志。
 * 这里必须自己落盘：设置页的「日志」卡片读的是 proactive.json 的 logs，
 * 以前调用方先 saveState 再 note，note 后没人再写，页面永远是空的（2026-10-28 修）。
 */
function note(state, text, logger) {
  const row = { at: Date.now(), text: String(text) }
  state.logs.push(row)
  if (state.logs.length > 80) state.logs.shift()
  saveState(state)
  appendLog(PATHS.diag, `主动搭话[${state.botId}]：${row.text}`)
  try { logger?.info?.(`companion 主动搭话 ${state.botId}：${row.text}`) } catch { /* ignore */ }
}

export function installBotProactive(ctx, { getConfig, getBots, bridge, logger }) {
  let timer = null
  let stopped = false

  async function attempt(bot, { manual = false, targetKey = '' } = {}) {
    const config = getConfig()
    const state = loadState(bot.id, config)
    if (!manual && !state.enabled) return { spoke: false, reason: '这台机器人的主动搭话关着', botId: bot.id }
    if (!manual && state.maxPerDay > 0 && todaySaid(state) >= state.maxPerDay) {
      return { spoke: false, reason: `今天已经开口 ${todaySaid(state)} 次，到上限了`, botId: bot.id }
    }
    if (!manual && state.cooldownMinutes > 0 && state.lastSpokeAt) {
      const minutes = (Date.now() - state.lastSpokeAt) / 60_000
      if (minutes < state.cooldownMinutes) {
        return { spoke: false, reason: `自己刚开过口（${minutes.toFixed(0)} 分钟前）`, botId: bot.id }
      }
    }
    const rows = conversationRows(bridge, bot.id)
    const picked = pickConversation(rows, state, { manual, targetKey })
    if (!picked.record) return { spoke: false, reason: picked.reason, botId: bot.id }
    const record = picked.record
    const idleMinutes = (Date.now() - lastHumanOf(record)) / 60_000
    if (!manual && idleMinutes < state.minIdleMinutes) {
      return { spoke: false, reason: `对方刚说过话（${idleMinutes.toFixed(0)} 分钟前），还不用主动找`, botId: bot.id }
    }
    if (!manual) {
      const hour = new Date().getHours()
      if (inQuietHours(hour, state.quietStart, state.quietEnd)) {
        return { spoke: false, reason: `现在 ${hour} 点在安静时段`, botId: bot.id }
      }
    }
    let agent = null
    try {
      agent = await bridge.ensureAgent(record)
    } catch (error) {
      return { spoke: false, reason: `那个会话现在拉不起来：${error?.message ?? error}`, botId: bot.id }
    }
    if (!agent) return { spoke: false, reason: '那个会话现在拉不起来', botId: bot.id }
    if (agent.status !== undefined && agent.status !== 'idle') {
      return { spoke: false, reason: '会话正忙，先不打扰', botId: bot.id }
    }
    const { bonus, line } = hitLineOf(state)
    let roll = null
    if (!manual) {
      roll = Math.random() * 100
      state.lastRollAt = Date.now()
      state.lastRoll = { at: state.lastRollAt, roll: Math.round(roll * 10) / 10, line: Math.round(line * 10) / 10, bonus, conversation: shortConv(record), hit: false }
      if (roll >= line) {
        state.misses += 1
        const next = hitLineOf(state)
        note(state, `没掷中 ✗ 掷出 ${roll.toFixed(1)}（命中线 ${line.toFixed(1)}）｜下次 ${next.line.toFixed(1)}`, logger)
        return { spoke: false, reason: `没掷中（${roll.toFixed(1)} / ${line.toFixed(1)}）`, botId: bot.id }
      }
      state.misses = 0
      state.lastRoll.hit = true
    }
    // 文案只认这台机器人自己的（新建时会从插件级默认 seed 一份进 proactive.json）；
// 不再在运行时回落到 config.proactive.prompt——那样所有机器人会共用同一句，
// 而设置页上那格是空的，看不到实际发的是什么。
    const text = String(state.prompt || '').trim()
    if (!text) return { spoke: false, reason: '触发文案是空的', botId: bot.id }
    try {
      await bridge.deliverProactive(record, agent, text)
      const now = Date.now()
      state.lastSpokeAt = now
      state.saidAt = [...state.saidAt, now].slice(-300)
      note(state, `${manual ? '手动' : '掷中'} ✓ 在 ${shortConv(record)} 开口：${text.slice(0, 60)}`, logger)
      return { spoke: true, conversation: shortConv(record), text, botId: bot.id }
    } catch (error) {
      note(state, '开口失败：' + (error?.message ?? error), logger)
      return { spoke: false, reason: String(error?.message ?? error), botId: bot.id }
    }
  }

  async function tick() {
    if (stopped) return
    const config = getConfig()
    for (const bot of getBots?.() ?? []) {
      try {
        const state = loadState(bot.id, config)
        if (!state.enabled) continue
        const interval = Math.max(1, state.intervalMinutes) * 60_000
        if (state.lastTickAt && Date.now() - state.lastTickAt < interval) continue
        state.lastTickAt = Date.now()
        saveState(state)
        await attempt(bot, { manual: false })
      } catch (error) {
        appendLog(PATHS.diag, `主动搭话[${bot.id}] 出错：${error?.message ?? error}`)
      }
    }
  }

  function start() {
    stopped = false
    timer = ctx.interval(() => { void tick() }, 30_000)
    ctx.effect(() => () => stop())
  }

  function stop() {
    stopped = true
    try { timer?.() } catch { /* ignore */ }
    timer = null
  }

  function status(botId = '') {
    const config = getConfig()
    const bots = getBots?.() ?? []
    const bot = bots.find((row) => row.id === botId) || bots[0]
    if (!bot) return { enabled: false, botId: '', conversations: [], logs: [] }
    const state = loadState(bot.id, config)
    const { line, bonus } = hitLineOf(state)
    const rows = conversationRows(bridge, bot.id)
    const now = Date.now()
    return {
      botId: bot.id,
      botName: bot.name,
      enabled: state.enabled,
      intervalMinutes: state.intervalMinutes,
      hitLine: state.hitLine,
      missBonus: state.missBonus,
      bonusCap: state.bonusCap,
      quietStart: state.quietStart,
      quietEnd: state.quietEnd,
      prompt: state.prompt,
      quiet: `${state.quietStart}:00 - ${state.quietEnd}:00`,
      line: Math.round(line * 10) / 10,
      baseLine: state.hitLine,
      bonus,
      misses: state.misses,
      lastSpokeAt: state.lastSpokeAt,
      lastRoll: state.lastRoll,
      saidToday: todaySaid(state),
      maxPerDay: state.maxPerDay,
      minIdleMinutes: state.minIdleMinutes,
      cooldownMinutes: state.cooldownMinutes,
      conversations: rows.map((row) => {
        const proactive = proactiveOf(row)
        return {
          key: row.key,
          title: row.title,
          channel: row.channel,
          scope: row.scope,
          peerId: row.peerId,
          lastHumanAt: row.lastHumanAt,
          idleMinutes: Math.round(((now - lastHumanOf(row)) / 60_000) * 10) / 10,
          proactive: {
            enabled: proactive.enabled === true,
            lastSpokeAt: Number(proactive.lastSpokeAt) || 0,
          },
          coolingDown: coolingDown(row, state.cooldownMinutes, now),
        }
      }),
      logs: state.logs.slice(-40),
    }
  }

  return {
    start,
    stop,
    tick,
    status,
    trigger: (botId = '', targetKey = '') => {
      const bots = getBots?.() ?? []
      const bot = bots.find((row) => row.id === botId) || bots[0]
      if (!bot) return Promise.resolve({ spoke: false, reason: '还没有机器人' })
      return attempt(bot, { manual: true, targetKey })
    },
    update(botId, patch = {}) {
      const bots = getBots?.() ?? []
      const bot = bots.find((row) => row.id === botId)
      if (!bot) throw new Error('机器人不存在')
      const state = loadState(bot.id, getConfig())
      const allowed = ['enabled', 'intervalMinutes', 'hitLine', 'missBonus', 'bonusCap', 'quietStart', 'quietEnd', 'minIdleMinutes', 'cooldownMinutes', 'maxPerDay', 'prompt']
      for (const key of allowed) {
        if (patch[key] !== undefined) state[key] = patch[key]
      }
      saveState(state)
      return status(bot.id)
    },
  }
}
