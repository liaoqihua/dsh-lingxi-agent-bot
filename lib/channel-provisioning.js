// 飞书 / 微信扫码接入状态机：授权完成前不写 BotRegistry。
// 参考 dsh-im（MIT）的设备注册与 iLink 登录流程，保留当前插件需要的精简实现。
import { randomUUID } from 'node:crypto'
import QRCode from 'qrcode'
import { beginLogin, normalizeWeixinApiBaseUrl, pollLogin, WEIXIN_QR_BASE_URL } from './weixin-api.js'

const FEISHU_SCOPES = [
  'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly',
  'im:message.group_at_msg.include_bot:readonly',
  'im:message.group_msg',
  'im:message:readonly',
  'im:message:send_as_bot',
  'im:message.reactions:write_only',
  'im:message.recall',
  'im:resource',
  'cardkit:card:write',
]
const ACTIVE_STATES = new Set(['starting', 'pending', 'scanned', 'needs_verification', 'connecting', 'saving'])

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function feishuEndpoint(domain, path) {
  const origin = domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
  return new URL(path, origin).href
}

function expectFeishuJson(body, operation) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`${operation} 返回了无效响应`)
  if (body.code !== 0) throw new Error(`${operation} 失败：${body.msg || `code ${body.code}`}`)
  return body
}

async function verifyFeishuApp({ appId, appSecret, domain, lark }) {
  const http = lark.defaultHttpInstance
  if (!http || typeof http.request !== 'function') throw new Error('飞书验证缺少 HTTP 客户端')
  const tokenBody = expectFeishuJson(await http.request({
    method: 'POST',
    url: feishuEndpoint(domain, '/open-apis/auth/v3/tenant_access_token/internal'),
    headers: { 'content-type': 'application/json; charset=utf-8' },
    data: { app_id: appId, app_secret: appSecret },
    timeout: 15_000,
    signal: AbortSignal.timeout(15_000),
  }), '飞书认证')
  if (!tokenBody.tenant_access_token) throw new Error('飞书认证没有返回 tenant_access_token')
  const botBody = expectFeishuJson(await http.request({
    method: 'GET',
    url: feishuEndpoint(domain, '/open-apis/bot/v3/info/'),
    headers: { authorization: `Bearer ${tokenBody.tenant_access_token}` },
    timeout: 15_000,
    signal: AbortSignal.timeout(15_000),
  }), '飞书机器人验证')
  return botBody.bot ?? {}
}

export class ChannelProvisioning {
  constructor({ registry, startBot, getConfig, lark = null, fetchImpl = fetch, encodeQr = null, pollIntervalMs = 1000 } = {}) {
    if (!registry) throw new Error('ChannelProvisioning 需要 registry')
    this.registry = registry
    this.startBot = startBot || (async () => {})
    this.getConfig = getConfig || (() => ({}))
    this.lark = lark
    this.fetchImpl = fetchImpl
    this.encodeQr = encodeQr || ((url) => QRCode.toDataURL(url, { margin: 1, width: 320 }))
    this.pollIntervalMs = Math.max(1, Number(pollIntervalMs) || 1000)
    this.attempts = new Map()
  }

  #public(attempt) {
    if (!attempt) return { status: 'idle', qr: null, botId: '', bot: null }
    if (ACTIVE_STATES.has(attempt.state) && attempt.expiresAt && Date.now() >= attempt.expiresAt) {
      attempt.state = 'expired'
      attempt.error = '二维码已过期，请重新生成。'
      attempt.controller.abort()
    }
    const bot = attempt.botId ? this.registry.get(attempt.botId) : null
    return {
      status: attempt.state,
      qr: {
        status: attempt.state,
        qrCodeDataUrl: attempt.qrCodeDataUrl || null,
        verificationUrl: attempt.qrCodeUrl || null,
        verificationRequired: attempt.state === 'needs_verification',
        expiresAt: attempt.expiresAt || 0,
        error: attempt.error || null,
      },
      botId: attempt.botId || '',
      bot,
    }
  }

  status(channel) {
    return this.#public(this.attempts.get(channel))
  }

  async whenSettled(channel) {
    const attempt = this.attempts.get(channel)
    if (!attempt) return this.status(channel)
    await attempt.task
    return this.status(channel)
  }

  cancel(channel) {
    const attempt = this.attempts.get(channel)
    if (!attempt) return this.status(channel)
    if (ACTIVE_STATES.has(attempt.state)) {
      attempt.state = 'cancelled'
      attempt.error = '扫码绑定已取消。'
      attempt.controller.abort()
    }
    return this.#public(attempt)
  }

  async start(channel, options = {}) {
    if (channel === 'feishu') return this.#startFeishu(options)
    if (channel === 'webhook') return this.#startWechat(options)
    throw new Error(`这个通道不支持扫码接入：${channel}`)
  }

  async verifyWechat(code) {
    const attempt = this.attempts.get('webhook')
    if (!attempt || attempt.state !== 'needs_verification') throw new Error('当前没有需要配对码的微信接入任务')
    const value = String(code ?? '').trim()
    if (!/^\d{4,8}$/.test(value)) throw new Error('配对码必须是 4-8 位数字')
    attempt.verifyCode = value
    attempt.state = 'scanned'
    return this.#public(attempt)
  }

  #newAttempt(channel, options) {
    this.cancel(channel)
    const attempt = {
      id: randomUUID(),
      channel,
      name: text(options.name),
      state: 'starting',
      controller: new AbortController(),
      qrcode: '',
      qrCodeUrl: '',
      qrCodeDataUrl: '',
      expiresAt: 0,
      verifyCode: '',
      botId: '',
      error: '',
      task: null,
    }
    this.attempts.set(channel, attempt)
    return attempt
  }

  #fail(attempt, error) {
    if (attempt.controller.signal.aborted || error?.name === 'AbortError') {
      attempt.state = 'cancelled'
      attempt.error = '扫码绑定已取消。'
    } else {
      attempt.state = 'error'
      attempt.error = String(error?.message ?? error)
    }
  }

  // 扫码接入时新建的机器人，两段新会话默认配置留空：接入流程还不知道用户要哪个工作区，
  // 由用户在设置页「新会话默认配置」里补；缺工作区会在运行时明确报错，不静默回落。
  async #startFeishu(options) {
    const attempt = this.#newAttempt('feishu', options)
    if (!this.lark) this.lark = await import('@larksuiteoapi/node-sdk')
    let qrResolve
    const qrReady = new Promise((resolve) => { qrResolve = resolve })
    attempt.task = (async () => {
      try {
        const result = await this.lark.registerApp({
          source: 'deepseek-harness',
          createOnly: true,
          appPreset: {
            name: attempt.name || '灵犀 AI 助手',
            desc: '连接飞书与 DeepSeek Harness，在聊天中使用企业 AI 助手。',
          },
          addons: {
            preset: false,
            scopes: { tenant: [...FEISHU_SCOPES] },
            events: { items: { tenant: ['im.message.receive_v1'] } },
            callbacks: { items: ['card.action.trigger'] },
          },
          signal: attempt.controller.signal,
          onQRCodeReady: async (info) => {
            if (attempt.state !== 'starting') return
            const url = text(info?.url)
            const seconds = Number(info?.expireIn)
            if (!url || !Number.isFinite(seconds) || seconds <= 0) throw new Error('飞书返回了无效二维码')
            attempt.qrCodeUrl = url
            attempt.qrCodeDataUrl = await this.encodeQr(url)
            attempt.expiresAt = Date.now() + seconds * 1000
            attempt.state = 'pending'
            qrResolve()
          },
          onStatusChange: (info) => {
            if (!ACTIVE_STATES.has(attempt.state) || attempt.state === 'saving' || attempt.state === 'connecting') return
            if (info?.status === 'slow_down' || info?.status === 'polling' || info?.status === 'domain_switched') {
              attempt.state = 'pending'
            }
          },
        })
        const appId = text(result?.client_id)
        const appSecret = text(result?.client_secret)
        const ownerOpenId = text(result?.user_info?.open_id)
        if (attempt.controller.signal.aborted || attempt.state === 'cancelled' || attempt.state === 'expired') {
          throw new DOMException('Provisioning was cancelled', 'AbortError')
        }
        if (!appId || !appSecret || !ownerOpenId) throw new Error('飞书注册返回的凭据不完整')
        const domain = result.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu'
        attempt.state = 'saving'
        const info = await verifyFeishuApp({ appId, appSecret, domain, lark: this.lark })
        if (attempt.controller.signal.aborted || attempt.state === 'cancelled' || attempt.state === 'expired') {
          throw new DOMException('Provisioning was cancelled', 'AbortError')
        }
        const bot = this.registry.add({
          channel: 'feishu',
          name: text(info.app_name ?? info.bot_name, attempt.name || '飞书机器人'),
          credentials: { appId, appSecret, ownerOpenId },
        })
        attempt.botId = bot.id
        if (attempt.controller.signal.aborted || attempt.state === 'cancelled' || attempt.state === 'expired') {
          throw new DOMException('Provisioning was cancelled', 'AbortError')
        }
        await this.startBot(bot)
        attempt.state = 'connected'
        attempt.error = ''
      } catch (error) {
        this.#fail(attempt, error)
      }
    })()
    let qrTimer = null
    try {
      await Promise.race([
        qrReady,
        new Promise((resolve) => { qrTimer = setTimeout(resolve, 20_000) }),
        attempt.task,
      ])
    } finally {
      if (qrTimer) clearTimeout(qrTimer)
    }
    return this.#public(attempt)
  }

  async #startWechat(options) {
    const attempt = this.#newAttempt('webhook', options)
    const localTokens = this.registry.list('webhook').map((bot) => text(bot.credentials?.token)).filter(Boolean)
    try {
      const login = await beginLogin({ localTokens, fetchImpl: this.fetchImpl, signal: attempt.controller.signal })
      attempt.qrcode = login.qrcode
      attempt.qrCodeUrl = login.qrcodeUrl
      attempt.qrCodeDataUrl = await this.encodeQr(login.qrcodeUrl)
      attempt.expiresAt = Date.now() + 5 * 60_000
      attempt.state = 'pending'
      attempt.baseUrl = WEIXIN_QR_BASE_URL
    } catch (error) {
      this.#fail(attempt, error)
      return this.#public(attempt)
    }
    attempt.task = this.#pollWechat(attempt)
    return this.#public(attempt)
  }

  async #pollWechat(attempt) {
    try {
      while (ACTIVE_STATES.has(attempt.state)) {
        if (Date.now() >= attempt.expiresAt) {
          attempt.state = 'expired'
          attempt.error = '二维码已过期，请重新生成。'
          break
        }
        const response = await pollLogin({
          qrcode: attempt.qrcode,
          baseUrl: attempt.baseUrl,
          verifyCode: attempt.verifyCode,
          fetchImpl: this.fetchImpl,
          signal: attempt.controller.signal,
        })
        if (response.status === 'wait' || response.status === 'scaned') {
          attempt.state = response.status === 'wait' ? 'pending' : 'scanned'
        } else if (response.status === 'need_verifycode') {
          attempt.state = 'needs_verification'
        } else if (response.status === 'verify_code_blocked') {
          attempt.state = 'error'
          attempt.error = '配对码多次错误，请重新生成二维码。'
          break
        } else if (response.status === 'expired') {
          attempt.state = 'expired'
          attempt.error = '二维码已过期，请重新生成。'
          break
        } else if (response.status === 'scaned_but_redirect') {
          attempt.baseUrl = normalizeWeixinApiBaseUrl(response.redirect_host)
          attempt.state = 'scanned'
        } else if (response.status === 'binded_redirect') {
          attempt.state = 'error'
          attempt.error = '该微信账号已绑定；如需恢复，请使用已有机器人。'
          break
        } else if (response.status === 'confirmed') {
          const token = text(response.bot_token)
          const accountId = text(response.ilink_bot_id)
          const ownerOpenId = text(response.ilink_user_id)
          if (!token || !accountId || !ownerOpenId) throw new Error('微信授权成功，但返回的账号凭据不完整。')
          attempt.state = 'connecting'
          const baseUrl = normalizeWeixinApiBaseUrl(response.baseurl || attempt.baseUrl)
          const bot = this.registry.add({
            channel: 'webhook',
            name: attempt.name || '微信机器人',
            credentials: { token, accountId, ownerOpenId, baseUrl, outboundUrl: baseUrl, secret: '' },
          })
          attempt.botId = bot.id
          await this.startBot(bot)
          attempt.state = 'connected'
          attempt.error = ''
          break
        }
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs))
      }
    } catch (error) {
      this.#fail(attempt, error)
    }
  }
}
