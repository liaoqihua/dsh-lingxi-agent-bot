// 灵犀 · 语音：把一句话合成为音频，交给通道发成真正的语音条。
//
// 两个来源：
//   1. 宿主已装的「语音朗读」路由（dsh-xiaomi-tts）：POST /plugins/xiaomi-mimo-tts/synthesize；
//   2. 任意 OpenAI 兼容 TTS：POST {endpoint}/audio/speech，Bearer {apiKey}。
// 默认 auto：配了 endpoint 就用自己的，否则借用宿主的朗读路由。
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PATHS } from './config.js'
import { appendLog, sleep, truncate } from './util.js'
import { DEFAULT_VOICE_PROMPT, VOICE_PACING_MINUTES, readVoiceUsage } from './voice-prompt.js'

const XIAOMI_SYNTH = '/plugins/xiaomi-mimo-tts/synthesize'

function cleanForSpeech(input) {
  return String(input ?? '')
    .replace(/```[\s\S]*?```/g, '（代码省略）')
    .replace(/`[^`]*`/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\\/][^\s]*/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function synthesizeXiaomi(ctx, config, body) {
  const origin = ctx.webServer?.getOrigin?.()
  if (!origin) throw new Error('宿主没有网页服务地址，借不到语音朗读路由')
  const response = await fetch(`${origin}${XIAOMI_SYNTH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ text: body, format: config.voice.format }),
    signal: AbortSignal.timeout(config.voice.timeoutMs),
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!response.ok) {
    let detail = bytes.toString('utf8').slice(0, 200)
    try { detail = JSON.parse(detail)?.message || detail } catch { /* ignore */ }
    throw new Error(`宿主语音合成失败（HTTP ${response.status}${detail ? `：${detail}` : ''}）。去「设置 → 语音朗读」试听一句，确认 key 有效。`)
  }
  if (!bytes.length) throw new Error('宿主语音合成返回了空音频')
  return { bytes, format: config.voice.format, source: 'xiaomi' }
}

async function synthesizeOpenAi(config, body) {
  if (!config.voice.endpoint) throw new Error('没有配置 TTS 地址')
  const base = config.voice.endpoint.replace(/\/+$/, '')
  const url = /\/audio\/speech$/.test(base) ? base : `${base}/audio/speech`
  const headers = { 'content-type': 'application/json; charset=utf-8' }
  if (config.voice.apiKey) headers.authorization = `Bearer ${config.voice.apiKey}`
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.voice.model,
      input: body,
      voice: config.voice.voice,
      response_format: config.voice.format,
    }),
    signal: AbortSignal.timeout(config.voice.timeoutMs),
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!response.ok) {
    let detail = bytes.toString('utf8').slice(0, 200)
    try { detail = JSON.parse(detail)?.error?.message || detail } catch { /* ignore */ }
    throw new Error(`TTS 失败（HTTP ${response.status}${detail ? `：${detail}` : ''}）`)
  }
  if (!bytes.length) throw new Error('TTS 返回了空音频')
  return { bytes, format: config.voice.format, source: 'openai' }
}

export async function synthesize(ctx, config, inputText) {
  if (!config.voice.enabled) throw new Error('语音合成在设置里关着')
  const body = cleanForSpeech(inputText)
  if (!body) throw new Error('没有可朗读的文字')
  if (body.length > 1_200) throw new Error('这句话太长了（上限 1200 字），拆短一点')
  const provider = config.voice.provider
  if (provider === 'openai' || (provider === 'auto' && config.voice.endpoint)) {
    return synthesizeOpenAi(config, body)
  }
  try {
    return await synthesizeXiaomi(ctx, config, body)
  } catch (error) {
    if (provider === 'xiaomi') throw error
    if (!config.voice.endpoint) throw error
    appendLog(PATHS.diag, `宿主 TTS 失败，改用自定义 TTS：${error?.message ?? error}`)
    return synthesizeOpenAi(config, body)
  }
}

export async function synthesizeToFile(ctx, config, inputText) {
  const { bytes, format, source } = await synthesize(ctx, config, inputText)
  mkdirSync(PATHS.voice, { recursive: true })
  const file = join(PATHS.voice, `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${format}`)
  writeFileSync(file, bytes)
  return { file, bytes, format, source }
}

export function cleanupVoiceFile(file) {
  try {
    if (file && file.startsWith(PATHS.voice)) rmSync(file, { force: true })
  } catch { /* ignore */ }
}

/** 设置页自检：宿主朗读路由在不在（空文本探测，不花钱）+ 当前配置会怎么走。 */
export async function voiceStatus(ctx, config, { stateDir = '' } = {}) {
  const origin = ctx.webServer?.getOrigin?.()
  const endpoint = String(config.voice.endpoint ?? '')
  const provider = config.voice.provider
  // 和 synthesize() 同一套判断：有地址（或强制 openai）就走自己的 TTS，否则借宿主朗读。
  const usesCustom = provider === 'openai' || (provider === 'auto' && Boolean(endpoint))
  const usage = readVoiceUsage(stateDir)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const status = {
    enabled: config.voice.enabled,
    provider,
    effective: usesCustom ? 'openai' : 'xiaomi',
    fallback: !usesCustom && provider === 'auto' && endpoint ? 'openai' : '',
    format: config.voice.format,
    model: config.voice.model,
    voice: config.voice.voice,
    timeoutMs: config.voice.timeoutMs,
    endpoint,
    apiKeySet: Boolean(config.voice.apiKey),
    custom: { configured: Boolean(endpoint), endpoint: truncate(endpoint, 80) },
    dir: PATHS.voice,
    temp: voiceTempUsage(),
    // 主动语音（提示词注入）的状态：设置页用它显示「已开启/已关闭」「用默认还是自定义」。
    prompt: {
      enabled: config.voice.enabled && config.voice.promptEnabled !== false,
      promptEnabled: config.voice.promptEnabled !== false,
      custom: Boolean(String(config.voice.prompt ?? '').trim()),
      pacingMinutes: VOICE_PACING_MINUTES,
      lastSentAt: usage.lastAt || 0,
      sentToday: usage.saidAt.filter((at) => Number(at) >= today.getTime()).length,
      defaultText: DEFAULT_VOICE_PROMPT,
    },
    xiaomi: { available: false, error: '', checked: false, route: XIAOMI_SYNTH },
    checkedAt: Date.now(),
  }
  if (!origin) {
    status.xiaomi.error = '宿主没有网页服务地址，借不到朗读路由'
    return status
  }
  status.xiaomi.checked = true
  try {
    const response = await fetch(`${origin}${XIAOMI_SYNTH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text: '', format: config.voice.format }),
      signal: AbortSignal.timeout(8_000),
    })
    // 空文本一定在花钱之前被拒（400 text-required）；只要不是 404 就说明路由在。
    status.xiaomi.available = response.status !== 404
    if (response.status === 404) status.xiaomi.error = '宿主没有装语音朗读插件（dsh-xiaomi-tts）'
    await response.arrayBuffer().catch(() => null)
  } catch (error) {
    status.xiaomi.error = String(error?.message ?? error)
  }
  return status
}

/** 临时语音目录里还剩什么（正常路径合完就删，剩下来的多半是中断留下的）。 */
export function voiceTempUsage() {
  let count = 0
  let bytes = 0
  try {
    for (const name of readdirSync(PATHS.voice)) {
      count += 1
      try { bytes += statSync(join(PATHS.voice, name)).size } catch { /* 单个文件读不到就算了 */ }
    }
  } catch { /* 目录还没建 */ }
  return { count, bytes }
}

export async function voiceNotice(info) {
  await sleep(0)
  return `语音已合成：${truncate(info, 80)}`
}
