// 灵犀 · 机器人注册表
//
// 一个机器人 = 一条独立连接 + 一个独立个体。配置写 bots.json；每台机器人有
// 自己的状态目录（人格/记忆/心情/搭话/聊天绑定）。聊天与会话的绑定不在这里，
// 由 SessionBridge 负责；这里只负责机器人身份、凭据、新会话默认配置和状态目录。
//
// 新会话默认配置按私聊 / 群聊分叉（sessionDefaults.{c2c,group}），是会话工作区
// 与默认权限的唯一来源；没有顶层 workspace / preset / provider / model /
// defaultPermission / sessionId——旧格式字段加载时直接忽略。
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendLog, readJsonSafe, writeJsonAtomic } from './util.js'

export const BOT_CHANNELS = Object.freeze(['qq', 'webhook', 'feishu'])
export const BOT_PERMISSIONS = Object.freeze(['workspace-write', 'read-only', 'danger-full-access'])
export const BOT_DEFAULT_PERMISSION = 'workspace-write'
export const BOT_SCOPES = Object.freeze(['c2c', 'group'])
export const SCOPE_LABEL = Object.freeze({ c2c: '私聊', group: '群聊' })

const VERSION = 1

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizePermission(value) {
  return BOT_PERMISSIONS.includes(value) ? value : BOT_DEFAULT_PERMISSION
}

/** 一段（私聊 / 群聊）新会话默认配置。 */
function normalizeSessionDefault(raw) {
  const row = isObject(raw) ? raw : {}
  return {
    workspace: text(row.workspace),
    preset: text(row.preset),
    provider: text(row.provider),
    model: text(row.model),
    defaultPermission: normalizePermission(row.defaultPermission),
  }
}

/** 读取两段五项；旧顶层字段（workspace/preset/…）忽略不报错。 */
export function normalizeSessionDefaults(raw) {
  const source = isObject(raw?.sessionDefaults) ? raw.sessionDefaults : {}
  const out = {}
  for (const scope of BOT_SCOPES) out[scope] = normalizeSessionDefault(source[scope])
  return out
}

/**
 * 两段默认配置的完整性检查（设置页保存时用）。
 * workspace 与合法的 defaultPermission 必填；preset / provider / model 允许空串
 * （空串 = 跟随宿主默认）。返回缺失项的人话描述，空数组表示通过。
 */
export function missingSessionDefaults(sessionDefaults) {
  const missing = []
  for (const scope of BOT_SCOPES) {
    const label = SCOPE_LABEL[scope]
    const row = isObject(sessionDefaults?.[scope]) ? sessionDefaults[scope] : {}
    if (!text(row.workspace)) missing.push(`${label}：工作区`)
    if (!BOT_PERMISSIONS.includes(row.defaultPermission)) missing.push(`${label}：默认权限`)
  }
  return missing
}

/**
 * 一段关系里「对方」的称呼：这台机器人自己的优先，没设过就用插件级默认。
 *
 * 入站名字、心情判断、记忆提炼三处都只该从这里取值——之前它们各自读
 * config.identity.ownerName，于是机器人级设置无从谈起。
 */
export function ownerNameFor(bot, config) {
  const own = text(bot?.ownerName)
  if (own) return own
  return text(config?.identity?.ownerName, '主人') || '主人'
}

/** 会话创建时用得上的那一段（按 record.scope）。 */
export function sessionDefaultsFor(bot, scope) {
  const key = scope === 'group' ? 'group' : 'c2c'
  return normalizeSessionDefault(bot?.sessionDefaults?.[key])
}

function normalizeBot(raw, now = Date.now()) {
  const channel = BOT_CHANNELS.includes(raw?.channel) ? raw.channel : ''
  if (!channel) throw new Error('机器人通道必须是 qq / webhook / feishu')
  const id = text(raw?.id)
  if (!id) throw new Error('机器人缺少 id')
  const credentials = isObject(raw.credentials) ? { ...raw.credentials } : {}
  return {
    id,
    channel,
    name: text(raw.name) || id,
    // 关系里的称呼（她怎么叫你）。空串＝没设过，回落到插件级 identity.ownerName；
    // 解析统一走 ownerNameFor()，别在别处再读一遍 config。
    ownerName: text(raw.ownerName).slice(0, 32),
    enabled: raw.enabled !== false,
    credentials,
    sessionDefaults: normalizeSessionDefaults(raw),
    groupEnabled: raw.groupEnabled === true,
    busyMessageMode: raw.busyMessageMode === 'steer' ? 'steer' : 'queue',
    contextEnhancement: {
      enabled: raw.contextEnhancement?.enabled === true,
      includeSender: raw.contextEnhancement?.includeSender !== false,
      includeChat: raw.contextEnhancement?.includeChat !== false,
      // 时间不再是可选项：入站正文永远带 now（模型没有时钟就会自己猜）。
      // 旧配置里的 includeTime 读盘时忽略，别留一个影响不了行为的开关。
      guidance: text(raw.contextEnhancement?.guidance).slice(0, 2000),
    },
    access: {
      mode: ['all', 'allow', 'block'].includes(raw.access?.mode) ? raw.access.mode : 'all',
      users: Array.isArray(raw.access?.users) ? raw.access.users.map((x) => text(x)).filter(Boolean).slice(0, 100) : [],
      groups: Array.isArray(raw.access?.groups) ? raw.access.groups.map((x) => text(x)).filter(Boolean).slice(0, 100) : [],
    },
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
  }
}

function blankPersona(bot) {
  return `# ${bot.name}\n\n<!-- 这个机器人的人格只由本文件定义；写她是谁、怎么说话、在意什么。 -->\n\n`
}

function blankMemory() {
  return { version: 1, memories: [], lastRecall: null }
}

function blankMood() {
  return { version: 1, mood: 70, label: '平静', dims: [], updatedAt: 0, lastReason: '' }
}

function blankProactive() {
  return {
    version: 1,
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
    prompt: '',
    misses: 0,
    lastSpokeAt: 0,
    lastTickAt: 0,
    lastRollAt: 0,
    lastRoll: null,
    saidAt: [],
    logs: [],
  }
}

function blankChats() {
  return { version: 1, chats: {} }
}

/** 对外返回的机器人快照：嵌套对象也复制，调用方改不到注册表内部状态。 */
function cloneBot(bot) {
  return {
    ...bot,
    credentials: { ...bot.credentials },
    sessionDefaults: normalizeSessionDefaults(bot),
    contextEnhancement: { ...bot.contextEnhancement },
    access: { ...bot.access, users: [...bot.access.users], groups: [...bot.access.groups] },
  }
}

export class BotRegistry {
  constructor({ root, logger } = {}) {
    this.root = root || ''
    if (!this.root) throw new Error('BotRegistry 需要 root')
    this.path = join(this.root, 'bots.json')
    this.stateRoot = join(this.root, 'bots')
    this.logger = logger
    this.db = this.load()
  }

  load() {
    const raw = readJsonSafe(this.path, null)
    const rows = Array.isArray(raw?.bots) ? raw.bots : []
    const bots = []
    for (const row of rows) {
      try { bots.push(normalizeBot(row)) } catch (error) {
        appendLog(join(this.root, 'logs', 'diag.log'), `忽略无效机器人：${error?.message ?? error}`)
      }
    }
    return { version: VERSION, bots }
  }

  save() {
    writeJsonAtomic(this.path, this.db)
  }

  list(channel) {
    return this.db.bots
      .filter((bot) => !channel || bot.channel === channel)
      .map((bot) => cloneBot(bot))
  }

  get(id) {
    const bot = this.db.bots.find((row) => row.id === id)
    return bot ? cloneBot(bot) : null
  }

  add(input = {}) {
    const channel = BOT_CHANNELS.includes(input.channel) ? input.channel : ''
    if (!channel) throw new Error('机器人通道必须是 qq / webhook / feishu')
    const now = Date.now()
    const id = text(input.id) || `${channel}-${randomUUID().slice(0, 8)}`
    if (this.db.bots.some((row) => row.id === id)) throw new Error(`机器人 id 已存在：${id}`)
    const bot = normalizeBot({ ...input, channel, id, createdAt: now, updatedAt: now }, now)
    // 同一个机器人重复接入：按通道稳定凭据去重，避免同一台机器人落成两条记录。
    //   · QQ / 飞书：AppID
    //   · 微信：accountId（iLink 返回的机器人账号）
    const identity = bot.channel === 'webhook'
      ? text(bot.credentials?.accountId)
      : text(bot.credentials?.appId)
    if (identity) {
      const duplicate = this.db.bots.find((row) => row.channel === bot.channel && (
        bot.channel === 'webhook'
          ? text(row.credentials?.accountId) === identity
          : text(row.credentials?.appId) === identity
      ))
      if (duplicate) throw new Error(`这台机器人已经接入了：${duplicate.name || duplicate.id}`)
    }
    this.db.bots.push(bot)
    this.save()
    this.provision(bot)
    appendLog(join(this.root, 'logs', 'diag.log'), `新增机器人 ${bot.id}（${bot.channel}）`)
    return this.get(id)
  }

  update(id, patch = {}) {
    const index = this.db.bots.findIndex((row) => row.id === id)
    if (index < 0) throw new Error(`机器人不存在：${id}`)
    const current = this.db.bots[index]
    const next = normalizeBot({
      ...current,
      ...patch,
      id: current.id,
      channel: current.channel,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    })
    this.db.bots[index] = next
    this.save()
    return this.get(id)
  }

  remove(id) {
    const index = this.db.bots.findIndex((row) => row.id === id)
    if (index < 0) return false
    const [bot] = this.db.bots.splice(index, 1)
    this.save()
    rmSync(this.stateDir(bot.id), { recursive: true, force: true })
    appendLog(join(this.root, 'logs', 'diag.log'), `删除机器人 ${bot.id}（已删除状态）`)
    return true
  }

  /** 机器人状态目录；不存在就建。 */
  stateDir(id) {
    return join(this.stateRoot, String(id))
  }

  provision(bot) {
    const dir = this.stateDir(bot.id)
    mkdirSync(dir, { recursive: true })
    const files = {
      'persona.md': blankPersona(bot),
      'memory.json': blankMemory(),
      'mood.json': blankMood(),
      'proactive.json': blankProactive(),
      'chats.json': blankChats(),
    }
    for (const [name, value] of Object.entries(files)) {
      const path = join(dir, name)
      if (existsSync(path)) continue
      if (typeof value === 'string') writeFileSync(path, value, 'utf8')
      else writeJsonAtomic(path, value)
    }
    return dir
  }
}
