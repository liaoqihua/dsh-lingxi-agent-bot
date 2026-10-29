// 灵犀 · 时间上下文
//
// 自主开口（主动搭话、定时激活）走的是 followup：一条消息直接塞进会话，
// 不像真人消息那样带宿主准备的回合上下文，所以**没有任何时钟信息**。
// 模型没有当前时刻就只能猜，于是出现「现在都半夜了吧」「今天星期几来着」这种时间幻觉。
//
// 这里的取舍：时间写在注入正文里（消息体），而不是在系统提示词里加一块「现在几点」。
//   · 系统提示词是装配级的、与具体这一轮无关；而「我这会儿开口」的时间点只对这一条消息有效。
//   · 写在正文里，时间戳和「这条消息是什么」在同一处，模型不会把两者错配。
//   · 也顺手解决了一个语义问题：这条注入是「我自己想说话」，不是对方说的；正文里说清楚，
//     比让模型从 source.kind 里猜可靠。
//
// 纯函数，不读全局状态，测试直接调。
import { dayKey } from './util.js'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const pad = (n) => String(n).padStart(2, '0')

/** 本机时区名（拿不到就空串，宁可少写也不要写错）。 */
function zoneName() {
  try {
    return String(Intl.DateTimeFormat().resolvedOptions().timeZone || '')
  } catch {
    return ''
  }
}

/** 相对 UTC 的偏移文案，东八区是 UTC+08:00。 */
export function utcOffsetText(ms = Date.now()) {
  // getTimezoneOffset 是「本地比 UTC 早多少分钟」，符号与直觉相反。
  const minutes = -new Date(ms).getTimezoneOffset()
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** 时区文案：`Asia/Shanghai，UTC+08:00`（没有时区名时只给偏移）。 */
export function zoneText(ms = Date.now()) {
  const name = zoneName()
  const offset = utcOffsetText(ms)
  return name ? `${name}，${offset}` : offset
}

/**
 * 带星期与秒的本地时刻：`2026-10-29 周四 17:52:31`。
 * 秒是刻意保留的——「刚刚」「两分钟前」这类判断靠分钟粒度会漂。
 */
export function clockText(ms = Date.now()) {
  const d = new Date(ms)
  return `${dayKey(ms)} ${WEEKDAYS[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 一天里的时段，给模型一个不用自己算的口语锚点。 */
export function dayPart(hour) {
  const h = ((Math.round(Number(hour) || 0) % 24) + 24) % 24
  if (h < 5) return '凌晨'
  if (h < 8) return '早上'
  if (h < 11) return '上午'
  if (h < 13) return '中午'
  if (h < 17) return '下午'
  if (h < 19) return '傍晚'
  if (h < 23) return '晚上'
  return '深夜'
}

export function dayPartText(ms = Date.now()) {
  return dayPart(new Date(ms).getHours())
}

/**
 * 人话时长：不到 1 分钟 / 43 分钟 / 3 小时 5 分钟 / 2 天 4 小时。
 * 只保留两级，再细的数字对方也不会去核。负数按 0 处理。
 */
export function humanDuration(ms) {
  const total = Math.max(0, Number(ms) || 0)
  const minutes = Math.floor(total / 60_000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes > 0 ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours > 0 ? `${days} 天 ${restHours} 小时` : `${days} 天`
}

/** `3 小时 5 分钟前`；没有时间点（0）返回空串，让调用方决定写什么。 */
export function agoText(at, now = Date.now()) {
  const ms = Number(at) || 0
  if (!ms) return ''
  return `${humanDuration(now - ms)}前`
}

/** 注入正文里「由头」的起始标记：上下文块与真正的念头靠它分界。 */
export const PROMPT_MARKER = '[想开口的由头]'

/**
 * 时间两行：`now:` + `part_of_day:`。
 * 入站与自主开口共用这一处，两个入口的格式就不会漂。
 */
export function nowLines(now = Date.now()) {
  return [`now: ${clockText(now)}（${zoneText(now)}）`, `part_of_day: ${dayPartText(now)}`]
}

const CONTEXT_BLOCK = /<companion_context>[\s\S]*?<\/companion_context>\s*/g

/**
 * 去掉注入的来源块，只留对方真正说的话。
 *
 * 回合收尾（记忆提炼、心情判断）不该把 `now:` 当成对方说的字；
 * 整段丢进去只会提炼出「对方提到了 companion_context」这种回声。
 */
export function stripCompanionContext(input) {
  const text = String(input ?? '')
  if (!text.includes('<companion_context>')) return text
  return text.replace(CONTEXT_BLOCK, '').trim()
}

/**
 * 一条 user 消息里「真正的正文」。
 *
 * 入站消息带来源块、主动搭话带来源块 + 由头标记；凡是要把内容当成
 * 「对方说的话」去引用/提炼/判断的地方，都该先过这一道。
 */
export function spokenTextOf(input) {
  return proactivePromptOf(stripCompanionContext(input))
}

/**
 * 从注入正文里取回机器人配置的那句「由头」。
 *
 * 回合收尾（记忆提炼、心情判断）拿到的「对方说的话」不能是整段注入：
 * 里面的 now / last_human 是我们自己写进去的背景，当成对方说的话去提炼，
 * 只会记下「对方说了 companion_context」这种自我回声。
 * 找不到标记时原样返回——拼装格式变了也不至于把正文吞成空串。
 */
export function proactivePromptOf(injected) {
  const text = String(injected ?? '')
  const index = text.indexOf(PROMPT_MARKER)
  if (index < 0) return text.trim()
  return text.slice(index + PROMPT_MARKER.length).trim()
}

/**
 * 主动搭话的注入正文。
 *
 * @param {object} input
 * @param {object} input.record   会话记录（用 scope / lastHumanAt / proactive.lastSpokeAt）
 * @param {string} input.promptText 机器人配置的那句「由头」
 * @param {number} input.now      当前时刻（测试可注入）
 * @returns {string}
 */
export function proactiveBody({ record = {}, promptText = '', now = Date.now() } = {}) {
  const group = record?.scope === 'group'
  const who = group ? '群里' : '对方'
  const body = String(promptText ?? '')

  const lines = [
    '<companion_context>',
    'kind: proactive',
    ...nowLines(now),
  ]

  const lastHuman = Number(record?.lastHumanAt) || 0
  lines.push(lastHuman > 0
    ? `last_human: ${clockText(lastHuman)}（${agoText(lastHuman, now)}，${who}最后一条消息）`
    : `last_human: ${who}还没在这个聊天里说过话`)

  const lastProactive = Number(record?.proactive?.lastSpokeAt) || 0
  if (lastProactive > 0) {
    lines.push(`last_proactive: ${clockText(lastProactive)}（${agoText(lastProactive, now)}，我上次在这里主动开口）`)
  }
  lines.push('</companion_context>')

  lines.push(group
    ? '（这是我自己此刻想在群里开口的由头，不是群里刚有人说话。现在就是上面 now 那一刻；说到几点、今天几号、星期几、隔了多久，一律以上面的时间为准，不要自己推算。）'
    : '（这是我自己此刻想找对方说话的由头，不是对方刚发来的消息。现在就是上面 now 那一刻；说到几点、今天几号、星期几、隔了多久，一律以上面的时间为准，不要自己推算。）')

  if (body) {
    lines.push('')
    lines.push(PROMPT_MARKER)
    lines.push(body)
  }
  return lines.join('\n')
}
