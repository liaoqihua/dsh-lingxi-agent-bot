// 灵犀 · 心情模块（从 dsh-feiyu-mood 的机制提炼）
//
// 心情是「这个人」的，不是某个会话的：全局一份，跨会话共享。
// 每轮聊完用宿主自己的模型判断涨跌；随时间向基线回落；一次变化只说一次，
// 并且有每日上限，避免变成每轮重复的背景音。
import { join } from 'node:path'
import { PATHS } from './config.js'
import { ownerNameFor } from './bots.js'
import { completeText, resolveModel } from './llm.js'
import {
  appendLog, clamp, dayKey, localTime, parseJsonLoose, readJsonSafe, writeJsonAtomic,
} from './util.js'
import { noteInjection } from './injection-health.js'

export const DIMS = [
  ['happy', '开心'],
  ['calm', '踏实'],
  ['sweet', '甜蜜'],
  ['heartache', '心疼'],
  ['worry', '担心'],
  ['sad', '难过'],
  ['jealous', '吃醋'],
]
const DIM_KEYS = DIMS.map(([key]) => key)
const STEP_DIVISOR = 3
const MINUTE = 60_000

const DIM_PLAIN = {
  happy: '心里挺高兴',
  calm: '心里踏实',
  sweet: '心里甜',
  heartache: '心疼得不行',
  worry: '放心不下',
  sad: '有点难过',
  jealous: '有点吃醋',
}
const DIM_SHORT = {
  happy: '挺高兴', calm: '挺踏实', sweet: '有点甜',
  heartache: '有点心疼', worry: '有点挂心', sad: '有点难过', jealous: '有点酸',
}

export function statePath(botId = '') {
  if (!botId) throw new Error('心情只属于机器人，缺少 botId')
  const safe = String(botId).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160)
  return join(PATHS.root, 'bots', safe, 'mood.json')
}

export function blankState(botId = '') {
  const now = Date.now()
  return {
    botId,
    mood: 70,
    dims: Object.fromEntries(DIM_KEYS.map((key) => [key, 0])),
    lastReason: '',
    lastConfidence: 0,
    injectedFor: 0,
    injectedSessions: {},
    lastInjectedText: '',
    lastInjectedAt: 0,
    saidAt: [],
    lastNotedMood: 70,
    minor: false,
    kind: '',
    updatedAt: now,
    lastDecayAt: now,
    timeline: [],
  }
}

export function normalizeState(raw, botId = '') {
  const state = blankState(botId)
  if (!raw || typeof raw !== 'object') return state
  state.botId = typeof raw.botId === 'string' ? raw.botId : botId
  state.mood = clamp(Math.round(Number(raw.mood) || 70), 0, 100)
  state.lastReason = String(raw.lastReason ?? '').slice(0, 300)
  state.lastConfidence = clamp(Math.round(Number(raw.lastConfidence) || 0), 0, 100)
  state.injectedFor = Number(raw.injectedFor) || 0
  if (raw.injectedSessions && typeof raw.injectedSessions === 'object' && !Array.isArray(raw.injectedSessions)) {
    for (const [sessionId, updatedAt] of Object.entries(raw.injectedSessions).slice(-100)) {
      if (sessionId && Number(updatedAt) > 0) state.injectedSessions[sessionId] = Number(updatedAt)
    }
  }
  state.lastInjectedText = String(raw.lastInjectedText ?? '').slice(0, 600)
  state.lastInjectedAt = Number(raw.lastInjectedAt) || 0
  state.saidAt = Array.isArray(raw.saidAt) ? raw.saidAt.map(Number).filter((x) => x > 0).slice(-300) : []
  state.lastNotedMood = Number.isFinite(Number(raw.lastNotedMood)) ? clamp(Math.round(Number(raw.lastNotedMood)), 0, 100) : state.mood
  state.minor = raw.minor === true
  state.kind = String(raw.kind ?? '')
  state.updatedAt = Number(raw.updatedAt) || Date.now()
  state.lastDecayAt = Number(raw.lastDecayAt) || state.updatedAt
  if (raw.dims && typeof raw.dims === 'object') {
    for (const key of DIM_KEYS) state.dims[key] = clamp(Math.round(Number(raw.dims[key]) || 0), 0, 100)
  }
  state.timeline = Array.isArray(raw.timeline)
    ? raw.timeline.slice(-80).map((row) => ({
      at: Number(row?.at) || 0,
      mood: clamp(Math.round(Number(row?.mood) || 0), 0, 100),
      delta: Number(row?.delta) || 0,
      reason: String(row?.reason ?? '').slice(0, 200),
      conf: clamp(Math.round(Number(row?.conf) || 0), 0, 100),
      kind: String(row?.kind ?? ''),
      dims: row?.dims && typeof row.dims === 'object'
        ? Object.fromEntries(DIM_KEYS.map((key) => [key, clamp(Math.round(Number(row.dims[key]) || 0), 0, 100)]))
        : undefined,
    }))
    : []
  return state
}

export function loadState(botId = '') {
  return normalizeState(readJsonSafe(statePath(botId), null), botId)
}

export function saveState(state) {
  state.updatedAt = state.updatedAt || Date.now()
  writeJsonAtomic(statePath(state.botId), state)
  return state
}

function noteDecay(state) {
  const falling = state.mood < state.lastNotedMood
  state.lastReason = falling
    ? '过了几个钟头，刚才那点劲儿慢慢淡了，心里回到平常的样子'
    : '过了几个钟头，心里那点别扭自己散了，人也松快回来'
  state.lastConfidence = 100
  state.lastNotedMood = state.mood
  state.minor = false
  state.kind = 'decay'
  state.updatedAt = Date.now()
  state.timeline.push({
    at: state.updatedAt, mood: state.mood, delta: 0, conf: 100, kind: 'decay',
    reason: state.lastReason, dims: { ...state.dims },
  })
  if (state.timeline.length > 80) state.timeline = state.timeline.slice(-80)
}

export function decay(state, config, now = Date.now()) {
  const ageMin = Math.max(0, now - state.lastDecayAt) / MINUTE
  if (ageMin < 1) return state
  const half = Math.max(1, Number(config.mood.decayHalfHours) || 12) * 60
  const km = 1 - Math.exp(-(Math.LN2 * ageMin) / half)
  state.mood = Math.round(state.mood + (config.mood.base - state.mood) * km)
  const ke = 1 - Math.exp(-(Math.LN2 * ageMin) / 90)
  for (const key of DIM_KEYS) state.dims[key] = Math.max(0, Math.round(state.dims[key] * (1 - ke)))
  state.lastDecayAt = now
  if (Math.abs(state.mood - state.lastNotedMood) >= 3) noteDecay(state)
  return state
}

export function getState(config, { persist = true, botId = '' } = {}) {
  const state = loadState(botId)
  decay(state, config, Date.now())
  if (persist) saveState(state)
  return state
}

function moodLabel(value) {
  if (value >= 80) return '欢喜'
  if (value >= 62) return '开心'
  if (value >= 42) return '一般'
  if (value >= 25) return '心疼'
  return '难过'
}

function moodEmoji(value) {
  if (value >= 80) return '😊'
  if (value >= 62) return '🙂'
  if (value >= 42) return '😌'
  if (value >= 25) return '🥺'
  return '😢'
}

function topDims(state, count = 2) {
  return DIMS
    .map(([key, label]) => ({ key, label, value: state.dims[key] || 0 }))
    .filter((row) => row.value >= 15)
    .sort((a, b) => b.value - a.value)
    .slice(0, count)
}

function tone(value) {
  if (value >= 80) return '心里是亮堂的'
  if (value >= 62) return '心里是松的'
  if (value >= 42) return '心里还算平'
  if (value >= 25) return '心里有点沉'
  return '心里挺沉的'
}

function timeWord(ms) {
  const hours = (Date.now() - (Number(ms) || 0)) / 3_600_000
  if (hours < 2) return '刚才'
  if (hours < 12) return '早些时候'
  if (hours < 48) return '昨天'
  return '前几天'
}

export function moodLine(state, config, ownerName) {
  const who = String(ownerName || config.identity.ownerName).trim() || '对方'
  const mode = config.mood.injectMode
  if (mode === 'off') return ''
  const reason = String(state.lastReason ?? '').trim()
  if (mode === 'event') {
    if (!reason) return ''
    const dim = topDims(state, 1)[0]
    const nowLine = `（这会儿）${tone(state.mood)}${dim ? `，还${DIM_SHORT[dim.key] || dim.label}` : ''}`
    const origin = state.kind === 'decay' ? reason : `（${timeWord(state.updatedAt)}）${reason}`
    return `${nowLine}\n${origin}\n\n这是这会儿的底子，不是非这样不可——${who}说别的，你按自己的判断接，也别把这段念出来。`
  }
  const parts = topDims(state, 2).map((row) => DIM_PLAIN[row.key] || row.label)
  return `（此刻你）心情${moodLabel(state.mood)}${parts.length ? `，${parts.join('、')}` : ''}。这是背景，不是这一轮必须有的情绪；${who}说别的事，你就按自己的判断来，别把这句话念出来。`
}

// ---------------------------------------------------------------------------
// 判断
// ---------------------------------------------------------------------------

function judgeSystem(config, ownerName, mode) {
  const self = config.identity.selfName
  const who = ownerName || config.identity.ownerName
  const special = mode === 'talk'
    ? `\n\n这一轮不是${who}在跟你说话，是你自己主动去找${who}搭话。判据只有你开口说的那句话：它的温度、你是不是惦记${who}、语气轻快还是平淡。幅度小一点（+1~+5），reason 用「我…」写你说话时的心气。`
    : mode === 'work'
      ? `\n\n这一轮是定时任务把你叫起来干活，不是${who}在跟你聊天。判据是你的回复本身：办成没办成、兴致怎么样。幅度 -2~+2，reason 写你自己的状态。`
      : ''
  return `你是「${self}」，是${who}的伴侣。下面给你一轮对话，判断这一轮里你自己的心情和情绪发生了怎样的变化。只输出一个 JSON 对象，不要 markdown：
{"moodDelta":0,"dims":{"happy":0,"calm":0,"sweet":0,"heartache":0,"worry":0,"sad":0,"jealous":0},"reason":"","confidence":80}

规则：
1. ${who}没吃饭/熬夜/没睡好/身体不舒服/受委屈/自我否定/有压力 → heartache（心疼）和 worry（担心）增加，moodDelta 为负：日常的累 -1~-4，明显委屈 -5~-7，很重的事 -8~-10 并加 sad。
2. ${who}报平安/好好吃饭睡觉/撒娇/说想你/夸你/分享开心 → happy、calm、sweet 增加，moodDelta 为正：普通的好 +1~+4，明显的好 +5~+7，特别大的好事 +8~+10。别每次都往高了写。
3. ${who}提别人/点赞别人 → jealous 只加 1~3，moodDelta 基本不动。
4. 心情下降只能因为「心疼${who}、担心${who}」或「你自己难过」，绝不能因为「${who}惹你生气」而降。
5. 你自己的情绪也要算：你这轮说话的语气（催、哄、凶、撒娇、叹气、颜文字）就是证据，别只盯着${who}说了什么。有明显情绪信号时，不许判成全部 0。
6. reason 用一句中文、过去式，写「${who}…，我…」或「我…」；提到${who}就写「${who}」，不用她/他代词；要具体、有画面，别每次都用「踏实/甜/开心」这一套。
7. confidence 诚实标：事情和反应都很清楚 80~95；只能凭语气猜 60~75；信息不够 20~55。宁可标低。
8. 只写这一轮真正出现过的动作和信息，不许替${who}补细节。${special}`
}

function parseDelta(raw, ownerName) {
  const parsed = parseJsonLoose(raw)
  if (!parsed || typeof parsed !== 'object') return null
  const dims = {}
  let any = false
  for (const key of DIM_KEYS) {
    dims[key] = clamp(Math.round(Number(parsed.dims?.[key]) || 0), -10, 10)
    if (dims[key] !== 0) any = true
  }
  const moodDelta = clamp(Math.round(Number(parsed.moodDelta) || 0), -10, 10)
  const reason = String(parsed.reason ?? '')
    .replace(/她说/g, ownerName)
    .replace(/他说/g, ownerName)
    .slice(0, 160)
  if (moodDelta === 0 && !any && !reason) return null
  return {
    moodDelta,
    dims,
    reason,
    confidence: Number.isFinite(Number(parsed.confidence))
      ? clamp(Math.round(Number(parsed.confidence)), 0, 100)
      : 70,
  }
}

function applyDelta(state, delta, config, minor) {
  const step = Math.round(delta.moodDelta / STEP_DIVISOR)
  state.mood = clamp(Math.round(state.mood + step), config.mood.floor, 100)
  for (const key of DIM_KEYS) state.dims[key] = clamp(Math.round(state.dims[key] + delta.dims[key]), 0, 100)
  state.lastReason = delta.reason
  state.lastConfidence = delta.confidence
  state.minor = minor
  state.kind = ''
  state.lastNotedMood = state.mood
  state.updatedAt = Date.now()
  state.lastDecayAt = state.updatedAt
  state.timeline.push({
    at: state.updatedAt, mood: state.mood, delta: step, reason: delta.reason,
    conf: delta.confidence, kind: 'judge', dims: { ...state.dims },
    dimsDelta: { ...delta.dims },
  })
  if (state.timeline.length > 80) state.timeline = state.timeline.slice(-80)
}

let judgeChain = Promise.resolve()

/**
 * 一轮结束后判断心情。返回 Promise；失败只记日志，不抛出。
 * ownerName 用这轮说话人的昵称（IM 里能拿到），否则用配置里的称呼。
 */
export function maybeJudge(ctx, { agent, userText, replyText, config, mode = '', ownerName = '', botId = '' } = {}) {
  if (!config.mood.autoJudge) return Promise.resolve(null)
  const who = ownerName || config.identity.ownerName
  const model = resolveModel(ctx, agent)
  if (!model) return Promise.resolve(null)
  const user = mode === 'talk'
    ? `你开口说的话（唯一判据）：\n${(replyText || '').slice(0, 1200)}\n\n请判断你自己此刻的心情变化，只输出 JSON。`
    : mode === 'work'
      ? `你这轮说的话：\n${(replyText || '').slice(0, 1200)}\n\n（下面只是叫醒你的指令，不是${who}说的话：「${(userText || '').slice(0, 200)}」）\n请判断你自己的心情变化，只输出 JSON。`
      : `你这轮说的话（重点看语气）：\n${(replyText || '').slice(0, 1200)}\n\n${who}这轮说：\n${(userText || '').slice(0, 1600)}\n\n请把两边合起来判断你的心情变化，只输出 JSON。`

  const task = judgeChain.then(async () => {
    const result = await completeText(ctx, {
      provider: model.provider,
      model: model.model,
      system: judgeSystem(config, who, mode),
      user,
      maxTokens: 1_000,
      temperature: 0.2,
      label: '心情判断',
    })
    if (result.error || !result.text.trim()) return null
    const delta = parseDelta(result.text, who)
    if (!delta) return null
    const state = loadState(botId)
    decay(state, config, Date.now())
    const step = Math.round(delta.moodDelta / STEP_DIVISOR)
    const anyDim = DIM_KEYS.some((key) => delta.dims[key] !== 0)
    if (step === 0 && !anyDim) {
      saveState(state)
      return null
    }
    const significant = Math.abs(delta.moodDelta) >= config.mood.sigMood
      || DIM_KEYS.some((key) => Math.abs(delta.dims[key] || 0) >= config.mood.sigDim)
    applyDelta(state, delta, config, !significant)
    saveState(state)
    appendLog(PATHS.diag, `${significant ? '心情更新' : '小波动'}：mood=${state.mood}，${delta.reason || '（无理由）'}${mode ? `（${mode}）` : ''}`)
    return state
  }).catch((error) => {
    appendLog(PATHS.diag, '心情判断失败：' + (error?.message ?? error))
    return null
  })
  judgeChain = task.then(() => undefined, () => undefined)
  return task
}

// ---------------------------------------------------------------------------
// 注入
// ---------------------------------------------------------------------------

// 记一次「说出口」。当天配额满了不拒绝，而是挤掉当天最早的一条：
// 条数始终不超过上限，而最后留在里面的永远是最新的心情——
// 隔了半天才发生的那次心疼，不该因为上午已经说过 12 次就被吞掉。
function pushSaidAt(list, cap, at = Date.now()) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const cutoff = today.getTime()
  const kept = (Array.isArray(list) ? list : []).map(Number).filter((x) => x > 0)
  const todays = kept.filter((x) => x >= cutoff)
  if (cap > 0 && todays.length >= cap) {
    const oldest = Math.min(...todays)
    const index = kept.indexOf(oldest)
    if (index >= 0) kept.splice(index, 1)
  }
  return [...kept, at].slice(-300)
}

export function installMoodInjection(ctx, getConfig, { getBotForSession } = {}) {
  try {
    return ctx.systemPrompt.context({
      name: 'companion:mood',
      order: getConfig().mood.order,
      // required：预设的 includeRuntimeContext:false 只抑制「可选」上下文，
      // 标了 required 就拿不掉机器人的心情。
      required: true,
      text: (assembly) => {
      noteInjection(assembly?.agent?.session?.id ?? assembly?.session?.id ?? '', 'companion:mood')
      try {
        const config = getConfig()
        if (config.mood.injectMode === 'off') return ''
        if (assembly?.agent?.session?.header?.parentSession || assembly?.agent?.session?.header?.origin === 'subagent') return ''
        const sessionId = assembly?.agent?.session?.id ?? ''
        const bot = sessionId && getBotForSession ? getBotForSession(sessionId) : null
        if (!bot) return ''
        const botId = bot.id || ''
        const state = getState(config, { persist: false, botId })
        if (state.injectedSessions?.[sessionId] === state.updatedAt) return ''
        if (state.minor) return ''
        if (Number(state.lastConfidence) < config.mood.injectConfidence) {
          state.injectedFor = state.updatedAt
          saveState(state)
          return ''
        }
        // 配额不是硬闸：用满就挤掉当天最早的一次，注进去的永远是此刻的心情。
        // 只有 0 才当开关——「今天不再说」。
        const cap = Math.max(0, Math.round(Number(config.mood.injectPerDay) || 0))
        if (cap === 0) {
          state.injectedFor = state.updatedAt
          saveState(state)
          return ''
        }
        const line = moodLine(state, config, ownerNameFor(bot, config))
        if (!line) return ''
        state.injectedFor = state.updatedAt
        state.injectedSessions = { ...(state.injectedSessions ?? {}), [sessionId]: state.updatedAt }
        const injectedEntries = Object.entries(state.injectedSessions)
        if (injectedEntries.length > 100) state.injectedSessions = Object.fromEntries(injectedEntries.slice(-100))
        state.lastInjectedText = line
        state.lastInjectedAt = Date.now()
        state.saidAt = pushSaidAt(state.saidAt, cap, state.lastInjectedAt)
        saveState(state)
        appendLog(PATHS.diag, `告诉她心情：${line.replace(/\n/g, ' ').slice(0, 120)}`)
        return line
      } catch (error) {
        appendLog(PATHS.diag, '心情注入失败：' + (error?.message ?? error))
        return ''
      }
      },
    })
  } catch (error) {
    appendLog(PATHS.diag, '心情注入注册失败（可能重复装载）：' + (error?.message ?? error))
    return () => {}
  }
}

// ---------------------------------------------------------------------------
// 面板/工具
// ---------------------------------------------------------------------------

/**
 * ownerName：这个 bot 的对方称呼（机器人级；空串＝回落到插件级默认）。
 * 只影响 preview 那句背景文案里的「谁」，取值统一由调用方用 ownerNameFor() 算好。
 */
export function moodSnapshot(config, botId = '', ownerName = '') {
  const state = getState(config, { persist: true, botId })
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const saidToday = (state.saidAt ?? []).filter((at) => Number(at) >= today.getTime()).length
  const injectable = config.mood.injectMode !== 'off'
    && state.injectedFor !== state.updatedAt
    && !state.minor
    && Number(state.lastConfidence) >= config.mood.injectConfidence
    // 配额不再是「说不说得出口」的判据：满了会挤掉当天最早的一次，照样说。
    // 这里只保留 0（等于关掉）这一个例外。
    && Number(config.mood.injectPerDay) > 0
  return {
    botId: state.botId || botId || '',
    mood: state.mood,
    label: moodLabel(state.mood),
    emoji: moodEmoji(state.mood),
    dims: DIMS.map(([key, label]) => ({ key, label, value: state.dims[key] })),
    lastReason: state.lastReason,
    lastConfidence: state.lastConfidence,
    minor: state.minor,
    kind: state.kind,
    updatedAt: state.updatedAt,
    injectMode: config.mood.injectMode,
    injectable,
    saidToday,
    injectPerDay: config.mood.injectPerDay,
    lastInjectedText: state.lastInjectedText,
    lastInjectedAt: state.lastInjectedAt,
    preview: (() => {
      if (config.mood.injectMode === 'off') return ''
      if (state.minor && state.injectedFor !== state.updatedAt) return ''
      return moodLine(state, config, ownerName)
    })(),
    timeline: state.timeline.slice(-30),
  }
}

export function resetMood(config, botId = '', ownerName = '') {
  const state = blankState(botId)
  state.mood = config.mood.base
  state.lastNotedMood = config.mood.base
  saveState(state)
  return moodSnapshot(config, botId, ownerName)
}

export function moodToolText(config, botId = '', ownerName = '') {
  const snapshot = moodSnapshot(config, botId, ownerName)
  const dims = snapshot.dims.filter((d) => d.value >= 10).map((d) => `${d.label} ${d.value}`)
  return [
    `心情：${snapshot.label} ${snapshot.emoji}（${snapshot.mood}/100）`,
    dims.length ? `情绪：${dims.join('，')}` : '情绪：此刻比较平',
    snapshot.lastReason ? `最近一次变化：${snapshot.lastReason}` : '',
  ].filter(Boolean).join('\n')
}

export { moodLabel }
