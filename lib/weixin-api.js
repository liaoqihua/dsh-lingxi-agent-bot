// 微信 iLink 的最小原生 API：扫码登录、文本发送与图片发送。
// 协议与 dsh-im（MIT）保持一致；只引入当前插件实际使用的能力。
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'

export const WEIXIN_QR_BASE_URL = 'https://ilinkai.weixin.qq.com/'
export const WEIXIN_PROTOCOL_VERSION = '2.4.6'
export const DEFAULT_BOT_TYPE = '3'

const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const WEIXIN_CDN_HOST = 'novac2c.cdn.weixin.qq.com'
const WEIXIN_CDN_UPLOAD_CHUNK_BYTES = 256 * 1024
/** 微信图片消息的 media_type */
const WEIXIN_MEDIA_IMAGE = 1

const LOGIN_STATUSES = new Set([
  'wait', 'scaned', 'confirmed', 'expired', 'scaned_but_redirect',
  'need_verifycode', 'verify_code_blocked', 'binded_redirect',
])

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isWeixinHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  return normalized === 'weixin.qq.com' || normalized.endsWith('.weixin.qq.com')
    || normalized === 'wechat.com' || normalized.endsWith('.wechat.com')
}

export function normalizeWeixinApiBaseUrl(value) {
  const raw = nonEmptyString(value) || WEIXIN_QR_BASE_URL
  let url
  try { url = new URL(raw.includes('://') ? raw : `https://${raw}`) } catch { throw new Error('微信服务返回了无效的连接地址。') }
  if (url.protocol !== 'https:' || !isWeixinHost(url.hostname)
    || (url.port !== '' && url.port !== '443')) {
    throw new Error('微信服务返回了不受信任的连接地址。')
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.toString()
}

function normalizeWeixinQrUrl(value) {
  const text = nonEmptyString(value)
  if (!text) throw new Error('微信服务没有返回扫码地址。')
  let url
  try { url = new URL(text) } catch { throw new Error('微信服务返回了无效的扫码地址。') }
  if (url.protocol !== 'https:' || !isWeixinHost(url.hostname)) {
    throw new Error('微信服务返回了不受信任的扫码地址。')
  }
  return url.toString()
}

function commonHeaders() {
  return {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 6),
  }
}

function authenticatedHeaders(token) {
  const headers = {
    ...commonHeaders(),
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
  }
  if (nonEmptyString(token)) headers.Authorization = `Bearer ${token.trim()}`
  return headers
}

function baseInfo() {
  return { channel_version: WEIXIN_PROTOCOL_VERSION, bot_agent: 'DeepSeekHarness/1.1.0' }
}

function rejectedProviderResponse(value, fields = ['ret', 'errcode']) {
  if (!value || typeof value !== 'object') return null
  for (const field of fields) {
    if (value[field] !== undefined && value[field] !== 0 && value[field] !== '0') {
      return String(value[field])
    }
  }
  return null
}

async function requestJson(fetchImpl, {
  method,
  baseUrl,
  endpoint,
  body,
  token,
  timeoutMs = 15_000,
  signal,
  authenticated = true,
}) {
  const trustedBase = normalizeWeixinApiBaseUrl(baseUrl)
  const url = new URL(endpoint, trustedBase)
  if (!isWeixinHost(url.hostname)) throw new Error('拒绝访问不受信任的微信服务地址。')
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted) throw new Error('微信请求已取消。')
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null
  const work = (async () => {
    const response = await fetchImpl(url, {
      method,
      headers: authenticated ? authenticatedHeaders(token) : commonHeaders(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`微信服务请求失败（HTTP ${response.status}）。`)
    try {
      return await response.json()
    } catch (error) {
      throw new Error('微信服务返回了无法解析的响应。', { cause: error })
    }
  })()
  const cancelled = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('微信请求已取消。')), { once: true })
  })
  try {
    return await Promise.race([work, cancelled])
  } catch (error) {
    if (signal?.aborted) throw new Error('微信请求已取消。')
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export async function beginLogin({ localTokens = [], botType = DEFAULT_BOT_TYPE, fetchImpl = fetch, signal } = {}) {
  const tokens = [...new Set(localTokens.map(nonEmptyString).filter(Boolean))].slice(-10)
  const response = await requestJson(fetchImpl, {
    method: 'POST',
    baseUrl: WEIXIN_QR_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: { local_token_list: tokens },
    timeoutMs: 10_000,
    signal,
    authenticated: false,
  })
  const providerCode = rejectedProviderResponse(response, ['errcode', 'ret'])
  if (providerCode) throw new Error(`微信服务拒绝了二维码申请（${providerCode}）。`)
  const qrcode = nonEmptyString(response?.qrcode)
  if (!qrcode) throw new Error('微信服务没有返回二维码令牌。')
  return { qrcode, qrcodeUrl: normalizeWeixinQrUrl(response.qrcode_img_content) }
}

export async function pollLogin({ qrcode, baseUrl = WEIXIN_QR_BASE_URL, verifyCode, fetchImpl = fetch, signal } = {}) {
  const qr = nonEmptyString(qrcode)
  if (!qr) throw new TypeError('qrcode is required')
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr)}`
  if (nonEmptyString(verifyCode)) endpoint += `&verify_code=${encodeURIComponent(verifyCode.trim())}`
  const response = await requestJson(fetchImpl, {
    method: 'GET', baseUrl, endpoint, timeoutMs: 35_000, signal, authenticated: false,
  })
  if (!response || typeof response !== 'object' || !LOGIN_STATUSES.has(response.status)) {
    throw new Error('微信服务返回了无法识别的扫码状态。')
  }
  return response
}

export async function getWeixinUpdates({ baseUrl, token, getUpdatesBuf = '', timeoutMs = 35_000, fetchImpl = fetch, signal } = {}) {
  const response = await requestJson(fetchImpl, {
    method: 'POST',
    baseUrl,
    endpoint: 'ilink/bot/getupdates',
    token,
    timeoutMs,
    signal,
    body: { get_updates_buf: getUpdatesBuf, base_info: baseInfo() },
  })
  const rejection = rejectedProviderResponse(response)
  if (rejection) throw new Error(`微信消息同步被拒绝（${rejection}）。`)
  return {
    ...(response && typeof response === 'object' ? response : {}),
    msgs: Array.isArray(response?.msgs) ? response.msgs : [],
    get_updates_buf: typeof response?.get_updates_buf === 'string' ? response.get_updates_buf : getUpdatesBuf,
  }
}

export async function notifyWeixinStart({ baseUrl, token, fetchImpl = fetch, signal } = {}) {
  const response = await requestJson(fetchImpl, {
    method: 'POST', baseUrl, endpoint: 'ilink/bot/msg/notifystart', token, signal,
    body: { base_info: baseInfo() },
  })
  const rejection = rejectedProviderResponse(response)
  if (rejection) throw new Error(`微信连接启动被拒绝（${rejection}）。`)
  return response
}

export async function notifyWeixinStop({ baseUrl, token, fetchImpl = fetch, signal } = {}) {
  const response = await requestJson(fetchImpl, {
    method: 'POST', baseUrl, endpoint: 'ilink/bot/msg/notifystop', token, signal,
    body: { base_info: baseInfo() },
  })
  const rejection = rejectedProviderResponse(response)
  if (rejection) throw new Error(`微信连接停止被拒绝（${rejection}）。`)
  return response
}

export function extractWeixinInboundText(message) {
  for (const item of message?.item_list ?? []) {
    if (item?.type === 1 && typeof item.text_item?.text === 'string') {
      const text = item.text_item.text.trim()
      if (text) return text
    }
    if (item?.type === 3 && typeof item.voice_item?.text === 'string') {
      const text = item.voice_item.text.trim()
      if (text) return text
    }
  }
  return ''
}

export function orderWeixinMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return Array.isArray(messages) ? messages : []
  const orderField = ['seq', 'create_time_ms'].find((field) => messages.every((message) => (
    (typeof message?.[field] === 'number' && Number.isFinite(message[field]))
      || (typeof message?.[field] === 'string'
        && message[field].trim()
        && Number.isFinite(Number(message[field])))
  )))
  if (!orderField) return messages
  return messages
    .map((message, index) => ({ message, index, order: Number(message[orderField]) }))
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map(({ message }) => message)
}

function aesEcbPaddedSize(size) {
  return Math.ceil((size + 1) / 16) * 16
}

/** 只往微信自己的 CDN 传：服务端返回的地址必须正好是那台机器上的 /c2c/upload。 */
function trustedCdnUploadUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('微信服务返回了无效的文件上传地址。')
  }
  if (url.protocol !== 'https:' || url.hostname !== WEIXIN_CDN_HOST
    || (url.port && url.port !== '443') || url.pathname !== '/c2c/upload'
    || url.username || url.password) {
    throw new Error('微信服务返回了不受信任的文件上传地址。')
  }
  url.hash = ''
  return url
}

function cdnUploadUrl(response, fileKey) {
  const fullUrl = nonEmptyString(response?.upload_full_url)
  if (fullUrl) return trustedCdnUploadUrl(fullUrl)
  const uploadParam = nonEmptyString(response?.upload_param)
  if (!uploadParam) throw new Error('微信服务没有返回文件上传地址。')
  const url = new URL(`${WEIXIN_CDN_BASE_URL}/upload`)
  url.searchParams.set('encrypted_query_param', uploadParam)
  url.searchParams.set('filekey', fileKey)
  return trustedCdnUploadUrl(url)
}

async function* encryptUpload(bytes, key, signal) {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  for (let offset = 0; offset < bytes.byteLength; offset += WEIXIN_CDN_UPLOAD_CHUNK_BYTES) {
    signal?.throwIfAborted()
    const chunk = cipher.update(bytes.subarray(offset, offset + WEIXIN_CDN_UPLOAD_CHUNK_BYTES))
    if (chunk.byteLength) yield chunk
  }
  signal?.throwIfAborted()
  yield cipher.final()
}

async function uploadToCdn(fetchImpl, url, bytes, key, signal) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(aesEcbPaddedSize(bytes.byteLength)),
    },
    body: encryptUpload(bytes, key, signal),
    duplex: 'half',
    redirect: 'error',
    signal,
  })
  if (!response.ok) throw new Error(`微信文件上传失败（HTTP ${response.status}）。`)
  const downloadParam = nonEmptyString(response.headers.get('x-encrypted-param'))
  if (!downloadParam) throw new Error('微信文件上传响应缺少下载参数。')
  return downloadParam
}

/**
 * 发一张原生图片。iLink 的流程是三步：
 * getuploadurl 拿上传地址 → AES-128-ECB 加密后传到 CDN → sendmessage 带 image_item。
 *
 * @param {{ baseUrl?: string, token?: string, toUserId: string, bytes: Buffer,
 *   fileName?: string, contextToken?: string, runId?: string,
 *   fetchImpl?: typeof fetch, uploadFetchImpl?: typeof fetch, signal?: AbortSignal }} options
 */
export async function sendWeixinImage({
  baseUrl,
  token,
  toUserId,
  bytes,
  fileName = 'image',
  contextToken,
  runId,
  fetchImpl = fetch,
  uploadFetchImpl = fetchImpl,
  signal,
} = {}) {
  const recipient = nonEmptyString(toUserId)
  if (!recipient) throw new TypeError('toUserId is required')
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) throw new TypeError('bytes must be a non-empty Buffer')
  signal?.throwIfAborted()

  const fileKey = randomBytes(16).toString('hex')
  const aesKey = randomBytes(16)
  const rawMd5 = createHash('md5').update(bytes).digest('hex')
  const upload = await requestJson(fetchImpl, {
    method: 'POST',
    baseUrl,
    endpoint: 'ilink/bot/getuploadurl',
    token,
    signal,
    body: {
      filekey: fileKey,
      media_type: WEIXIN_MEDIA_IMAGE,
      to_user_id: recipient,
      rawsize: bytes.byteLength,
      rawfilemd5: rawMd5,
      filesize: aesEcbPaddedSize(bytes.byteLength),
      no_need_thumb: true,
      aeskey: aesKey.toString('hex'),
      base_info: baseInfo(),
    },
  })
  const uploadRejection = rejectedProviderResponse(upload)
  if (uploadRejection) throw new Error(`微信服务拒绝了图片上传（${uploadRejection}）。`)

  const ciphertextSize = aesEcbPaddedSize(bytes.byteLength)
  const downloadParam = await uploadToCdn(uploadFetchImpl, cdnUploadUrl(upload, fileKey), bytes, aesKey, signal)
  const media = {
    encrypt_query_param: downloadParam,
    aes_key: Buffer.from(aesKey.toString('hex')).toString('base64'),
    encrypt_type: 1,
  }
  const clientId = `dsh-weixin-${randomUUID()}`
  const response = await requestJson(fetchImpl, {
    method: 'POST',
    baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    token,
    signal,
    body: {
      msg: {
        from_user_id: '',
        to_user_id: recipient,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        item_list: [{
          type: 2,
          image_item: { media, mid_size: ciphertextSize },
        }],
        ...(nonEmptyString(contextToken) ? { context_token: contextToken.trim() } : {}),
        ...(nonEmptyString(runId) ? { run_id: runId.trim() } : {}),
      },
      base_info: baseInfo(),
    },
  })
  const sendRejection = rejectedProviderResponse(response)
  if (sendRejection) throw new Error(`微信服务拒绝了图片消息（${sendRejection}）。`)
  return { messageId: clientId, fileName }
}

export async function sendWeixinText({ baseUrl, token, toUserId, text, contextToken, runId, fetchImpl = fetch, signal } = {}) {
  const recipient = nonEmptyString(toUserId)
  const content = nonEmptyString(text)
  if (!recipient || !content) throw new TypeError('toUserId and text are required')
  const clientId = `dsh-weixin-${randomUUID()}`
  const response = await requestJson(fetchImpl, {
    method: 'POST', baseUrl, endpoint: 'ilink/bot/sendmessage', token, signal,
    body: {
      msg: {
        from_user_id: '',
        to_user_id: recipient,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: content } }],
        ...(nonEmptyString(contextToken) ? { context_token: contextToken.trim() } : {}),
        ...(nonEmptyString(runId) ? { run_id: runId.trim() } : {}),
      },
      base_info: baseInfo(),
    },
  })
  const sendRejection = rejectedProviderResponse(response)
  if (sendRejection) throw new Error(`微信服务拒绝了回复消息（${sendRejection}）。`)
  return {
    ...(response && typeof response === 'object' ? response : {}),
    providerMessageIds: [clientId],
  }
}
