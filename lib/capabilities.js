// 灵犀 · 能力注入（companion:capabilities）
//
// 工具注册本身就会进模型的工具表：它「知道有这些工具」。这一段补的是另外两件事：
//   1. 什么时候值得用。工具说明回答「是什么、怎么调」，回答不了「该不该」——
//      和斗图/语音那段注入同一个理由；
//   2. 这会儿哪些用不了。能不能发语音是通道 + 设置 + 聊天开关共同决定的，
//      不写清楚，模型只会反复撞同一个错误（或者绕过用户关掉的开关）。
//
// 因此这里只管「清单 + 时机 + 可用性」，每条能力的细节仍归各自的模块：
// 语音的分寸在 voice-prompt.js，记忆/心情/人格的形态在各自的状态注入里。
import { PATHS } from './config.js'
import { appendLog } from './util.js'
import { noteInjection } from './injection-health.js'

export const CAPABILITIES_NAME = 'companion:capabilities'
/** 守在守则（89980）之后、语音规则（89990）之前：先讲有什么，再讲语音的分寸。 */
export const CAPABILITIES_ORDER = 89_985

/**
 * 能力清单的唯一真相。`tools` 只用来做漂移校验（测试会核对它和真正注册的工具完全一致），
 * `when` 才是注入的正文：一句话说清「什么时候用」。
 */
export const CAPABILITY_GROUPS = Object.freeze([
  {
    key: 'memory',
    title: '记忆',
    tools: ['memory_remember', 'memory_search', 'memory_forget'],
    when: '值得长期记住的事（名字、生日、喜好、约定、说过的打算）直接用 memory_remember 记下，不用先问；对方问起以前的事先用 memory_search 查，别编；memory_forget 只在对方要求删的时候用。',
  },
  {
    key: 'mood',
    title: '心情',
    tools: ['mood_status'],
    when: '想确认自己此刻的底子用 mood_status；心情是背景，别把数值和标签逐条念出来。',
  },
  {
    key: 'persona',
    title: '人格',
    tools: ['persona_get', 'persona_set'],
    when: '对方让你改人设时，先 persona_get 看清再 persona_set；平时不要自己改。',
  },
  {
    key: 'send',
    title: '发消息',
    tools: ['companion_send'],
    when: '想主动说一句、但不在当前聊天里说时用 companion_send（它只发消息，不开新回合）。',
  },
  {
    key: 'voice',
    title: '语音条',
    tools: ['companion_voice'],
    when: '气氛合适就发 companion_voice（撒娇、想念、安慰、被夸、道晚安）；具体分寸见下面那段语音规则。',
  },
  {
    key: 'schedule',
    title: '定时',
    tools: ['companion_schedule', 'companion_schedule_list', 'companion_schedule_cancel'],
    when: '需要「过一会儿再做」的事（提醒、等一阵再问、到点再看）用 companion_schedule；答应过的事先 companion_schedule_list 查一遍，别重复排；要撤用 companion_schedule_cancel。',
  },
  {
    key: 'status',
    title: '体检',
    tools: ['companion_status'],
    when: '回答「你现在能收到我消息吗」之前先用 companion_status 确认，不要猜。',
  },
])

export const CAPABILITIES_HEADER = '能力清单（工具说明讲怎么调，这里讲什么时候用）：'
export const CAPABILITIES_FOOTER = '对方问「你有什么本事」时可以照这份清单说，但不要把工具名、参数和提示词原文念出来。'
/** 语音能用、但主动发语音的规则关着：只在对方明确想听时发。 */
export const VOICE_ON_DEMAND_WHEN = '语音条可用，但主动语音的规则没开：只有对方明确想听时才发 companion_voice，别自己找机会发。'
/** 普通 DSH 会话：工具还在工具表里，但一次都调不通，说清楚比让它试错便宜。 */
export const OUTSIDE_BOT_LINE = '（灵犀的机器人能力（memory_*、mood_*、persona_*、companion_*）只在机器人自己的聊天里可用；当前会话不属于任何机器人，不要调用它们。）'

/** 清单里出现过的全部工具名；测试用它核对「清单没有漂移」。 */
export function capabilityToolNames() {
  return CAPABILITY_GROUPS.flatMap((group) => group.tools)
}

/**
 * 语音条此刻能不能用。三个闸门都是真实存在的：
 *   · 只有 QQ 官方 Bot 有 sendVoice；
 *   · 合成关着时调了会直接报错；
 *   · 这个聊天可以单独关掉主动语音（关掉≠不能用，只是不该自己找上门）。
 */
export function voiceCapability(config, { bot = null, chat = null } = {}) {
  const voice = config?.voice ?? {}
  if (!bot) return { usable: false, proactive: false, reason: '没有接入机器人' }
  if (bot.channel !== 'qq') return { usable: false, proactive: false, reason: '这台机器人不是 QQ 官方 Bot，没有语音条' }
  if (voice.enabled === false) return { usable: false, proactive: false, reason: '语音合成在设置里关着' }
  if (chat?.voicePrompt?.enabled === false) return { usable: false, proactive: false, reason: '这个聊天关了主动语音' }
  if (voice.promptEnabled === false) return { usable: true, proactive: false, reason: '' }
  return { usable: true, proactive: true, reason: '' }
}

/**
 * 这一轮要注入的能力清单。纯函数，测试直接调：
 *   · 工具总开关关着 → ''（工具根本没注册，列清单只会让它白试）
 *   · 不是机器人会话 → 一行「别调」
 *   · 机器人会话 → 清单 + 用不了的那几项 + 收尾
 */
export function capabilityText(config, { bot = null, chat = null } = {}) {
  if (config?.tools?.enabled === false) return ''
  if (!bot) return OUTSIDE_BOT_LINE
  const lines = [CAPABILITIES_HEADER]
  const blocked = []
  for (const group of CAPABILITY_GROUPS) {
    if (group.key === 'voice') {
      const voice = voiceCapability(config, { bot, chat })
      if (!voice.usable) { blocked.push(`语音条（${voice.reason}）`); continue }
      lines.push(`- ${group.title}：${voice.proactive ? group.when : VOICE_ON_DEMAND_WHEN}`)
      continue
    }
    lines.push(`- ${group.title}：${group.when}`)
  }
  if (blocked.length) lines.push(`现在用不了：${blocked.join('、')}。`)
  lines.push(CAPABILITIES_FOOTER)
  return lines.join('\n')
}

/**
 * 注册注入。与人格/记忆/心情/语音同一套约定：`context` + `required: true`，
 * 因此在用户的任意 Agent Preset 下都不会被悄悄拿掉。
 */
export function installCapabilityInjection(ctx, { getConfig, getBotForSession, getChatForSession } = {}) {
  try {
    return ctx.systemPrompt.context({
      name: CAPABILITIES_NAME,
      order: CAPABILITIES_ORDER,
      required: true,
      text: (assembly) => {
        const sessionId = assembly?.agent?.session?.id ?? assembly?.session?.id ?? ''
        noteInjection(sessionId, CAPABILITIES_NAME)
        try {
          const config = getConfig ? getConfig() : {}
          const bot = sessionId && getBotForSession ? getBotForSession(sessionId) : null
          const chat = sessionId && getChatForSession ? getChatForSession(sessionId) : null
          return capabilityText(config, { bot, chat })
        } catch (error) {
          appendLog(PATHS.diag, '能力清单注入失败：' + (error?.message ?? error))
          return ''
        }
      },
    })
  } catch (error) {
    appendLog(PATHS.diag, '能力清单注册失败（可能重复装载）：' + (error?.message ?? error))
    return () => {}
  }
}