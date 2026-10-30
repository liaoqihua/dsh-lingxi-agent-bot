import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'companion-qq-'))

const { QQOfficialChannel } = await import('../lib/channels/qq-official.js')

function fakeBot() {
  const sent = []
  const voices = []
  const images = []
  const listeners = new Map()
  const on = (event, handler) => {
    const list = listeners.get(event) ?? []
    list.push(handler)
    listeners.set(event, list)
  }
  return {
    sent,
    voices,
    images,
    async start() {
      for (const handler of listeners.get('ready') ?? []) handler({})
    },
    stop() {},
    on,
    async sendText(target, text) { sent.push({ target, text }); return { id: `m-${sent.length}` } },
    async sendImage(target, source) { images.push({ target, source }); return { message: { id: 'i-1' } } },
    async sendVoice(target, source) { voices.push({ target, source }); return { message: { id: 'v-1' } } },
    emit(message) { for (const handler of listeners.get('message') ?? []) handler({}, message) },
  }
}

function config() {
  return {
    channels: {
      qq: { enabled: true, appId: 'app-123', appSecret: 'secret-123', ownerOpenId: '', maxChars: 1500 },
      feishu: { enabled: false },
      webhook: { enabled: false },
    },
  }
}

test('QQ 官方通道：入站 → 会话，出站文本/语音', async () => {
  const bot = fakeBot()
  const received = []
  const bridge = {
    dedupe: () => false,
    deliverInbound: async (payload) => { received.push(payload); return { ok: true } },
  }
  const channel = new QQOfficialChannel({}, {
    bridge,
    getConfig: config,
    createBot: () => bot,
    startQr: () => () => {},
    encodeQr: async () => 'data:image/png;base64,xx',
  })
  await channel.start()
  assert.equal(channel.connected, true)
  bot.emit({
    kind: 'c2c',
    senderId: 'user-openid-1',
    senderName: '饲养员',
    content: '在吗',
    messageId: 'msg-1',
    replyTarget: { scope: 'c2c', targetId: 'user-openid-1', msgId: 'msg-1' },
    attachments: [],
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(received.length, 1)
  assert.equal(received[0].channel, 'qq')
  assert.equal(received[0].scope, 'c2c')
  assert.equal(received[0].peerId, 'user-openid-1')
  assert.equal(received[0].senderName, '饲养员')
  assert.equal(received[0].text, '在吗')

  const record = { target: { scope: 'c2c', targetId: 'user-openid-1' } }
  const sent = await channel.send({ record, text: '在的，刚想找你。' })
  assert.equal(sent.ok, true)
  assert.equal(bot.sent.length, 1)
  assert.deepEqual(bot.sent[0].target, { scope: 'c2c', targetId: 'user-openid-1' })
  assert.match(bot.sent[0].text, /刚想找你/)

  await channel.send({ record, text: '看图 ![x](https://example.com/a.png)' })
  assert.equal(bot.images.length, 1)
  assert.deepEqual(bot.images[0].source, { url: 'https://example.com/a.png' })
  assert.equal(bot.sent[1].text, '看图')

  const voice = await channel.sendVoice({ record, file: 'D:/tmp/fake.mp3' })
  assert.equal(voice.ok, true)
  assert.equal(bot.voices.length, 1)
  assert.equal(bot.voices[0].source.localPath, 'D:/tmp/fake.mp3')
})

test('QQ 官方通道：会话拉不起来时把原因回给群/私聊', async () => {
  const bot = fakeBot()
  const bridge = {
    dedupe: () => false,
    deliverInbound: async () => ({ ok: false, error: '机器人没有配置私聊会话默认：workspace', notify: '我收到你的消息了，但这个聊天还没配置好：机器人没有配置私聊会话默认：workspace' }),
  }
  const channel = new QQOfficialChannel({}, {
    bridge, getConfig: config, createBot: () => bot, startQr: () => () => {}, encodeQr: async () => '',
  })
  await channel.start()
  bot.emit({
    kind: 'c2c',
    senderId: 'user-openid-9',
    senderName: '饲养员',
    content: '在吗',
    messageId: 'msg-note-1',
    replyTarget: { scope: 'c2c', targetId: 'user-openid-9' },
    attachments: [],
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(bot.sent.length, 1)
  assert.deepEqual(bot.sent[0].target, { scope: 'c2c', targetId: 'user-openid-9' })
  assert.match(bot.sent[0].text, /还没配置好/)
})

test('QQ 官方通道：没有回复目标的消息直接忽略，不做任何回发', async () => {
  const bot = fakeBot()
  const bridge = { dedupe: () => false, deliverInbound: async () => ({ ok: false, notify: '提示' }) }
  const channel = new QQOfficialChannel({}, {
    bridge, getConfig: config, createBot: () => bot, startQr: () => () => {}, encodeQr: async () => '',
  })
  await channel.start()
  bot.emit({
    kind: 'c2c',
    senderId: 'user-openid-10',
    content: '在吗',
    messageId: 'msg-note-2',
    replyTarget: { scope: '', targetId: '' },
    attachments: [],
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(bot.sent.length, 0)
})

test('QQ 官方通道：扫码成功后保存凭证并连接', async () => {
  let callbacks = null
  let stopped = 0
  const bot = fakeBot()
  let login = null
  const channel = new QQOfficialChannel({}, {
    bridge: { dedupe: () => false, deliverInbound: async () => ({ ok: true }) },
    getConfig: config,
    createBot: () => bot,
    startQr: (handlers) => {
      callbacks = handlers
      return () => { stopped += 1 }
    },
    encodeQr: async () => 'data:image/png;base64,qr',
    onLogin: async (credentials) => { login = credentials },
  })
  const started = channel.startQr()
  assert.equal(started.status, 'starting')
  callbacks.onQrDisplayed('https://q.qq.com/abc')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(channel.qrStatus().status, 'pending')
  assert.equal(channel.qrStatus().qrCodeDataUrl, 'data:image/png;base64,qr')
  callbacks.onSuccess([{ appId: 'app-new', appSecret: 'secret-new' }])
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(login, { appId: 'app-new', appSecret: 'secret-new' })
  assert.equal(channel.qrStatus().status, 'connected')
  assert.equal(channel.qrStatus().connected, true)
  assert.ok(stopped >= 1)
})

test('QQ 入站图片：以字节为准，不认 QQ 声明的 content_type（表情包踩过这个坑）', async () => {
  const bot = fakeBot()
  const received = []
  const channel = new QQOfficialChannel({}, {
    bridge: { dedupe: () => false, deliverInbound: async (payload) => { received.push(payload); return { ok: true } } },
    getConfig: config, createBot: () => bot, startQr: () => () => {}, encodeQr: async () => '',
  })
  await channel.start()
  // 表情包常见组合：声明 png，实际是 webp。
  const webp = Buffer.concat([
    Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP'), Buffer.from('VP8 '), Buffer.alloc(4),
  ])
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(webp, { status: 200 })
  try {
    bot.emit({
      kind: 'c2c',
      senderId: 'user-openid-11',
      content: '',
      messageId: 'msg-img-1',
      replyTarget: { scope: 'c2c', targetId: 'user-openid-11', msgId: 'msg-img-1' },
      attachments: [{ content_type: 'image/png', url: 'https://multimedia.nt.qq.com.cn/x', filename: 'meme' }],
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
  } finally {
    globalThis.fetch = original
  }
  assert.equal(received.length, 1)
  assert.equal(received[0].images.length, 1)
  assert.equal(received[0].images[0].mediaType, 'image/webp', '应该按实际字节判定类型')
  assert.match(received[0].images[0].name, /\.webp$/)
})

test('QQ 入站图片：字节认不出时不瞎猜类型，留一句「发来图片但没能读取」', async () => {
  const bot = fakeBot()
  const received = []
  const channel = new QQOfficialChannel({}, {
    bridge: { dedupe: () => false, deliverInbound: async (payload) => { received.push(payload); return { ok: true } } },
    getConfig: config, createBot: () => bot, startQr: () => () => {}, encodeQr: async () => '',
  })
  await channel.start()
  const original = globalThis.fetch
  // 典型现场：拿回来的不是图片（防盗链 / 过期 URL 返回的 HTML）。
  globalThis.fetch = async () => new Response(Buffer.from('<html>403</html>'), { status: 200 })
  try {
    bot.emit({
      kind: 'c2c',
      senderId: 'user-openid-12',
      content: '',
      messageId: 'msg-img-2',
      replyTarget: { scope: 'c2c', targetId: 'user-openid-12', msgId: 'msg-img-2' },
      attachments: [{ content_type: 'image/png', url: 'https://multimedia.nt.qq.com.cn/y' }],
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
  } finally {
    globalThis.fetch = original
  }
  assert.equal(received.length, 1)
  assert.equal(received[0].images.length, 0, '认不出格式就不该带着猜的类型往下走')
  assert.equal(received[0].text, '[对方发来一张图片，但没能读取]')
})

test.after(() => rmSync(process.env.DSH_HOME, { recursive: true, force: true }))
