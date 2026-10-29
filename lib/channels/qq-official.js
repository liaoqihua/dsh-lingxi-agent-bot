// 灵犀 · QQ 官方机器人通道（扫码登录 + 官方 SDK 收发 + 原生语音）
//
// 不再依赖 dsh-im 运行时，也不碰任何第三方 QQ 注入：
//   · 扫码：@tencent-connect/qqbot-connector
//   · 连接/收发：@tencent-connect/qqbot-nodejs（WebSocket 官方网关）
//   · 语音：同一个 SDK 的 sendVoice，REST 上传
import QRCode from 'qrcode'
import { startQrConnect } from '@tencent-connect/qqbot-connector'
import { QQBot } from '@tencent-connect/qqbot-nodejs'
import { existsSync } from 'node:fs'

import { PATHS } from '../config.js'
import { appendLog, chunkText, detectImageType, extractMarkdownImages, sleep, toPlainText } from '../util.js'

const CONNECT_TIMEOUT_MS = 20_000

function maskAppId(value) {
  const text = String(value ?? '')
  if (text.length <= 10) return text
  return `${text.slice(0, 6)}…${text.slice(-4)}`
}

function messageIdOf(response) {
  return String(response?.id ?? response?.message_id ?? response?.messageId ?? '')
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/<@!?[^>]+>/g, ' ')
    .replace(/<faceType=[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function attachmentKind(att) {
  const type = String(att?.content_type ?? '').toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('audio/') || type.includes('voice') || att?.voice_wav_url) return 'voice'
  if (type.startsWith('video/')) return 'video'
  return 'file'
}

export class QQOfficialChannel {
  constructor(ctx, {
    bridge, getConfig, logger, onLogin, botId = '',
    createBot = (options) => new QQBot(options),
    startQr = startQrConnect,
    encodeQr = (url) => QRCode.toDataURL(url, { margin: 1, width: 320 }),
  }) {
    this.ctx = ctx
    this.bridge = bridge
    this.getConfig = getConfig
    this.logger = logger
    this.onLogin = onLogin
    this.botId = botId
    this.createBot = createBot
    this.startQrConnect = startQr
    this.encodeQr = encodeQr
    this.bot = null
    this.connected = false
    this.connecting = false
    this.connectedAt = 0
    this.started = false
    this.retryTimer = null
    this.abortController = null
    this.runTask = null
    this.lastError = ''
    this.lastEventAt = 0
    this.ownerOpenId = ''
    this.qr = null
  }

  get config() {
    return this.getConfig().channels?.qq ?? {}
  }

  async start() {
    if (this.started) return this.status()
    this.started = true
    if (!this.config.appId || !this.config.appSecret) {
      this.lastError = '还没有绑定 QQ 机器人，点“生成 QQ 二维码”扫码'
      return this.status()
    }
    await this.reconnect()
    return this.status()
  }

  stop() {
    this.started = false
    this.connecting = false
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.abortController?.abort()
    this.abortController = null
    this.runTask?.catch(() => {})
    this.runTask = null
    this.cancelQr()
    this.#stopBot()
    return this.status()
  }

  async reconnect() {
    this.#stopBot()
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    const config = this.config
    if (!config.appId || !config.appSecret) {
      this.lastError = '还没有绑定 QQ 机器人'
      return this.status()
    }
    this.connecting = true
    const sdkLogger = {
      debug() {},
      info: (...args) => this.logger?.info?.(...args),
      warn: (...args) => this.logger?.warn?.(...args),
      error: (...args) => this.logger?.warn?.(...args),
    }
    const bot = this.createBot({
      appId: config.appId,
      appSecret: config.appSecret,
      accountId: 'dsh-lingxi-agent-bot',
      logger: sdkLogger,
      transport: 'websocket',
      tokenPrefetch: 'sync',
      markdownSupport: false,
    })
    if (!bot || typeof bot.start !== 'function') throw new Error('QQ SDK 没有返回可用的 bot')
    const controller = new AbortController()
    this.bot = bot
    this.abortController = controller

    let readyResolve
    let readyReject
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
    const markReady = () => {
      this.connected = true
      this.connectedAt = Date.now()
      this.lastError = ''
      readyResolve()
    }
    const onError = (error) => {
      if (!this.connected) readyReject(error)
      else this.lastError = String(error?.message ?? error)
    }
    bot.on('ready', markReady)
    bot.on('resumed', markReady)
    bot.on('error', onError)
    bot.on('rawEvent', (context) => {
      appendLog(PATHS.diag, `QQ 原始事件：${context?.eventType ?? ''}`)
    })
    bot.on('message', (context, message) => {
      appendLog(PATHS.diag, `QQ 收到消息（${message?.messageId ?? ''}）`)
      void this.#onMessage(message).catch((error) => {
        this.lastError = String(error?.message ?? error)
        appendLog(PATHS.diag, 'QQ 入站处理失败：' + this.lastError)
      })
    })

    const runTask = Promise.resolve().then(() => bot.start(controller.signal))
    this.runTask = runTask
    runTask.catch((error) => {
      if (controller.signal.aborted) return
      if (!this.connected) readyReject(error)
      else this.lastError = String(error?.message ?? error)
    })

    let timer
    try {
      await Promise.race([
        ready,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('QQ WebSocket 没有在时间内就绪')), CONNECT_TIMEOUT_MS)
        }),
      ])
      this.connected = true
      this.connectedAt = Date.now()
      this.lastError = ''
      appendLog(PATHS.diag, `QQ 机器人已连接（${maskAppId(config.appId)}）`)
    } catch (error) {
      this.connected = false
      this.lastError = String(error?.message ?? error)
      appendLog(PATHS.diag, 'QQ 机器人连接失败：' + this.lastError)
      controller.abort()
      this.#scheduleRetry()
    } finally {
      clearTimeout(timer)
      this.connecting = false
    }
    return this.status()
  }

  #scheduleRetry() {
    if (!this.started || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.reconnect()
    }, 15_000)
    this.retryTimer.unref?.()
  }

  #stopBot() {
    const bot = this.bot
    this.bot = null
    this.connected = false
    if (bot) {
      try { bot.stop?.() } catch { /* ignore */ }
    }
  }

  async #onMessage(message) {
    if (!message || message.senderIsBot === true) return
    if (message.kind !== 'c2c' && message.kind !== 'group') return
    const target = message.replyTarget
    if (!target?.targetId || !target?.scope) return
    if (this.bridge.dedupe(`qq:${message.messageId}`)) return
    const group = message.kind === 'group'
    const peerId = group
      ? String(message.groupOpenid || target.targetId)
      : String(message.senderId || target.targetId)
    const config = this.getConfig()
    const senderName = String(
      group
        ? (message.senderName || message.senderId || peerId)
        : (config.identity?.ownerName || message.senderName || message.senderId || peerId),
    ).slice(0, 80)
    this.lastEventAt = Date.now()

    let text = cleanText(message.content)
    const images = []
    for (const attachment of (message.attachments ?? []).slice(0, 4)) {
      const kind = attachmentKind(attachment)
      if (kind === 'image' && attachment.url) {
        try {
          const response = await fetch(attachment.url, { signal: AbortSignal.timeout(15_000) })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const bytes = Buffer.from(await response.arrayBuffer())
          images.push({
            bytes,
            mediaType: attachment.content_type || detectImageType(bytes) || 'image/png',
            name: attachment.filename || `qq-${message.messageId}.png`,
          })
        } catch (error) {
          appendLog(PATHS.diag, 'QQ 图片下载失败：' + (error?.message ?? error))
        }
      } else if (kind === 'voice') {
        const asr = cleanText(attachment.asr_refer_text)
        text = `${text}${text ? '\n' : ''}${asr ? `[语音转写：${asr}]` : '[收到一条语音]'}`
      }
    }
    if (!text && !images.length) text = '[收到一条无法显示的消息]'
    const result = await this.bridge.deliverInbound({
      channel: 'qq',
      botId: this.botId,
      botName: this.config.name || '',
      scope: group ? 'group' : 'c2c',
      peerId,
      senderName,
      senderId: String(message.senderId || ''),
      title: group ? `QQ群 ${peerId}` : `QQ ${senderName}`,
      text,
      images,
      target: { scope: target.scope, targetId: String(target.targetId) },
      meta: { messageId: message.messageId },
    })
    // 会话没拉起来时把原因回给聊天，别让用户觉得消息石沉大海。
    if (result?.notify) await this.#notifyBack(result.notify, target)
  }

  /** 往原聊天回一句系统提示；目标不可用就只留日志。 */
  async #notifyBack(text, target) {
    const scope = String(target?.scope ?? '')
    const targetId = String(target?.targetId ?? '')
    if (!scope || !targetId) {
      appendLog(PATHS.diag, `QQ 提示无法回发（没有回复目标）：${String(text).slice(0, 120)}`)
      return
    }
    try {
      const sent = await this.send({ record: { target: { scope, targetId } }, text })
      if (!sent?.ok) appendLog(PATHS.diag, `QQ 提示回发失败：${sent?.error ?? 'unknown'}`)
    } catch (error) {
      appendLog(PATHS.diag, `QQ 提示回发异常：${error?.message ?? error}`)
    }
  }

  async send({ record, text, limit }) {
    if (!this.bot || !this.connected) {
      return { ok: false, error: this.lastError || 'QQ 机器人未连接' }
    }
    const target = record?.target
    if (!target?.scope || !target?.targetId) {
      return { ok: false, error: '这个 QQ 聊天没有回复目标' }
    }
    const max = Math.max(200, Number(limit) || this.config.maxChars || 1_500)
    const { text: withoutImages, images: imageRefs } = extractMarkdownImages(text)
    const chunks = chunkText(toPlainText(withoutImages), max)
    let messageId = ''
    let sentImages = 0
    let imageError = ''
    try {
      for (const chunk of chunks) {
        const response = await this.bot.sendText({ scope: target.scope, targetId: String(target.targetId) }, chunk)
        messageId ||= messageIdOf(response)
        await sleep(120)
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
    // 图片单独兜错：文字已经发出去了，一张图失败不该让整轮出站算失败。
    for (const src of imageRefs.slice(0, 4)) {
      const source = /^https?:\/\//i.test(src)
        ? { url: src }
        : (existsSync(src) ? { localPath: src } : null)
      if (!source) {
        imageError ||= `图片不存在：${src}`
        continue
      }
      try {
        const response = await this.bot.sendImage({ scope: target.scope, targetId: String(target.targetId) }, source)
        messageId ||= messageIdOf(response?.message)
        sentImages += 1
        await sleep(120)
      } catch (error) {
        imageError = String(error?.message ?? error)
        appendLog(PATHS.diag, `QQ 图片发送失败（${src}）：${imageError}`)
      }
    }
    return { ok: true, messageId, images: sentImages, ...(imageError ? { imageError } : {}) }
  }

  async sendVoice({ record, file }) {
    if (!this.bot || !this.connected) {
      return { ok: false, error: this.lastError || 'QQ 机器人未连接' }
    }
    const target = record?.target
    if (!target?.scope || !target?.targetId) {
      return { ok: false, error: '这个 QQ 聊天没有回复目标' }
    }
    const result = await this.bot.sendVoice(
      { scope: target.scope, targetId: String(target.targetId) },
      { localPath: file },
    )
    return { ok: true, messageId: messageIdOf(result?.message) }
  }

  /** 生成二维码；返回时二维码图片可能还在编码，前端轮询 qrStatus。 */
  startQr() {
    this.cancelQr()
    const state = {
      id: `qq-${Date.now()}`,
      status: 'starting',
      qrCodeDataUrl: '',
      verificationUrl: '',
      error: '',
      startedAt: Date.now(),
      stop: null,
    }
    this.qr = state
    try {
      const stop = this.startQrConnect({
        onQrDisplayed: (url) => {
          if (this.qr !== state) return
          state.verificationUrl = String(url || '')
          state.status = 'pending'
          Promise.resolve()
            .then(() => this.encodeQr(state.verificationUrl))
            .then((dataUrl) => {
              if (this.qr !== state) return
              state.qrCodeDataUrl = dataUrl
            })
            .catch((error) => {
              if (this.qr !== state) return
              state.status = 'failed'
              state.error = String(error?.message ?? error)
            })
        },
        onQrExpired: () => {
          if (this.qr !== state) return
          state.status = 'refreshing'
          state.qrCodeDataUrl = ''
        },
        onSuccess: (credentials) => {
          void (async () => {
            if (this.qr !== state) return
            state.status = 'saving'
            try {
              const first = Array.isArray(credentials) ? credentials[0] : null
              const appId = String(first?.appId ?? '').trim()
              const appSecret = String(first?.appSecret ?? '').trim()
              if (!appId || !appSecret) throw new Error('扫码结果没有拿到 AppID/AppSecret')
              if (typeof this.onLogin === 'function') await this.onLogin({ appId, appSecret })
              state.status = 'connected'
              state.qrCodeDataUrl = ''
              appendLog(PATHS.diag, `QQ 扫码绑定成功（${maskAppId(appId)}）`)
            } catch (error) {
              state.status = 'failed'
              state.error = String(error?.message ?? error)
              appendLog(PATHS.diag, 'QQ 扫码保存失败：' + state.error)
            } finally {
              try { state.stop?.() } catch { /* ignore */ }
              state.stop = null
            }
          })()
        },
        onFailure: (error) => {
          if (this.qr !== state) return
          state.status = 'failed'
          state.error = String(error?.message ?? error)
          state.stop = null
        },
      }, { displayQrCodeToConsole: false, source: 'dsh-lingxi-agent-bot' })
      state.stop = typeof stop === 'function' ? stop : null
    } catch (error) {
      state.status = 'failed'
      state.error = String(error?.message ?? error)
    }
    return this.qrStatus()
  }

  cancelQr() {
    if (this.qr?.stop) {
      try { this.qr.stop() } catch { /* ignore */ }
    }
    if (this.qr && this.qr.status !== 'connected') {
      this.qr.status = 'cancelled'
      this.qr.stop = null
    }
    return this.qrStatus()
  }

  qrStatus() {
    const state = this.qr ?? {}
    return {
      status: state.status ?? 'idle',
      qrCodeDataUrl: state.qrCodeDataUrl ?? '',
      verificationUrl: state.verificationUrl ?? '',
      error: state.error ?? '',
      startedAt: state.startedAt ?? 0,
      connected: this.connected || state.status === 'connected',
      bound: Boolean(this.config.appId && this.config.appSecret),
    }
  }

  status() {
    const config = this.config
    return {
      channel: 'qq',
      enabled: config.enabled !== false,
      bound: Boolean(config.appId && config.appSecret),
      connected: this.connected,
      connecting: this.connecting,
      appId: maskAppId(config.appId),
      connectedAt: this.connectedAt,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      qr: this.qrStatus(),
    }
  }
}
