// 灵犀 · 通用 Webhook 通道（微信等第三方桥接）
// 入站：POST /api/companion/channels/webhook/inbound
// 出站：把回复 POST 到设置里的 outboundUrl，由桥接服务转发到微信。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PATHS } from '../config.js'
import { appendLog, chunkText, detectImageType, extractMarkdownImages, toPlainText } from '../util.js'
import {
  extractWeixinInboundText, getWeixinUpdates, notifyWeixinStart, notifyWeixinStop,
  orderWeixinMessages, sendWeixinImage, sendWeixinText, WEIXIN_QR_BASE_URL,
} from '../weixin-api.js'

const PATH = '/api/companion/channels/webhook/inbound'

async function readImages(list) {
  const images = []
  for (const item of Array.isArray(list) ? list.slice(0, 4) : []) {
    try {
      if (item?.base64) {
        const bytes = Buffer.from(String(item.base64).replace(/^data:[^,]+,/, ''), 'base64')
        if (bytes.length <= 8 * 1024 * 1024) images.push({ bytes, mediaType: detectImageType(bytes), name: item.name || 'wechat-image' })
        continue
      }
      const url = String(item?.url ?? '')
      if (url && /^https?:/i.test(url)) {
        const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
        if (!response.ok) continue
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length <= 8 * 1024 * 1024) images.push({ bytes, mediaType: detectImageType(bytes), name: item.name || 'wechat-image' })
        continue
      }
      const path = String(item?.path ?? '')
      if (path && existsSync(path)) {
        const bytes = readFileSync(path)
        if (bytes.length <= 8 * 1024 * 1024) images.push({ bytes, mediaType: detectImageType(bytes), name: item.name || 'wechat-image' })
      }
    } catch { /* 单张失败不影响文本 */ }
  }
  return images
}

export class WebhookChannel {
  constructor(ctx, { bridge, getConfig, logger, botId = '', routePath = '', fetchImpl = fetch }) {
    this.ctx = ctx
    this.bridge = bridge
    this.getConfig = getConfig
    this.logger = logger
    this.botId = botId
    this.routePath = routePath || (botId ? `/api/companion/bots/${botId}/webhook/inbound` : PATH)
    this.lastError = ''
    this.lastEventAt = 0
    this.started = false
    this.routeDispose = null
    this.weixinAbort = null
    this.weixinConnected = false
    this.fetchImpl = fetchImpl
    this.weixinState = this.#loadWeixinState()
  }

  get config() {
    return this.getConfig().channels.webhook
  }

  #weixinStatePath() {
    if (!this.botId) return ''
    const safe = String(this.botId).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160)
    return join(PATHS.root, 'bots', safe, 'weixin.json')
  }

  #loadWeixinState() {
    const path = this.#weixinStatePath()
    if (!path || !existsSync(path)) return { version: 1, getUpdatesBuf: '', seenMessageIds: [] }
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      return {
        version: 1,
        getUpdatesBuf: typeof raw?.getUpdatesBuf === 'string' ? raw.getUpdatesBuf : '',
        seenMessageIds: Array.isArray(raw?.seenMessageIds)
          ? raw.seenMessageIds.filter((id) => typeof id === 'string' && id).slice(-200)
          : [],
      }
    } catch {
      return { version: 1, getUpdatesBuf: '', seenMessageIds: [] }
    }
  }

  #saveWeixinState() {
    const path = this.#weixinStatePath()
    if (!path) return
    try {
      writeFileSync(path, JSON.stringify(this.weixinState, null, 2), 'utf8')
    } catch (error) {
      appendLog(PATHS.diag, `微信轮询状态保存失败：${error?.message ?? error}`)
    }
  }

  async #runWeixinMonitor(signal) {
    let failures = 0
    try {
      await notifyWeixinStart({
        baseUrl: this.config.baseUrl || WEIXIN_QR_BASE_URL,
        token: this.config.token,
        fetchImpl: this.fetchImpl,
        signal,
      })
      this.weixinConnected = true
      this.lastError = ''
    } catch (error) {
      if (signal.aborted) return
      this.lastError = String(error?.message ?? error)
      appendLog(PATHS.diag, '微信连接启动失败：' + this.lastError)
    }
    while (!signal.aborted) {
      try {
        const response = await getWeixinUpdates({
          baseUrl: this.config.baseUrl || WEIXIN_QR_BASE_URL,
          token: this.config.token,
          getUpdatesBuf: this.weixinState.getUpdatesBuf,
          fetchImpl: this.fetchImpl,
          signal,
        })
        if (signal.aborted) return
        failures = 0
        this.weixinConnected = true
        this.lastEventAt = Date.now()
        this.lastError = ''
        for (const message of orderWeixinMessages(response.msgs)) {
          if (message?.message_type === 2) continue
          const messageId = String(message?.message_id ?? '')
          const sender = String(message?.from_user_id ?? '')
          if (!messageId || !sender || this.weixinState.seenMessageIds.includes(messageId)) continue
          const text = extractWeixinInboundText(message)
          if (!text) continue
          this.weixinState.seenMessageIds = [...this.weixinState.seenMessageIds, messageId].slice(-200)
          const result = await this.bridge.deliverInbound({
            channel: 'webhook',
            botId: this.botId,
            scope: 'c2c',
            peerId: sender,
            senderName: sender,
            senderId: sender,
            title: `${this.config.label || '微信'} ${sender}`,
            text,
            target: { conversation: sender },
            meta: { messageId },
          })
          if (result?.notify) await this.#notifyBack(result.notify, { peerId: sender, senderId: sender })
        }
        if (response.get_updates_buf !== this.weixinState.getUpdatesBuf) {
          this.weixinState.getUpdatesBuf = response.get_updates_buf
          this.#saveWeixinState()
        } else if (this.weixinState.seenMessageIds.length) {
          this.#saveWeixinState()
        }
      } catch (error) {
        if (signal.aborted) return
        failures += 1
        this.weixinConnected = false
        this.lastError = String(error?.message ?? error)
        appendLog(PATHS.diag, `微信消息同步失败（第 ${failures} 次）：${this.lastError}`)
        if (failures >= 3) break
        await new Promise((resolve) => setTimeout(resolve, Math.min(2_000 * failures, 10_000)))
      }
    }
  }

  start() {
    if (this.started) return
    this.started = true
    try {
      this.routeDispose = this.ctx.webServer.register({
        kind: 'exact',
        path: this.routePath,
        handler: (req, res) => this.handleHttp(req, res),
      })
    } catch (error) {
      appendLog(PATHS.diag, `Webhook 路由注册失败：${error?.message ?? error}`)
    }
    if (this.config.token) {
      appendLog(PATHS.diag, `微信原生轮询启动：${this.botId}`)
      this.weixinAbort = new AbortController()
      void this.#runWeixinMonitor(this.weixinAbort.signal).finally(() => {
        this.weixinConnected = false
      })
    }
  }

  async handleHttp(req, res) {
    try {
      if (req.method !== 'POST') { res.writeHead(405); res.end('POST only'); return }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const secret = this.config.secret
      if (secret) {
        const provided = String(req.headers['x-companion-secret'] ?? url.searchParams.get('secret') ?? '')
        if (provided !== secret) { res.writeHead(401); res.end('bad secret'); return }
      }
      let raw = ''
      for await (const chunk of req) {
        raw += chunk
        if (raw.length > 2_000_000) break
      }
      const body = JSON.parse(raw || '{}')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      void this.handleMessage(body)
    } catch (error) {
      this.lastError = String(error?.message ?? error)
      appendLog(PATHS.diag, 'Webhook 入站失败：' + this.lastError)
      try { res.writeHead(400); res.end('bad request') } catch { /* ignore */ }
    }
  }

  async handleMessage(body) {
    try {
      this.lastEventAt = Date.now()
      const messageId = body?.messageId ?? body?.message_id
      if (messageId && this.bridge.dedupe(`webhook:${messageId}`)) return
      const peerId = String(body?.conversation ?? body?.senderId ?? body?.senderName ?? body?.from ?? 'default')
      const scope = body?.group === true || body?.scope === 'group' ? 'group' : 'c2c'
      const senderName = String(body?.senderName ?? body?.sender ?? body?.nickname ?? peerId)
      const text = String(body?.text ?? body?.content ?? '').trim()
      const images = await readImages(body?.images ?? [])
      if (!text && !images.length) return
      const result = await this.bridge.deliverInbound({
        channel: 'webhook',
        botId: this.botId,
        scope,
        peerId,
        senderName,
        senderId: String(body?.senderId ?? body?.sender_id ?? ''),
        title: `${this.config.label} ${senderName}`,
        text,
        images,
        quote: String(body?.quote ?? '').slice(0, 300),
        target: { conversation: peerId },
        meta: { messageId: messageId ?? Date.now() },
      })
      // 会话没拉起来时把原因回给聊天。
      if (result?.notify) await this.#notifyBack(result.notify, { peerId, senderId: String(body?.senderId ?? body?.sender_id ?? '') })
    } catch (error) {
      this.lastError = String(error?.message ?? error)
      appendLog(PATHS.diag, 'Webhook 消息处理失败：' + this.lastError)
    }
  }

  /** 往原聊天回一句系统提示；发不出去就只留日志。 */
  async #notifyBack(text, { peerId, senderId = '' }) {
    if (!peerId) {
      appendLog(PATHS.diag, `Webhook 提示无法回发（没有会话标识）：${String(text).slice(0, 120)}`)
      return
    }
    try {
      const sent = await this.send({
        record: { channel: 'webhook', scope: 'c2c', peerId, senderId: senderId || peerId, target: { conversation: peerId } },
        text,
      })
      if (!sent?.ok) appendLog(PATHS.diag, `Webhook 提示回发失败：${sent?.error ?? 'unknown'}`)
    } catch (error) {
      appendLog(PATHS.diag, `Webhook 提示回发异常：${error?.message ?? error}`)
    }
  }

  /** 图片源 → 字节；http(s) 直接下载，本地路径读文件。 */
  async #readImageBytes(source) {
    if (/^https?:\/\//i.test(source)) {
      const response = await this.fetchImpl(source, { signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`)
      return Buffer.from(await response.arrayBuffer())
    }
    if (!existsSync(source)) throw new Error(`图片不存在：${source}`)
    return readFileSync(source)
  }

  /** 原生图片消息（iLink）。失败只记日志/回结果，不影响已经发出去的文字。 */
  async #sendWeixinImages(record, sources) {
    const errors = []
    let sent = 0
    for (const source of sources.slice(0, 4)) {
      try {
        const bytes = await this.#readImageBytes(source)
        await sendWeixinImage({
          baseUrl: this.config.baseUrl || WEIXIN_QR_BASE_URL,
          token: this.config.token,
          toUserId: record.senderId || record.peerId,
          bytes,
          fileName: source.split(/[\\/]/).pop() || 'image',
          fetchImpl: this.fetchImpl,
        })
        sent += 1
      } catch (error) {
        const message = String(error?.message ?? error)
        errors.push(message)
        appendLog(PATHS.diag, `微信图片发送失败（${source}）：${message}`)
      }
    }
    return { sent, errors }
  }

  async send({ record, text, limit }) {
    const max = Math.max(200, Number(limit) || this.config.maxChars || 1_500)
    // 先把 Markdown 图片挑出来：通道把它们作为原生图片发，正文只留文字。
    const { text: withoutImages, images } = extractMarkdownImages(text)
    const chunks = chunkText(toPlainText(withoutImages), max)
    if (this.config.token) {
      let messageId = ''
      try {
        for (const chunk of chunks) {
          const result = await sendWeixinText({
            baseUrl: this.config.baseUrl || WEIXIN_QR_BASE_URL,
            token: this.config.token,
            toUserId: record.senderId || record.peerId,
            text: chunk,
            fetchImpl: this.fetchImpl,
          })
          messageId ||= result.providerMessageIds?.[0] || ''
        }
      } catch (error) {
        this.lastError = String(error?.message ?? error)
        return { ok: false, error: this.lastError }
      }
      if (!images.length) return { ok: true, messageId }
      const result = await this.#sendWeixinImages(record, images)
      const imageError = result.errors[0] || ''
      if (imageError) this.lastError = imageError
      return {
        ok: true,
        messageId,
        images: result.sent,
        ...(imageError ? { imageError } : {}),
      }
    }
    const url = String(this.config.outboundUrl ?? '').trim()
    if (!url) {
      this.lastError = '没有配置出站地址（outboundUrl）'
      return { ok: false, error: 'Webhook 通道只配了入站；要让它回话，请填「出站地址」' }
    }
    let messageId = ''
    for (const chunk of chunks) {
      const headers = { 'content-type': 'application/json; charset=utf-8' }
      if (this.config.secret) headers['x-companion-secret'] = this.config.secret
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          channel: 'webhook',
          conversation: record.peerId,
          scope: record.scope,
          senderName: record.senderName,
          text: chunk,
        }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200)
        this.lastError = `Webhook 出站失败（HTTP ${response.status}${detail ? `：${detail}` : ''}）`
        return { ok: false, error: this.lastError }
      }
      const body = await response.json().catch(() => null)
      messageId ||= String(body?.messageId ?? body?.message_id ?? '')
    }
    if (images.length) {
      // 通用 Webhook 没有图片协议；图片只能由桥接侧自己实现，这里明确记一笔。
      appendLog(PATHS.diag, `Webhook 出站忽略 ${images.length} 张图片（通用出站只有文本协议）`)
    }
    return { ok: true, messageId, images: 0 }
  }

  status() {
    return {
      channel: 'webhook',
      botId: this.botId,
      enabled: this.config.enabled,
      label: this.config.label,
      inbound: this.routePath,
      outboundConfigured: Boolean(this.config.outboundUrl),
      secretConfigured: Boolean(this.config.secret),
      configured: Boolean(this.config.outboundUrl || this.config.token),
      bound: true,
      connected: this.weixinConnected === true,
      native: this.weixinConnected === true ? 'getupdates' : '',
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
    }
  }

  stop() {
    this.started = false
    try { this.routeDispose?.() } catch { /* ignore */ }
    this.routeDispose = null
    if (this.weixinAbort) {
      this.weixinAbort.abort()
      this.weixinAbort = null
    }
    this.weixinConnected = false
    if (this.config.token) {
      void notifyWeixinStop({
        baseUrl: this.config.baseUrl || WEIXIN_QR_BASE_URL,
        token: this.config.token,
        fetchImpl: this.fetchImpl,
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {})
    }
  }
}

export const webhookChannelPath = PATH
