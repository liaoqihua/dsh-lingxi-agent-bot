// 灵犀 · 机器人运行时
//
// 把 BotRegistry 里的机器人变成真实连接。当前先支持 QQ：每台机器人一个
// QQOfficialChannel，各自有独立 botId、凭据、工作区、Preset 和连接状态。
// 飞书/微信后续按同一结构接入；未接入前不会被这个 manager 启动。
import { PATHS } from './config.js'
import { ownerNameFor } from './bots.js'
import { appendLog } from './util.js'
import { ChannelProvisioning } from './channel-provisioning.js'

export class BotManager {
  constructor(ctx, {
    registry, bridge, getConfig, logger,
    createQq = null,
    createWebhook = null,
    createFeishu = null,
    lark = null,
    fetchImpl = fetch,
    encodeQr = null,
  } = {}) {
    if (!registry) throw new Error('BotManager 需要 registry')
    this.ctx = ctx
    this.registry = registry
    this.bridge = bridge
    this.getConfig = getConfig
    this.logger = logger
    this.createQq = createQq
    this.createWebhook = createWebhook
    this.createFeishu = createFeishu
    this.instances = new Map()
    this.provision = null
    this.channelProvisioning = new ChannelProvisioning({
      registry,
      startBot: (bot) => this.ensureStarted(bot),
      getConfig,
      lark,
      fetchImpl,
      encodeQr,
    })
    this.started = false
  }

  configFor(bot) {
    const base = this.getConfig() || {}
    const kind = bot.channel || 'qq'
    const channelConfig = {
      ...(base.channels?.[kind] ?? {}),
      ...(bot.credentials ?? {}),
      name: bot.name,
      enabled: bot.enabled !== false,
    }
    // 凭据只属于机器人自己；扫码中的临时通道没有 botId，不能借用其他机器人的凭据。
    // 通道实例只关心连接与出站格式：新会话的工作区 / Preset / 模型 / 默认权限在
    // bot.sessionDefaults 里，由 SessionBridge 按聊天 scope 取用。
    for (const key of ['appId', 'appSecret', 'verificationToken', 'encryptKey', 'secret', 'outboundUrl', 'ownerOpenId', 'token', 'aesKey']) {
      if (!(key in (bot.credentials ?? {}))) delete channelConfig[key]
    }
    return {
      ...base,
      // 通道侧读的是合成视图：机器人自己的称呼优先，没设过落回插件级默认。
      // QQ 私聊的 senderName 直接取这个值（官方 SDK 不给昵称），会话标题也跟着它走，
      // 所以必须在通道拿到 config 之前就合并好，不能等 index 里那处再算。
      identity: { ...(base.identity ?? {}), ownerName: ownerNameFor(bot, base) },
      channels: {
        ...(base.channels ?? {}),
        [kind]: channelConfig,
      },
    }
  }

  async ensureStarted(bot) {
    if (!bot || bot.enabled === false) return null
    const current = this.instances.get(bot.id)
    if (current) return current
    const kind = bot.channel || 'qq'
    const options = {
      bridge: this.bridge,
      getConfig: () => this.configFor(this.registry.get(bot.id) ?? bot),
      logger: this.logger,
      botId: bot.id,
    }
    let channel
    if (kind === 'qq') {
      if (!this.createQq) throw new Error('QQ 通道工厂未配置')
      channel = this.createQq(this.ctx, {
        ...options,
        onLogin: async ({ appId, appSecret }) => {
          this.registry.update(bot.id, {
            enabled: true,
            credentials: { ...(this.registry.get(bot.id)?.credentials ?? {}), appId, appSecret },
          })
          appendLog(PATHS.diag, `机器人 ${bot.id} 扫码登录成功`)
        },
      })
    } else if (kind === 'webhook') {
      if (!this.createWebhook) throw new Error('微信通道工厂未配置')
      channel = this.createWebhook(this.ctx, options)
    } else if (kind === 'feishu') {
      if (!this.createFeishu) throw new Error('飞书通道工厂未配置')
      channel = this.createFeishu(this.ctx, options)
    } else {
      throw new Error(`不支持的通道：${kind}`)
    }
    this.instances.set(bot.id, channel)
    try {
      await channel.start()
    } catch (error) {
      this.logger?.warn?.(`companion: 机器人 ${bot.id} 启动失败：${error?.message ?? error}`)
    }
    return channel
  }

  async startAll() {
    if (this.started) return this.status()
    this.started = true
    for (const bot of this.registry.list()) {
      if (bot.enabled !== false) await this.ensureStarted(bot)
    }
    return this.status()
  }

  async restart(botId) {
    const channel = this.instances.get(botId)
    if (channel) {
      try { channel.stop() } catch { /* ignore */ }
      this.instances.delete(botId)
    }
    return this.ensureStarted(this.registry.get(botId))
  }

  async startQr(botId) {
    const bot = this.registry.get(botId)
    if (!bot) throw new Error('机器人不存在')
    const channel = this.instances.get(botId) ?? await this.ensureStarted(bot)
    if (!channel?.startQr) throw new Error('这个通道不支持扫码')
    const qr = await channel.startQr()
    return qr ?? channel.qrStatus?.() ?? null
  }

  qrStatus(botId) {
    return this.instances.get(botId)?.qrStatus?.() ?? null
  }

  cancelQr(botId) {
    return this.instances.get(botId)?.cancelQr?.() ?? null
  }

  async startProvisionQr() {
    if (this.provision?.channel) {
      const qr = this.provision.channel.qrStatus?.()
      if (qr && (qr.status === 'pending' || qr.status === 'starting')) return { ...qr, botId: this.provision.botId || '' }
    }
    this.cancelProvision()
    const tempBot = {
      id: 'provision',
      channel: 'qq',
      name: 'QQ 机器人',
      credentials: { appId: '', appSecret: '' },
    }
    let created = false
    let channel
    channel = this.createQq(this.ctx, {
      bridge: this.bridge,
      getConfig: () => this.configFor(tempBot),
      logger: this.logger,
      botId: '',
      onLogin: async ({ appId, appSecret }) => {
        if (created) return
        created = true
        try {
          const bot = this.registry.add({
            channel: 'qq',
            name: 'QQ 机器人',
            credentials: { appId, appSecret },
          })
          if (this.provision?.channel === channel) {
            this.provision = { ...this.provision, botId: bot.id, error: '' }
          }
          appendLog(PATHS.diag, `扫码创建机器人 ${bot.id}`)
          void this.ensureStarted(bot).catch((error) => {
            appendLog(PATHS.diag, `机器人 ${bot.id} 后台连接失败：${error?.message ?? error}`)
          })
        } catch (error) {
          const message = String(error?.message ?? error)
          if (this.provision?.channel === channel) {
            this.provision = { ...this.provision, botId: '', error: message }
          }
          appendLog(PATHS.diag, '扫码创建机器人失败：' + message)
        } finally {
          setTimeout(() => { try { channel.stop() } catch { /* ignore */ } }, 100)
        }
      },
    })
    this.provision = { channel, botId: '', error: '' }
    try {
      const qr = await channel.startQr()
      return qr ?? channel.qrStatus?.() ?? null
    } catch (error) {
      this.cancelProvision()
      throw error
    }
  }

  provisionStatus() {
    if (!this.provision?.channel) return { status: 'idle', qr: null, botId: '', bot: null, error: '' }
    const qr = this.provision.channel.qrStatus?.() ?? null
    const botId = this.provision.botId || ''
    let bot = null
    if (botId) {
      try { bot = this.status().find((row) => row.id === botId) || null } catch { bot = null }
    }
    const error = String(this.provision.error || qr?.error || '')
    return {
      status: error ? 'error' : (qr?.status || 'idle'),
      qr,
      botId,
      bot,
      error,
    }
  }

  cancelProvision() {
    if (this.provision?.channel) {
      try { this.provision.channel.cancelQr?.() } catch { /* ignore */ }
      try { this.provision.channel.stop?.() } catch { /* ignore */ }
    }
    this.provision = null
  }

  async startProvisionChannel(channel, options = {}) {
    if (channel === 'qq') {
      await this.startProvisionQr()
      return this.provisionStatus()
    }
    return this.channelProvisioning.start(channel, options)
  }

  provisionChannelStatus(channel) {
    if (channel === 'qq') return this.provisionStatus()
    return this.channelProvisioning.status(channel)
  }

  cancelProvisionChannel(channel) {
    if (channel === 'qq') return this.cancelProvision()
    return this.channelProvisioning.cancel(channel)
  }

  async verifyProvision(channel, code) {
    if (channel !== 'webhook') throw new Error('这个通道不需要配对码')
    return this.channelProvisioning.verifyWechat(code)
  }

  addBot(input) {
    const bot = this.registry.add(input)
    if (bot.channel === 'qq' && this.registry.list('qq').length === 1) {
      try { this.onQqBotAdded?.() } catch { /* ignore */ }
    }
    if (bot.enabled !== false) void this.ensureStarted(bot)
    return bot
  }

  updateBot(botId, patch) {
    const current = this.registry.get(botId)
    let nextPatch = patch
    if (current && patch?.credentials && typeof patch.credentials === 'object') {
      const clean = Object.fromEntries(Object.entries(patch.credentials).filter(([, value]) => (
        typeof value === 'string' && value.trim() && !/^[•*]+$/.test(value.trim())
      )))
      nextPatch = { ...patch, credentials: { ...(current.credentials ?? {}), ...clean } }
    }
    const bot = this.registry.update(botId, nextPatch)
    if (nextPatch?.enabled === false) {
      const channel = this.instances.get(botId)
      try { channel?.stop?.() } catch { /* ignore */ }
      this.instances.delete(botId)
    } else if (nextPatch?.credentials) {
      void this.restart(botId)
    }
    return bot
  }

  removeBot(botId) {
    const channel = this.instances.get(botId)
    try { channel?.stop?.() } catch { /* ignore */ }
    this.instances.delete(botId)
    try {
      for (const chat of this.bridge?.listConversations?.() ?? []) {
        if (chat.botId === botId) this.bridge.removeConversation(chat.key)
      }
    } catch { /* ignore */ }
    return this.registry.remove(botId)
  }

  stopAll() {
    for (const channel of this.instances.values()) {
      try { channel.stop() } catch { /* ignore */ }
    }
    this.instances.clear()
    this.started = false
  }

  channel(botId) {
    return this.instances.get(botId) ?? null
  }

  async send(botId, textValue, payload = {}) {
    const channel = this.instances.get(botId)
    if (!channel?.send) throw new Error('这个机器人还没有连接')
    return channel.send(textValue, payload)
  }

  async testConnection(botId) {
    const bot = this.registry.get(botId)
    if (!bot) throw new Error('机器人不存在')
    const channel = this.instances.get(botId) ?? await this.ensureStarted(bot)
    if (!channel) throw new Error('机器人没有启动')
    const status = channel.status?.() ?? {}
    if (channel.tenantToken) {
      try {
        await channel.tenantToken(true)
        return { ok: true, message: '飞书凭据有效，tenant_access_token 已取到', status: channel.status?.() ?? status }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error), status: channel.status?.() ?? status }
      }
    }
    if (bot.channel === 'webhook') {
      if (bot.credentials?.token) {
        return { ok: true, message: '微信授权凭据已就绪（未实际发消息）', status }
      }
      const outboundUrl = String(bot.credentials?.outboundUrl ?? '').trim()
      if (!outboundUrl) return { ok: false, error: '还没有配置微信出站地址', status }
      return { ok: true, message: '微信入站路由已就绪（未实际发消息）', status }
    }
    if (bot.channel === 'qq') {
      return status.connected
        ? { ok: true, message: 'QQ 连接正常', status }
        : { ok: false, error: status.lastError || 'QQ 还没连接', status }
    }
    return { ok: false, error: '这个通道没有连接测试', status }
  }

  status() {
    return this.registry.list().map((bot) => {
      const channel = this.instances.get(bot.id)
      let status = {}
      try { status = channel?.status?.() ?? {} } catch (error) { status = { lastError: String(error?.message ?? error) } }
      const connected = status.connected === true
      const connecting = status.connecting === true
      const configured = status.configured === true
      const lastError = status.lastError ?? ''
      const state = connected ? 'connected' : (configured ? 'ready' : (lastError ? 'error' : (connecting ? 'connecting' : 'idle')))
      return {
        ...bot,
        online: connected || configured,
        status: {
          state,
          connected,
          configured,
          connecting,
          bound: status.bound === true,
          appId: status.appId ?? bot.credentials?.appId ?? '',
          lastError,
          error: lastError ? { code: 'connection-failed', message: lastError } : null,
          health: {
            state,
            lastCheckedAt: Date.now(),
            summary: connected ? '运行正常' : (lastError || (connecting ? '正在连接' : '未连接')),
          },
          qr: status.qr ?? null,
          since: status.connectedAt ?? 0,
        },
      }
    })
  }
}
