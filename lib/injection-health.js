// 灵犀 · 注入健康检查
//
// 为什么需要这层：Agent Preset 是「这个 agent 的权威装配」，它**可以合法地**拿走我们
// 贡献的东西。两条已知路径：
//   · `@deepseek-ai/dsh-persona` 配 `includeRuntimeContext: false` → 调用
//     `suppressRuntimeContext()`，而它只抑制「可选」上下文（context）；
//   · 同一行配 `complete: true` → 该前缀被恢复成唯一段落，所有 **section** 被顶掉。
// 灵犀的对策分两步：
//   ① 核心状态一律用 `context` 注册并标 `required: true`（抑制器动不了，见各注入模块）；
//   ② 用这一层把「还是被谁拿掉了」变成可见事实：注入函数被调用就记一笔，回合结束时
//      一笔都没有，就说明这一轮的装配里根本没有我们的上下文。
// 于是用户的任意预设都不会让机器人静默失去人格/记忆/心情——最多让日志与状态页说出来。
import { PATHS } from './config.js'
import { appendLog } from './util.js'

/** 灵犀贡献的全部提示词注入；少任何一个都算异常。 */
export const EXPECTED_INJECTIONS = Object.freeze([
  'companion:persona',
  'companion:memory',
  'companion:mood',
  'companion:guide',
  // 能力清单：工具注册只让模型「知道有工具」，这一段补「什么时候用、这会儿哪些用不了」。
  'companion:capabilities',
  // 语音注入对非 QQ 机器人返回空串，但注入函数照样会被求值并记账；没记账才算被拿掉。
  'companion:voice',
])

const MARKS_LIMIT = 200
const WARN_INTERVAL_MS = 10 * 60_000

const marks = new Map()
const warnings = new Map()

/** 注入函数被求值时记一笔（无论它最终返回空串还是正文）。 */
export function noteInjection(sessionId, name) {
  const id = String(sessionId ?? '').trim()
  const key = String(name ?? '').trim()
  if (!id || !key) return
  let row = marks.get(id)
  if (!row) {
    row = { names: new Set(), at: 0 }
    marks.set(id, row)
    if (marks.size > MARKS_LIMIT) {
      const oldest = marks.keys().next().value
      if (oldest !== undefined && oldest !== id) marks.delete(oldest)
    }
  }
  row.names.add(key)
  row.at = Date.now()
}

/** 取走并清空某个会话的记账，保证「每轮对账一次」。 */
export function takeInjectionMarks(sessionId) {
  const id = String(sessionId ?? '').trim()
  const row = id ? marks.get(id) : undefined
  if (row) marks.delete(id)
  return { names: row ? [...row.names] : [], at: row?.at ?? 0 }
}

/**
 * 一轮结束后对账。返回 { missing, warned }；missing 为空表示这轮注入正常。
 * @param {{ names?: string[] }} marksRow takeInjectionMarks 的结果
 * @param {{ botId?: string, title?: string, reasonKind?: string }} meta
 */
export function checkInjection(sessionId, marksRow, meta = {}) {
  const id = String(sessionId ?? '').trim()
  const names = new Set(marksRow?.names ?? [])
  const missing = EXPECTED_INJECTIONS.filter((name) => !names.has(name))
  if (!id) return { missing, warned: false }
  if (!missing.length) {
    // 恢复正常就把告警撤掉，状态页不该留着过期的红字。
    warnings.delete(id)
    return { missing, warned: false }
  }
  // 整轮直接失败（例如提示词渲染抛错）且一笔都没有：那一轮可能根本没走到装配，
  // 不拿它当「被预设抑制」的证据。
  if (!names.size && String(meta.reasonKind ?? '') === 'error') {
    return { missing, warned: false }
  }
  const now = Date.now()
  const previous = warnings.get(id)
  const warned = !previous || now - previous.at >= WARN_INTERVAL_MS
  warnings.set(id, {
    at: now,
    missing,
    got: [...names],
    botId: String(meta.botId ?? ''),
    title: String(meta.title ?? ''),
  })
  if (warned) {
    appendLog(
      PATHS.diag,
      `注入被抑制：${meta.title || id} 这一轮没有拿到 ${missing.join('、')}`
      + `（拿到了 ${names.size ? [...names].join('、') : '无'}）`
      + '——通常是有 Agent Preset 抑制了运行上下文，或用了 complete 人设。'
      + (meta.botId ? `机器人 ${meta.botId}。` : ''),
    )
  }
  return { missing, warned }
}

/** 给设置页/状态接口看的快照：现在有哪些会话的注入被拿掉了。 */
export function injectionHealth() {
  return [...warnings.entries()]
    .map(([sessionId, row]) => ({
      sessionId,
      botId: row.botId,
      title: row.title,
      missing: [...row.missing],
      got: [...row.got],
      at: row.at,
    }))
    .sort((a, b) => b.at - a.at)
}

/** 测试用：清空内存态。 */
export function resetInjectionHealth() {
  marks.clear()
  warnings.clear()
}