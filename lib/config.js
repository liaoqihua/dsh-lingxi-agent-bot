// 灵犀 · 插件默认值与语音配置；机器人配置和凭据只在 bots.json。
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { appendLog, bool, clamp, num, readJsonSafe, text, writeJsonAtomic } from './util.js'

export const DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
export const ROOT = join(DSH_HOME, 'dsh-lingxi-agent-bot')
export const PATHS = Object.freeze({
  root: ROOT,
  config: join(ROOT, 'config.json'),
  diag: join(ROOT, 'logs', 'diag.log'),
  sessions: join(ROOT, 'sessions.json'),
  inbox: join(ROOT, 'inbox'),
  voice: join(ROOT, 'voice'),
})

export const DEFAULTS = Object.freeze({
  configVersion: 1,
  identity: {
    selfName: '伙伴',
    ownerName: '主人',
    aliases: '',
    pronoun: 'ta',
  },
  persona: {
    order: 800,
  },
  memory: {
    halfLifeDays: 30,
    dailyQuota: 8,
    recallLimit: 6,
    maxInjectChars: 800,
    minEvidence: 2,
    modelExtract: true,
    extractEveryTurns: 2,
    maxMemories: 2_000,
    order: 880,
    weights: { freshness: 35, importance: 25, emotion: 15, evidence: 25 },
  },
  mood: {
    base: 70,
    floor: 0,
    decayHalfHours: 12,
    injectMode: 'event',
    injectConfidence: 60,
    sigMood: 3,
    sigDim: 5,
    injectPerDay: 12,
    autoJudge: true,
    order: 890,
  },
  proactive: {
    enabled: true,
    intervalMinutes: 30,
    hitLine: 30,
    missBonus: 10,
    bonusCap: 40,
    quietStart: 23,
    quietEnd: 7,
    minIdleMinutes: 60,
    cooldownMinutes: 20,
    maxPerDay: 6,
    prompt: '好久没人跟我说话了。我想主动找对方聊两句，说点此刻自己真正想说的。',
  },
  channels: {
    qq: {
      enabled: true,
      appId: '',
      appSecret: '',
      ownerOpenId: '',
      maxChars: 1_500,
    },
    feishu: {
      enabled: false,
      appId: '',
      appSecret: '',
      verificationToken: '',
      encryptKey: '',
      requireMention: true,
      maxChars: 1_500,
    },
    webhook: {
      enabled: false,
      label: '微信',
      secret: '',
      outboundUrl: '',
      requireMention: false,
      maxChars: 1_500,
    },
  },
  voice: {
    enabled: true,
    provider: 'auto',
    endpoint: '',
    apiKey: '',
    model: 'tts-1',
    voice: 'alloy',
    format: 'mp3',
    timeoutMs: 120_000,
    // 主动语音：往系统提示里注入一段「气氛到了就用声音说话」的规则（见 lib/voice-prompt.js）。
    // prompt 留空 = 用内置默认规则；关掉 promptEnabled 就回到「模型自己想用才用」。
    promptEnabled: true,
    prompt: '',
  },
  sessions: {
    idleMinutes: 0,
    autoCreate: true,
    titlePrefix: '伴侣',
  },
  // 斗图：把模型写的 [表情: 描述] 还原成图库里的原生图片再发出去。
  meme: {
    enabled: true,
    maxImages: 4,
  },
  tools: {
    enabled: true,
  },
})

const INJECT_MODES = new Set(['off', 'label', 'event'])

function isObj(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function mergeKnown(base, over) {
  if (!isObj(over)) return base
  const out = Array.isArray(base) ? base.slice() : { ...base }
  for (const [key, value] of Object.entries(over)) {
    const current = out[key]
    if (isObj(current) && isObj(value)) out[key] = mergeKnown(current, value)
    else if (Array.isArray(current) && Array.isArray(value)) out[key] = value
    else if (value !== undefined && value !== null) out[key] = value
  }
  return out
}

export function normalize(raw) {
  const c = mergeKnown(DEFAULTS, raw)
  const q = c.channels.qq
  const f = c.channels.feishu
  const hook = c.channels.webhook

  return {
    configVersion: 1,
    identity: {
      selfName: text(c.identity.selfName, DEFAULTS.identity.selfName).slice(0, 32),
      ownerName: text(c.identity.ownerName, DEFAULTS.identity.ownerName).slice(0, 32),
      aliases: text(c.identity.aliases, '').slice(0, 200),
      pronoun: ['他', '她', 'ta'].includes(String(c.identity.pronoun)) ? String(c.identity.pronoun) : 'ta',
    },
    persona: {
      order: Math.round(num(c.persona.order, DEFAULTS.persona.order, 0, 10_000)),
    },
    memory: {
      halfLifeDays: num(c.memory.halfLifeDays, DEFAULTS.memory.halfLifeDays, 1, 3650),
      dailyQuota: Math.round(num(c.memory.dailyQuota, DEFAULTS.memory.dailyQuota, 0, 100)),
      recallLimit: Math.round(num(c.memory.recallLimit, DEFAULTS.memory.recallLimit, 0, 30)),
      maxInjectChars: Math.round(num(c.memory.maxInjectChars, DEFAULTS.memory.maxInjectChars, 100, 8_000)),
      minEvidence: Math.round(num(c.memory.minEvidence, DEFAULTS.memory.minEvidence, 1, 20)),
      modelExtract: bool(c.memory.modelExtract, DEFAULTS.memory.modelExtract),
      extractEveryTurns: Math.round(num(c.memory.extractEveryTurns, DEFAULTS.memory.extractEveryTurns, 1, 20)),
      maxMemories: Math.round(num(c.memory.maxMemories, DEFAULTS.memory.maxMemories, 50, 50_000)),
      order: Math.round(num(c.memory.order, DEFAULTS.memory.order, 0, 10_000)),
      weights: (() => {
        const w = {
          freshness: num(c.memory.weights?.freshness, DEFAULTS.memory.weights.freshness, 0, 100),
          importance: num(c.memory.weights?.importance, DEFAULTS.memory.weights.importance, 0, 100),
          emotion: num(c.memory.weights?.emotion, DEFAULTS.memory.weights.emotion, 0, 100),
          evidence: num(c.memory.weights?.evidence, DEFAULTS.memory.weights.evidence, 0, 100),
        }
        const total = w.freshness + w.importance + w.emotion + w.evidence
        if (total <= 0) return { ...DEFAULTS.memory.weights }
        for (const k of Object.keys(w)) w[k] = w[k] / total
        return w
      })(),
    },
    mood: {
      base: Math.round(num(c.mood.base, DEFAULTS.mood.base, 30, 100)),
      floor: Math.round(num(c.mood.floor, DEFAULTS.mood.floor, 0, 100)),
      decayHalfHours: Math.round(num(c.mood.decayHalfHours, DEFAULTS.mood.decayHalfHours, 1, 168)),
      injectMode: INJECT_MODES.has(String(c.mood.injectMode)) ? String(c.mood.injectMode) : DEFAULTS.mood.injectMode,
      injectConfidence: Math.round(num(c.mood.injectConfidence, DEFAULTS.mood.injectConfidence, 0, 100)),
      sigMood: Math.round(num(c.mood.sigMood, DEFAULTS.mood.sigMood, 1, 30)),
      sigDim: Math.round(num(c.mood.sigDim, DEFAULTS.mood.sigDim, 1, 100)),
      injectPerDay: Math.round(num(c.mood.injectPerDay, DEFAULTS.mood.injectPerDay, 0, 50)),
      autoJudge: bool(c.mood.autoJudge, DEFAULTS.mood.autoJudge),
      order: Math.round(num(c.mood.order, DEFAULTS.mood.order, 0, 10_000)),
    },
    proactive: {
      enabled: bool(c.proactive.enabled, DEFAULTS.proactive.enabled),
      intervalMinutes: Math.round(num(c.proactive.intervalMinutes, DEFAULTS.proactive.intervalMinutes, 1, 1_440)),
      hitLine: Math.round(num(c.proactive.hitLine, DEFAULTS.proactive.hitLine, 0, 100)),
      missBonus: Math.round(num(c.proactive.missBonus, DEFAULTS.proactive.missBonus, 0, 100)),
      bonusCap: Math.round(num(c.proactive.bonusCap, DEFAULTS.proactive.bonusCap, 0, 100)),
      quietStart: Math.round(num(c.proactive.quietStart, DEFAULTS.proactive.quietStart, 0, 23)),
      quietEnd: Math.round(num(c.proactive.quietEnd, DEFAULTS.proactive.quietEnd, 0, 23)),
      minIdleMinutes: Math.round(num(c.proactive.minIdleMinutes, DEFAULTS.proactive.minIdleMinutes, 0, 10_080)),
      cooldownMinutes: Math.round(num(c.proactive.cooldownMinutes, DEFAULTS.proactive.cooldownMinutes, 0, 1_440)),
      maxPerDay: Math.round(num(c.proactive.maxPerDay, DEFAULTS.proactive.maxPerDay, 0, 100)),
      prompt: text(c.proactive.prompt, DEFAULTS.proactive.prompt).slice(0, 1_000),
    },
    channels: {
      qq: {
        enabled: bool(q.enabled, DEFAULTS.channels.qq.enabled),
        appId: text(q.appId, ''),
        appSecret: text(q.appSecret, ''),
        ownerOpenId: text(q.ownerOpenId, ''),
        maxChars: Math.round(num(q.maxChars, DEFAULTS.channels.qq.maxChars, 200, 10_000)),
      },
      feishu: {
        enabled: bool(f.enabled, DEFAULTS.channels.feishu.enabled),
        appId: text(f.appId, ''),
        appSecret: text(f.appSecret, ''),
        verificationToken: text(f.verificationToken, ''),
        encryptKey: text(f.encryptKey, ''),
        requireMention: bool(f.requireMention, DEFAULTS.channels.feishu.requireMention),
        maxChars: Math.round(num(f.maxChars, DEFAULTS.channels.feishu.maxChars, 200, 10_000)),
      },
      webhook: {
        enabled: bool(hook.enabled, DEFAULTS.channels.webhook.enabled),
        label: text(hook.label, DEFAULTS.channels.webhook.label).slice(0, 32),
        secret: text(hook.secret, ''),
        outboundUrl: text(hook.outboundUrl, ''),
        requireMention: bool(hook.requireMention, DEFAULTS.channels.webhook.requireMention),
        maxChars: Math.round(num(hook.maxChars, DEFAULTS.channels.webhook.maxChars, 200, 10_000)),
      },
    },
    voice: {
      enabled: bool(c.voice.enabled, DEFAULTS.voice.enabled),
      provider: ['auto', 'openai', 'xiaomi'].includes(String(c.voice.provider)) ? String(c.voice.provider) : 'auto',
      endpoint: text(c.voice.endpoint, ''),
      apiKey: text(c.voice.apiKey, ''),
      model: text(c.voice.model, DEFAULTS.voice.model),
      voice: text(c.voice.voice, DEFAULTS.voice.voice),
      format: c.voice.format === 'wav' ? 'wav' : 'mp3',
      timeoutMs: Math.round(num(c.voice.timeoutMs, DEFAULTS.voice.timeoutMs, 5_000, 300_000)),
      promptEnabled: bool(c.voice.promptEnabled, DEFAULTS.voice.promptEnabled),
      prompt: text(c.voice.prompt, '').slice(0, 2_000),
    },
    sessions: {
      idleMinutes: Math.round(num(c.sessions.idleMinutes, DEFAULTS.sessions.idleMinutes, 0, 10_080)),
      autoCreate: bool(c.sessions.autoCreate, DEFAULTS.sessions.autoCreate),
      titlePrefix: text(c.sessions.titlePrefix, DEFAULTS.sessions.titlePrefix).slice(0, 24),
    },
    meme: {
      enabled: bool(c.meme?.enabled, DEFAULTS.meme.enabled),
      maxImages: Math.round(num(c.meme?.maxImages, DEFAULTS.meme.maxImages, 1, 4)),
    },
    tools: {
      enabled: bool(c.tools.enabled, DEFAULTS.tools.enabled),
    },
  }
}

export function loadConfig() {
  mkdirSync(ROOT, { recursive: true })
  const raw = readJsonSafe(PATHS.config, null)
  if (!isObj(raw)) {
    const normalized = normalize({})
    try {
      writeJsonAtomic(PATHS.config, { ...normalized, _createdAt: new Date().toISOString() })
    } catch { /* ignore */ }
    return normalized
  }
  return normalize(raw)
}

export function saveConfig(config) {
  const normalized = normalize(config)
  writeJsonAtomic(PATHS.config, normalized)
  return normalized
}

/** 深合并补丁后保存；返回新配置。 */
export function patchConfig(config, patch) {
  if (!isObj(patch)) return config
  const merged = mergeKnown(config, patch)
  return saveConfig(merged)
}

export function maskSecret(value) {
  const s = String(value ?? '')
  if (s === '') return ''
  if (s.length <= 6) return '••••'
  return s.slice(0, 3) + '••••' + s.slice(-3)
}

export function ensureDirs() {
  for (const dir of [ROOT, PATHS.inbox, PATHS.voice, join(ROOT, 'logs')]) {
    try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  }
}

export function configFilePath() {
  return PATHS.config
}
