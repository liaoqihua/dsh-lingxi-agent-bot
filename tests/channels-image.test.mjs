import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const home = mkdtempSync(join(tmpdir(), 'companion-img-'))
process.env.DSH_HOME = home
const imageFile = join(home, 'meme.png')
writeFileSync(imageFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]))

const { FeishuChannel } = await import('../lib/channels/feishu.js')
const { WebhookChannel } = await import('../lib/channels/webhook.js')

test.after(() => rmSync(home, { recursive: true, force: true }))

function feishuConfig() {
  return {
    channels: {
      qq: { enabled: false, appId: '', appSecret: '', maxChars: 1500 },
      feishu: { enabled: true, appId: 'app', appSecret: 'secret', verificationToken: '', encryptKey: '', requireMention: false, maxChars: 1500 },
      webhook: { enabled: false, label: '微信', secret: '', outboundUrl: '', requireMention: false, maxChars: 1500 },
    },
  }
}

test('飞书出站：文字 + 本地图片上传后发 image 消息', async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const href = String(url)
    calls.push({ href, method: options.method, body: options.body })
    if (href.includes('tenant_access_token')) {
      return Response.json({ code: 0, tenant_access_token: 't-1', expire: 7200 })
    }
    if (href.endsWith('/im/v1/images')) {
      return Response.json({ code: 0, data: { image_key: 'img_key_1' } })
    }
    if (href.includes('/im/v1/messages?')) {
      return Response.json({ code: 0, data: { message_id: 'om_1' } })
    }
    throw new Error('unexpected ' + href)
  }
  const config = feishuConfig()
  const channel = new FeishuChannel({}, {
    bridge: { dedupe: () => false, deliverInbound: async () => ({ ok: true }) },
    getConfig: () => config,
    fetchImpl,
    botId: 'feishu-1',
  })
  const result = await channel.send({
    record: { channel: 'feishu', peerId: 'chat-1', target: { chatId: 'chat-1' } },
    text: '给你看 ![表情](' + imageFile + ')',
    limit: 1500,
  })
  assert.equal(result.ok, true)
  assert.equal(result.images, 1)
  assert.equal(result.imageError, undefined)

  const textMessages = calls
    .filter((call) => call.href.includes('/im/v1/messages?'))
    .map((call) => JSON.parse(call.body))
  const textMessage = textMessages.find((body) => body.msg_type === 'text')
  const imageMessage = textMessages.find((body) => body.msg_type === 'image')
  assert.ok(textMessage, '文字消息要发出去')
  assert.equal(JSON.parse(textMessage.content).text, '给你看')
  assert.ok(imageMessage, '图片消息要发出去')
  assert.deepEqual(JSON.parse(imageMessage.content), { image_key: 'img_key_1' })
  // 上传用的是 multipart：image_type=message + 文件
  const upload = calls.find((call) => call.href.endsWith('/im/v1/images'))
  assert.ok(upload.body instanceof FormData)
  assert.equal(upload.body.get('image_type'), 'message')
  assert.ok(upload.body.get('image'))
})

test('飞书出站：图片上传失败不影响已经发出的文字', async () => {
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href.includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 't-1', expire: 7200 })
    if (href.endsWith('/im/v1/images')) return Response.json({ code: 40005, msg: 'no permission' })
    if (href.includes('/im/v1/messages?')) return Response.json({ code: 0, data: { message_id: 'om_1' } })
    throw new Error('unexpected ' + href)
  }
  const config = feishuConfig()
  const channel = new FeishuChannel({}, {
    bridge: { dedupe: () => false, deliverInbound: async () => ({ ok: true }) },
    getConfig: () => config,
    fetchImpl,
    botId: 'feishu-1',
  })
  const result = await channel.send({
    record: { channel: 'feishu', peerId: 'chat-1', target: { chatId: 'chat-1' } },
    text: '只有文字 ![表情](' + imageFile + ')',
    limit: 1500,
  })
  assert.equal(result.ok, true)
  assert.equal(result.images, 0)
  assert.match(result.imageError, /飞书图片上传失败/)
})

function weixinConfig() {
  return {
    channels: {
      qq: { enabled: false, appId: '', appSecret: '', maxChars: 1500 },
      feishu: { enabled: false },
      webhook: {
        enabled: true,
        label: '微信',
        secret: '',
        token: 'wx-token',
        baseUrl: 'https://ilinkai.weixin.qq.com/',
        outboundUrl: '',
        requireMention: false,
        maxChars: 1500,
      },
    },
  }
}

test('微信出站：文字 + 图片走 getuploadurl → CDN → sendmessage(image_item)', async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const href = String(url)
    calls.push({ href, method: options.method, body: options.body })
    if (href.includes('ilink/bot/getuploadurl')) {
      return Response.json({ ret: 0, upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?filekey=k1' })
    }
    if (href.startsWith('https://novac2c.cdn.weixin.qq.com/c2c/upload')) {
      return new Response('', { status: 200, headers: { 'x-encrypted-param': 'download-param-1' } })
    }
    if (href.includes('ilink/bot/sendmessage')) return Response.json({ ret: 0 })
    throw new Error('unexpected ' + href)
  }
  const config = weixinConfig()
  const channel = new WebhookChannel({}, {
    bridge: { dedupe: () => false, deliverInbound: async () => ({ ok: true }) },
    getConfig: () => config,
    fetchImpl,
    botId: 'webhook-1',
  })
  const result = await channel.send({
    record: { channel: 'webhook', peerId: 'wxid_1', senderId: 'wxid_1' },
    text: '哈哈哈 ![表情](' + imageFile + ')',
    limit: 1500,
  })
  assert.equal(result.ok, true)
  assert.equal(result.images, 1)
  assert.equal(result.imageError, undefined)

  const messages = calls
    .filter((call) => call.href.includes('ilink/bot/sendmessage'))
    .map((call) => JSON.parse(call.body).msg)
  const textMsg = messages.find((msg) => msg.item_list[0].type === 1)
  const imageMsg = messages.find((msg) => msg.item_list[0].type === 2)
  assert.ok(textMsg, '文字消息要发出去')
  assert.equal(textMsg.item_list[0].text_item.text, '哈哈哈')
  assert.ok(imageMsg, '图片消息要发出去')
  const imageItem = imageMsg.item_list[0].image_item
  assert.equal(imageItem.media.encrypt_query_param, 'download-param-1')
  assert.ok(imageItem.media.aes_key)
  assert.equal(imageItem.media.encrypt_type, 1)
  assert.ok(imageItem.mid_size > 0)

  // 上传前的申请参数：图片 media_type 必须是 1，并且带原始大小与 MD5
  const upload = JSON.parse(calls.find((call) => call.href.includes('getuploadurl')).body)
  assert.equal(upload.media_type, 1)
  assert.equal(upload.rawsize, 9)
  assert.match(upload.rawfilemd5, /^[0-9a-f]{32}$/)
  assert.equal(upload.filesize, 16)
})

test('微信出站：没有 token 也不冒充成功（通用 webhook 只发文本）', async () => {
  const config = weixinConfig()
  config.channels.webhook.token = ''
  config.channels.webhook.outboundUrl = 'https://bridge.example.com/send'
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ href: String(url), body: options.body })
    return Response.json({ messageId: 'm-1' })
  }
  const channel = new WebhookChannel({}, {
    bridge: { dedupe: () => false, deliverInbound: async () => ({ ok: true }) },
    getConfig: () => config,
    fetchImpl,
    botId: 'webhook-1',
  })
  const result = await channel.send({
    record: { channel: 'webhook', peerId: 'wxid_1' },
    text: '文字 ![表情](' + imageFile + ')',
    limit: 1500,
  })
  assert.equal(result.ok, true)
  assert.equal(result.images, 0)
  assert.equal(JSON.parse(calls[0].body).text, '文字')
})