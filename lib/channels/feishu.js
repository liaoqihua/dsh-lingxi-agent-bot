// 灵犀 · 飞书通道（自建应用 + 事件回调）
// 入站：飞书把事件 POST 到 /api/companion/channels/feishu/event（需要公网可达）。
// 出站：tenant_access_token + im/v1/messages。
import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

import { PATHS } from '../config.js'
import { appendLog, chunkText, detectImageType, extractMarkdownImages, toPlainText } from '../util.js'

const PATH = '/api/companion/channels/feishu/event'
const API = 'https://open.feishu.cn/open-apis'

function parseJson(raw) {
  try { return JSON.parse(raw) } catch { return null }
}

function decryptFeishu(encryptKey, encrypted) {
  const key = createHash('sha256').update(encryptKey).digest()
  const iv = key.subarray(0, 16)
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  decipher.setAutoPadding(true)
  const out = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()])
  return out.toString('utf8')
}

function verifySignature(headers, rawBody, encryptKey) {
  if (!encryptKey) return true
  const timestamp = String(headers['x-lark-request-timestamp'] ?? '')
  const nonce = String(headers['x-lark-request-nonce'] ?? '')
  const signature = String(headers['x-lark-signature'] ?? '')
  if (!timestamp || !nonce || !signature) return false
  const expected = createHash('sha256').update(timestamp + nonce + encryptKey + rawBody).digest('hex')
  return expected === signature
}

function extractText(message) {
  const type = message?.message_type
  const content = parseJson(message?.content) ?? {}
  if (type === 'text') return String(content.text ?? '').trim()
  if (type === 'post') {
    const parts = []
    if (content.title) parts.push(String(content.title))
    const rows = Array.isArray(content.content) ? content.content : []
    for (const row of rows) {
      for (const item of Array.isArray(row) ? row : []) {
        if (item?.text) parts.push(String(item.text))
      }
    }
    return parts.join('\n').trim()
  }
  if (type === 'image') return ''
  if (type === 'audio') return '[语音]'
  if (type === 'file') return `[文件${content.file_name ? `：${content.file_name}` : ''}]`
  return `[${type || '消息'}]`
}

export class FeishuChannel {
  constructor(ctx, { bridge, getConfig, logger, botId = '', routePath = '', fetchImpl = fetch }) {
    this.ctx = ctx
    this.bridge = bridge
    this.getConfig = getConfig
    this.logger = logger
    this.botId = botId
    this.routePath = routePath || (botId ? `/api/companion/bots/${botId}/feishu/event` : PATH)
    this.fetchImpl = fetchImpl
    this.token = { value: '', expiresAt: 0 }
    this.lastError = ''
    this.lastEventAt = 0
    this.started = false
    this.routeDispose = null
  }

  get config() {
    return this.getConfig().channels.feishu
  }

  get configured() {
    return Boolean(this.config.appId && this.config.appSecret)
  }

  async tenantToken(force = false) {
    if (!force && this.token.value && this.token.expiresAt > Date.now() + 60_000) return this.token.value
    const response = await this.fetchImpl(`${API}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || body?.code !== 0 || !body?.tenant_access_token) {
      throw new Error(`飞书拿 tenant_access_token 失败（${body?.code ?? response.status}：${body?.msg ?? '未知'}）`)
    }
    this.token = { value: body.tenant_access_token, expiresAt: Date.now() + (Number(body.expire) || 7_200) * 1_000 }
    return this.token.value
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
      appendLog(PATHS.diag, `飞书回调路由注册失败：${error?.message ?? error}`)
    }
    if (this.configured) {
      this.tenantToken().catch((error) => {
        this.lastError = String(error?.message ?? error)
        appendLog(PATHS.diag, '飞书自检：' + this.lastError)
      })
    }
  }

  async handleHttp(req, res) {
    let raw = ''
    try {
      for await (const chunk of req) {
        raw += chunk
        if (raw.length > 2_000_000) break
      }
      const headers = Object.fromEntries(Object.entries(req.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]))
      if (!verifySignature(headers, raw, this.config.encryptKey)) {
        res.writeHead(401); res.end('bad signature'); return
      }
      let body = parseJson(raw)
      if (!body) { res.writeHead(400); res.end('bad json'); return }
      if (this.config.encryptKey && body.encrypt) {
        body = parseJson(decryptFeishu(this.config.encryptKey, body.encrypt))
        if (!body) { res.writeHead(400); res.end('bad encrypted body'); return }
      }
      if (body.type === 'url_verification') {
        if (this.config.verificationToken && body.token !== this.config.verificationToken) {
          res.writeHead(401); res.end('bad token'); return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ challenge: body.challenge }))
        return
      }
      const header = body.header ?? {}
      if (this.config.verificationToken && header.token && header.token !== this.config.verificationToken) {
        res.writeHead(401); res.end('bad token'); return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"code":0}')
      if (header.event_type === 'im.message.receive_v1') {
        void this.handleEvent(body.event ?? {})
      }
    } catch (error) {
      this.lastError = String(error?.message ?? error)
      appendLog(PATHS.diag, '飞书回调失败：' + this.lastError)
      try { res.writeHead(500); res.end('error') } catch { /* ignore */ }
    }
  }

  async handleEvent(event) {
    try {
      this.lastEventAt = Date.now()
      const message = event.message ?? {}
      const sender = event.sender ?? {}
      if (sender.sender_type === 'app' || sender.sender_type === 'bot') return
      const messageId = String(message.message_id ?? '')
      if (this.bridge.dedupe(`feishu:${messageId}`)) return
      const chatId = String(message.chat_id ?? '')
      if (!chatId) return
      const chatType = String(message.chat_type ?? 'p2p')
      const scope = chatType === 'p2p' ? 'c2c' : 'group'
      const mentions = Array.isArray(message.mentions) ? message.mentions : []
      if (scope === 'group' && this.config.requireMention && mentions.length === 0) return
      let text = extractText(message)
      for (const mention of mentions) {
        if (mention?.key && mention?.name) text = text.split(mention.key).join(`@${mention.name}`)
      }
      const openId = String(sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? '')
      const senderName = openId ? `飞书用户${openId.slice(-6)}` : '飞书用户'

      const images = []
      if (message.message_type === 'image' && message.content) {
        const content = parseJson(message.content) ?? {}
        const key = content.image_key
        if (key) {
          try {
            const token = await this.tenantToken()
            const response = await this.fetchImpl(`${API}/im/v1/messages/${messageId}/resources/${encodeURIComponent(key)}?type=image`, {
              headers: { authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(20_000),
            })
            if (response.ok) {
              const bytes = Buffer.from(await response.arrayBuffer())
              if (bytes.length <= 8 * 1024 * 1024) images.push({ bytes, mediaType: detectImageType(bytes), name: `feishu-${messageId}` })
            }
          } catch { /* 图片拿不到就只发文字 */ }
        }
      }

      const result = await this.bridge.deliverInbound({
        channel: 'feishu',
        botId: this.botId,
        scope,
        peerId: chatId,
        senderName,
        senderId: openId,
        title: scope === 'group' ? `飞书群 ${chatId.slice(-6)}` : `飞书 ${senderName}`,
        text,
        images,
        quote: '',
        target: { chatId },
        meta: { messageId },
      })
      // 会话没拉起来时把原因回给聊天。
      if (result?.notify) await this.#notifyBack(result.notify, chatId)
    } catch (error) {
      this.lastError = String(error?.message ?? error)
      appendLog(PATHS.diag, '飞书事件处理失败：' + this.lastError)
    }
  }

  /** 往原聊天回一句系统提示；发不出去就只留日志。 */
  async #notifyBack(text, chatId) {
    if (!chatId) {
      appendLog(PATHS.diag, `飞书提示无法回发（没有 chat_id）：${String(text).slice(0, 120)}`)
      return
    }
    try {
      const sent = await this.send({ record: { target: { chatId }, peerId: chatId }, text })
      if (!sent?.ok) appendLog(PATHS.diag, `飞书提示回发失败：${sent?.error ?? 'unknown'}`)
    } catch (error) {
      appendLog(PATHS.diag, `飞书提示回发异常：${error?.message ?? error}`)
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

  /** 上传到飞书拿 image_key，再发一条 image 消息。 */
  async #sendImage(chatId, token, source) {
    const bytes = await this.#readImageBytes(source)
    const form = new FormData()
    form.append('image_type', 'message')
    form.append('image', new Blob([bytes]), source.split(/[\\/]/).pop() || 'image.png')
    const upload = await this.fetchImpl(`${API}/im/v1/images`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    })
    const uploaded = await upload.json().catch(() => null)
    const imageKey = String(uploaded?.data?.image_key ?? '')
    if (!upload.ok || uploaded?.code !== 0 || !imageKey) {
      throw new Error(`飞书图片上传失败（${uploaded?.code ?? upload.status}：${uploaded?.msg ?? '未知'}）`)
    }
    const response = await this.fetchImpl(`${API}/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      }),
      signal: AbortSignal.timeout(20_000),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || body?.code !== 0) {
      throw new Error(`飞书图片发送失败（${body?.code ?? response.status}：${body?.msg ?? '未知'}）`)
    }
    return String(body?.data?.message_id ?? '')
  }

  async send({ record, text, limit }) {
    if (!this.configured) return { ok: false, error: '飞书 AppID / AppSecret 没填' }
    const chatId = String(record.target?.chatId || record.peerId)
    const token = await this.tenantToken()
    const max = Math.max(200, Number(limit) || this.config.maxChars || 1_500)
    // 图片先挑出来单独发，正文只留文字。
    const { text: withoutImages, images } = extractMarkdownImages(text)
    const chunks = chunkText(toPlainText(withoutImages), max)
    let firstId = ''
    for (const chunk of chunks) {
      const response = await this.fetchImpl(`${API}/im/v1/messages?receive_id_type=chat_id`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: chunk }),
        }),
        signal: AbortSignal.timeout(20_000),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || body?.code !== 0) {
        this.lastError = `飞书发送失败（${body?.code ?? response.status}：${body?.msg ?? '未知'}）`
        return { ok: false, error: this.lastError }
      }
      firstId ||= String(body?.data?.message_id ?? '')
    }
    let sentImages = 0
    let imageError = ''
    for (const source of images.slice(0, 4)) {
      try {
        // 注意：不能写成 firstId ||= await ...，firstId 有值时右侧根本不会执行，图就不发了。
        const imageMessageId = await this.#sendImage(chatId, token, source)
        firstId ||= imageMessageId
        sentImages += 1
      } catch (error) {
        imageError = String(error?.message ?? error)
        appendLog(PATHS.diag, `飞书图片发送失败（${source}）：${imageError}`)
      }
    }
    return { ok: true, messageId: firstId, images: sentImages, ...(imageError ? { imageError } : {}) }
  }

  status() {
    return {
      channel: 'feishu',
      botId: this.botId,
      enabled: this.config.enabled,
      configured: this.configured,
      bound: this.configured,
      connected: false,
      callback: this.routePath,
      requireMention: this.config.requireMention,
      tokenOk: Boolean(this.token.value && this.token.expiresAt > Date.now()),
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
    }
  }

  stop() {
    this.started = false
    this.token = { value: '', expiresAt: 0 }
    try { this.routeDispose?.() } catch { /* ignore */ }
    this.routeDispose = null
  }
}

export const feishuChannelPath = PATH
