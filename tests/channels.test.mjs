import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'companion-channels-'))

const { FeishuChannel } = await import('../lib/channels/feishu.js')
const { WebhookChannel } = await import('../lib/channels/webhook.js')
const { createFakeCtx } = await import('./fake-ctx.mjs')

function request(body, headers = {}) {
  const raw = JSON.stringify(body)
  return {
    method: 'POST',
    url: '/callback',
    headers,
    async *[Symbol.asyncIterator]() { yield Buffer.from(raw, 'utf8') },
  }
}

function response() {
  return {
    status: 0,
    body: '',
    writeHead(code) { this.status = code },
    end(value) { this.body = String(value ?? '') },
  }
}

function baseConfig() {
  return {
    identity: { selfName: '测试机器人', ownerName: '饲养员' },
    channels: {
      feishu: { enabled: true, appId: '', appSecret: '', verificationToken: '', encryptKey: '', requireMention: true, maxChars: 1500 },
      webhook: { enabled: true, label: '微信', secret: 's3cret', outboundUrl: '', requireMention: false, maxChars: 1500 },
    },
  }
}

test('飞书：URL 校验原样回 challenge', async () => {
  const config = baseConfig()
  const ctx = createFakeCtx()
  const channel = new FeishuChannel(ctx, { bridge: { dedupe: () => false, deliverInbound: async () => ({ ok: true }) }, getConfig: () => config, logger: console })
  channel.start()
  const route = ctx.__routes.find((item) => item.path.includes('/feishu/event'))
  assert.ok(route)
  const res = response()
  await route.handler(request({ type: 'url_verification', challenge: 'challenge-abc', token: '' }), res)
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), { challenge: 'challenge-abc' })
  channel.stop()
})

test('微信原生轮询：getupdates 收到消息后走 deliverInbound', async () => {
  const config = baseConfig()
  config.channels.webhook.token = 'native-token'
  config.channels.webhook.baseUrl = 'https://ilinkai.weixin.qq.com/'
  const ctx = createFakeCtx()
  const received = []
  const bridge = {
    dedupe: () => false,
    async deliverInbound(payload) { received.push(payload); return { ok: true } },
  }
  let polls = 0
  const fetchImpl = async (url, options) => {
    const href = String(url)
    if (href.includes('notifystart') || href.includes('notifystop')) {
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    }
    if (href.includes('getupdates')) {
      polls += 1
      if (polls === 1) {
        return new Response(JSON.stringify({
          ret: 0,
          msgs: [{
            message_id: 'native-message-1',
            message_type: 1,
            from_user_id: 'wxid_native',
            item_list: [{ type: 1, text_item: { text: '在吗' } }],
          }],
          get_updates_buf: 'native-cursor',
        }), { status: 200 })
      }
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    throw new Error('unexpected url ' + href)
  }
  const channel = new WebhookChannel(ctx, {
    bridge, getConfig: () => config, logger: console, botId: 'wx-native', fetchImpl,
  })
  channel.start()
  for (let i = 0; i < 50 && received.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(received.length, 1)
  assert.equal(received[0].channel, 'webhook')
  assert.equal(received[0].botId, 'wx-native')
  assert.equal(received[0].peerId, 'wxid_native')
  assert.equal(received[0].text, '在吗')
  assert.equal(channel.status().connected, true)
  channel.stop()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(channel.status().connected, false)
})

test('通用 Webhook：入站会转成 companion-im 消息', async () => {
  const config = baseConfig()
  const ctx = createFakeCtx()
  const received = []
  const bridge = {
    dedupe: () => false,
    async deliverInbound(payload) { received.push(payload); return { ok: true } },
  }
  const channel = new WebhookChannel(ctx, { bridge, getConfig: () => config, logger: console })
  channel.start()
  const route = ctx.__routes.find((item) => item.path.includes('/webhook/inbound'))
  assert.ok(route)
  const res = response()
  await route.handler(request({ conversation: 'wxid_1', senderName: '饲养员', text: '在吗' }, { 'x-companion-secret': 's3cret' }), res)
  assert.equal(res.status, 200)
  for (let i = 0; i < 20 && received.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(received.length, 1)
  assert.equal(received[0].channel, 'webhook')
  assert.equal(received[0].peerId, 'wxid_1')
  assert.equal(received[0].text, '在吗')
  channel.stop()
  rmSync(join(process.env.DSH_HOME, 'dsh-lingxi-agent-bot'), { recursive: true, force: true })
})

test('通用 Webhook：会话拉不起来时把原因回给原会话', async () => {
  const config = baseConfig()
  config.channels.webhook.outboundUrl = 'https://bridge.test/send'
  const ctx = createFakeCtx()
  const outbound = []
  const channel = new WebhookChannel(ctx, {
    bridge: {
      dedupe: () => false,
      deliverInbound: async () => ({ ok: false, notify: '我收到你的消息了，但这个聊天还没配置好：机器人没有配置私聊会话默认：workspace' }),
    },
    getConfig: () => config,
    logger: console,
    fetchImpl: async (url, options) => {
      outbound.push({ url: String(url), body: JSON.parse(options?.body ?? '{}') })
      return new Response(JSON.stringify({ ok: true, messageId: 'n-1' }), { status: 200 })
    },
  })
  channel.start()
  const route = ctx.__routes.find((item) => item.path.includes('/webhook/inbound'))
  const res = response()
  await route.handler(request({ conversation: 'wxid_note', senderName: '饲养员', text: '在吗', messageId: 'note-1' }, { 'x-companion-secret': 's3cret' }), res)
  assert.equal(res.status, 200)
  for (let i = 0; i < 30 && outbound.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(outbound.length, 1)
  assert.equal(outbound[0].url, 'https://bridge.test/send')
  assert.equal(outbound[0].body.conversation, 'wxid_note')
  assert.match(outbound[0].body.text, /还没配置好/)
  channel.stop()
  rmSync(join(process.env.DSH_HOME, 'dsh-lingxi-agent-bot'), { recursive: true, force: true })
})

test('飞书：会话拉不起来时把原因回给原会话', async () => {
  const config = baseConfig()
  config.channels.feishu.appId = 'cli_test'
  config.channels.feishu.appSecret = 'secret'
  const ctx = createFakeCtx()
  const sent = []
  const channel = new FeishuChannel(ctx, {
    bridge: { dedupe: () => false, deliverInbound: async () => ({ ok: false, notify: '还没配置好' }) },
    getConfig: () => config,
    logger: console,
    botId: 'fs-note',
  })
  channel.tenantToken = async () => 'tenant-token'
  channel.send = async (payload) => { sent.push(payload); return { ok: true, messageId: 'fs-1' } }
  channel.start()
  await channel.handleEvent({
    message: { message_id: 'fs-note-1', chat_id: 'oc_chat_1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '在吗' }) },
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
  })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].record.target.chatId, 'oc_chat_1')
  assert.match(String(sent[0].text), /还没配置好/)
  channel.stop()
  rmSync(join(process.env.DSH_HOME, 'dsh-lingxi-agent-bot'), { recursive: true, force: true })
})
