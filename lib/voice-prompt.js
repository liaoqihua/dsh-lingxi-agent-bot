// 灵犀 · 语音提示词注入（companion:voice）
//
// 为什么单独一层：工具说明只回答「这个能力是什么、怎么调」，它不会让模型主动用。
// 斗图之所以积极，是因为 dsh-meme 往系统提示里塞了一整段「主动斗图，不要等用户开口」；
// 语音缺的正是这一段——模型知道有 companion_voice，但没人告诉它「气氛到了就该用声音说话」。
// 所以这里把语音也做成同构的一件事：一段可关、可自定义的注入，按机器人、按通道、按节奏生效。
//
// 三条硬边界（少了任何一条都会把好功能做成噪音）：
//   1. 只有 QQ 官方 Bot 有 sendVoice：别的通道注入一段「去发语音」只会换来工具报错；
//   2. 语音合成关着时给一句「别调」，避免模型反复撞同一个错误；
//   3. 刚发过语音就压一句「先用文字」，否则每一轮都成了语音条（图能扫、语音得听，代价不一样）。
import { join } from 'node:path'

import { PATHS } from './config.js'
import { appendLog, readJsonSafe, writeJsonAtomic } from './util.js'
import { noteInjection } from './injection-health.js'

export const VOICE_PROMPT_NAME = 'companion:voice'
/** 排在守则（89980）之后：操作性的「怎么做」放最后，比背景设定更容易被当成即时指令。 */
export const VOICE_PROMPT_ORDER = 89_990
/** 同一个机器人两条语音之间的最短间隔；只用来在提示里提醒，不是硬拦截。 */
export const VOICE_PACING_MINUTES = 10
/** 自定义提示词的长度上限（config.normalize 里同步截断）。 */
export const MAX_VOICE_PROMPT_CHARS = 2_000

/**
 * 默认语音规则。写法刻意与 dsh-meme 的斗图提示词同构：
 * 先给「主动」的总指令，再给时机、形式、节制、收尾，全部用第二人称的祈使句。
 */
export const DEFAULT_VOICE_PROMPT = [
  '语音规则：主动用声音说话，不要等对方开口：',
  '- 气氛合适就调 companion_voice 发一条语音条：撒娇、想念、安慰、被夸、道晚安、说情话这类时刻，声音比打字更有温度，不用先问「要不要听」；',
  '- 语音只说口语短句（10~60 字最自然），像面对面讲话：不要念代码、网址、列表、报错和长段落，内容长就只挑最想说的那一句；',
  '- 语音条就是你的回答：正文只留一两个字（「嗯」「在」「晚安」）或者干脆不写，别把念过的话再打一遍，也不要贴音频路径；',
  '- 节制：别连着两条都发语音；对方说正事、赶时间、要步骤或代码时用文字；同一轮也别既发语音又刷表情包——想让人看见就发图，想让人听见就发语音；',
  '- 发完就当话说出口了：不要复述，也不用解释「我刚发了一条语音」。',
].join('\n')

/** 合成关着时的替代说明（比注入整段规则更短，目的只是别让模型白调一次）。 */
export const VOICE_DISABLED_LINE = '语音合成在设置里关着：这一轮不要调用 companion_voice（会直接报错），用文字说话。'

/** 刚发过语音时的压制说明；带上具体分钟数，模型更容易判断是不是该破例。 */
export function voicePacingLine(minutes) {
  return `（提示：上一条语音是 ${minutes} 分钟前发的；这一轮先用文字，除非对方明确想继续听你说话、或者情绪明显更浓。）`
}

/** 记账文件：`bots/<botId>/voice.json`。进程重启后节奏判断仍然有效。 */
export function voiceUsagePath(stateDir) {
  return stateDir ? join(stateDir, 'voice.json') : ''
}

export function readVoiceUsage(stateDir) {
  const row = stateDir ? readJsonSafe(voiceUsagePath(stateDir), null) : null
  return {
    lastAt: Number(row?.lastAt) || 0,
    lastText: typeof row?.lastText === 'string' ? row.lastText : '',
    count: Number(row?.count) || 0,
    saidAt: Array.isArray(row?.saidAt) ? row.saidAt.filter((at) => Number.isFinite(Number(at))).slice(-100) : [],
  }
}

/**
 * 记一条「真的发出去了」的语音。stateDir 为空时只跳过（拿不到机器人目录不该影响发送）。
 * 只存时间、次数和最近一句的摘要；正文本身已经在聊天记录里了。
 */
export function noteVoiceSent(stateDir, text, now = Date.now()) {
  if (!stateDir) return null
  const previous = readVoiceUsage(stateDir)
  const next = {
    version: 1,
    lastAt: now,
    lastText: String(text ?? '').slice(0, 200),
    count: previous.count + 1,
    saidAt: [...previous.saidAt, now].slice(-100),
  }
  try { writeJsonAtomic(voiceUsagePath(stateDir), next) } catch (error) {
    appendLog(PATHS.diag, '语音记账失败：' + (error?.message ?? error))
  }
  return next
}

/** 距上一条语音多少分钟；没发过返回 null。 */
export function minutesSinceLastVoice(stateDir, now = Date.now()) {
  const { lastAt } = readVoiceUsage(stateDir)
  if (!lastAt) return null
  return Math.max(0, Math.round((now - lastAt) / 60_000))
}

/**
 * 拼出这一轮要注入的语音规则。纯函数，测试直接调它：
 *   - 非 QQ：''（没有 sendVoice，注入了也只会换来报错）
 *   - 这个聊天把「主动语音」关了：''（会话管理里按聊天单独关）
 *   - 合成关着：一句「别调」
 *   - 主动语音总闸关着：''
 *   - 否则：自定义提示词或默认规则，最近发过语音再补一句压制
 */
export function voicePromptText(config, { channel = '', minutesSinceLast = null, chatEnabled = true } = {}) {
  const voice = config?.voice ?? {}
  if (channel !== 'qq') return ''
  if (chatEnabled === false) return ''
  if (voice.enabled === false) return VOICE_DISABLED_LINE
  if (voice.promptEnabled === false) return ''
  const custom = String(voice.prompt ?? '').trim().slice(0, MAX_VOICE_PROMPT_CHARS)
  const base = custom || DEFAULT_VOICE_PROMPT
  if (minutesSinceLast === null || minutesSinceLast === undefined) return base
  const minutes = Number(minutesSinceLast)
  if (!Number.isFinite(minutes) || minutes >= VOICE_PACING_MINUTES) return base
  return `${base}\n\n${voicePacingLine(minutes)}`
}

/**
 * 注册注入。与人格/记忆/心情同一套约定：`context` + `required: true`，
 * 因此在用户的任意 Agent Preset 下都不会被悄悄拿掉（见 injection-health.js）。
 */
export function installVoiceInjection(ctx, getConfig, { getBotForSession, getChatForSession, stateDirFor } = {}) {
  try {
    return ctx.systemPrompt.context({
      name: VOICE_PROMPT_NAME,
      order: VOICE_PROMPT_ORDER,
      required: true,
      text: (assembly) => {
        const sessionId = assembly?.agent?.session?.id ?? assembly?.session?.id ?? ''
        noteInjection(sessionId, VOICE_PROMPT_NAME)
        try {
          // 语音只属于机器人会话：普通 DSH 会话没有 companion_voice 的收件人。
          const bot = sessionId && getBotForSession ? getBotForSession(sessionId) : null
          if (!bot) return ''
          // 会话管理里按聊天关掉的，这里直接不注入（总闸仍由 config 管）。
          const chat = sessionId && getChatForSession ? getChatForSession(sessionId) : null
          const stateDir = stateDirFor ? stateDirFor(bot) : ''
          return voicePromptText(getConfig(), {
            channel: bot.channel,
            chatEnabled: !chat || chat.voicePrompt?.enabled !== false,
            minutesSinceLast: minutesSinceLastVoice(stateDir),
          })
        } catch (error) {
          appendLog(PATHS.diag, '语音提示注入失败：' + (error?.message ?? error))
          return ''
        }
      },
    })
  } catch (error) {
    appendLog(PATHS.diag, '语音提示注册失败（可能重复装载）：' + (error?.message ?? error))
    return () => {}
  }
}