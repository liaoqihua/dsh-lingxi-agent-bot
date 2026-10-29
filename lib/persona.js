// 灵犀 · 机器人人格
//
// 人格只属于机器人：每个 bot 一份 bots/<botId>/persona.md。
// 普通 DSH 会话没有 companion 人格；全局/项目/AGENT.md 那套机制已移除。
import { PATHS } from './config.js'
import { appendLog } from './util.js'
import { noteInjection } from './injection-health.js'

export const MAX_PERSONA_CHARS = 30_000

/** 注册机器人人格注入。返回 disposer。 */
export function installPersonaInjection(ctx, getConfig, { getBotForSession, getBotPersona } = {}) {
  try {
    return ctx.systemPrompt.context({
      name: 'companion:persona',
      order: getConfig().persona.order,
      // required：预设的 includeRuntimeContext:false 只抑制「可选」上下文，
      // 标了 required 就拿不掉机器人的人格。
      required: true,
      text: (assembly) => {
        noteInjection(assembly?.agent?.session?.id ?? assembly?.session?.id ?? '', 'companion:persona')
        try {
          const sessionId = assembly?.agent?.session?.id ?? assembly?.session?.id ?? ''
          const bot = sessionId && getBotForSession ? getBotForSession(sessionId) : null
          if (!bot) return ''
          const text = getBotPersona ? String(getBotPersona(bot) ?? '') : ''
          return text.slice(0, MAX_PERSONA_CHARS)
        } catch (error) {
          appendLog(PATHS.diag, '人格注入失败：' + (error?.message ?? error))
          return ''
        }
      },
    })
  } catch (error) {
    appendLog(PATHS.diag, '人格注入注册失败（可能重复装载）：' + (error?.message ?? error))
    return () => {}
  }
}
