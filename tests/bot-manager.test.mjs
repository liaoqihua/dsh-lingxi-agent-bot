import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const root = mkdtempSync(join(tmpdir(), 'companion-bot-manager-'))
const { BotRegistry } = await import('../lib/bots.js')
const { BotManager } = await import('../lib/bot-manager.js')

function fakeFactory() {
  const calls = []
  class FakeChannel {
    constructor(ctx, options) {
      this.options = options
      this.connected = false
      calls.push(this)
    }
    start() { this.connected = true }
    stop() { this.connected = false }
    status() { return { connected: this.connected, bound: true, appId: this.options.getConfig().channels.qq.appId } }
    async send(text) { return { messageId: 'sent:' + text } }
  }
  return { calls, create: (ctx, options) => new FakeChannel(ctx, options) }
}

const baseConfig = {
  channels: {
    qq: { enabled: true, appId: 'base', appSecret: 'base-secret', maxChars: 1500 },
  },
}

test('BotManager：为每台 QQ 机器人起独立连接，状态与发送按 botId 隔离', async () => {
  const registry = new BotRegistry({ root })
  const a = registry.add({
    channel: 'qq',
    name: '甲',
    credentials: { appId: 'app-a', appSecret: 'sec-a' },
    sessionDefaults: { c2c: { workspace: 'D:\\a' }, group: { workspace: 'D:\\a-group' } },
  })
  const b = registry.add({
    channel: 'qq',
    name: '乙',
    credentials: { appId: 'app-b', appSecret: 'sec-b' },
    sessionDefaults: { c2c: { workspace: 'D:\\b' }, group: { workspace: 'D:\\b-group' } },
  })
  const fake = fakeFactory()
  const manager = new BotManager({}, { registry, bridge: {}, getConfig: () => baseConfig, createQq: fake.create })
  await manager.startAll()
  assert.equal(fake.calls.length, 2)
  const status = manager.status()
  assert.equal(status.length, 2)
  assert.equal(status.every((row) => row.online), true)
  assert.equal(fake.calls[0].options.getConfig().channels.qq.appId, 'app-a')
  // 通道配置不带新会话默认（工作区 / Preset / 模型 / 权限都在 bot.sessionDefaults 里）。
  const firstChannelConfig = fake.calls[0].options.getConfig().channels.qq
  for (const key of ['cwd', 'preset', 'provider', 'model', 'defaultPermission']) {
    assert.equal(key in firstChannelConfig, false, `通道配置不该有 ${key}`)
  }
  assert.equal(fake.calls[1].options.getConfig().channels.qq.appId, 'app-b')
  assert.deepEqual(await manager.send(a.id, '给甲'), { messageId: 'sent:给甲' })
  manager.stopAll()
  assert.equal(manager.status().every((row) => row.online), false)
})

test('BotManager：微信机器人也能独立起运行时', async () => {
  const root2 = mkdtempSync(join(tmpdir(), 'companion-bot-channel-'))
  const registry = new BotRegistry({ root: root2 })
  const bot = registry.add({ channel: 'webhook', name: '微信甲', credentials: { outboundUrl: 'https://example.test/out' } })
  const calls = []
  const manager = new BotManager({}, {
    registry,
    bridge: {},
    getConfig: () => baseConfig,
    createWebhook: (ctx, options) => {
      calls.push(options)
      return {
        start() {},
        stop() {},
        status() { return { channel: 'webhook', configured: true, bound: true, connected: false } },
        async send() { return { ok: true, messageId: 'wx' } },
      }
    },
  })
  await manager.startAll()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].botId, bot.id)
  assert.equal(calls[0].getConfig().channels.webhook.outboundUrl, 'https://example.test/out')
  assert.equal(manager.status()[0].online, true)
  const tested = await manager.testConnection(bot.id)
  assert.equal(tested.ok, true)
  assert.match(tested.message, /路由已就绪/)
  manager.stopAll()
  rmSync(root2, { recursive: true, force: true })
})

test('BotManager：只使用机器人自己的凭据', () => {
  const registry = new BotRegistry({ root })
  const manager = new BotManager({}, { registry, bridge: {}, getConfig: () => baseConfig })
  const view = manager.configFor({ channel: 'qq', credentials: {}, name: 'x' })
  assert.equal(view.channels.qq.appId, undefined)
  assert.equal(view.channels.qq.appSecret, undefined)
  const withCreds = manager.configFor({ channel: 'qq', credentials: { appId: 'a', appSecret: 'b' } })
  assert.equal(withCreds.channels.qq.appId, 'a')
  assert.equal(withCreds.channels.qq.appSecret, 'b')
})

test('BotManager：扫码成功后才创建机器人', async () => {
  const root3 = mkdtempSync(join(tmpdir(), 'companion-bot-provision-'))
  const registry = new BotRegistry({ root: root3 })
  let calls = 0
  const manager = new BotManager({}, {
    registry,
    bridge: {},
    getConfig: () => baseConfig,
    createQq: (ctx, options) => {
      calls += 1
      if (calls === 1) {
        return {
          async startQr() {
            await options.onLogin({ appId: 'scan-app', appSecret: 'scan-secret' })
            return { status: 'connected' }
          },
          qrStatus() { return { status: 'connected', connected: true } },
          stop() {},
        }
      }
      return {
        async start() {},
        stop() {},
        status() { return { connected: true, bound: true, appId: 'scan-app' } },
      }
    },
  })
  assert.equal(registry.list().length, 0)
  await manager.startProvisionQr()
  await new Promise((resolve) => setTimeout(resolve, 80))
  const result = manager.provisionStatus()
  assert.ok(result.botId)
  assert.equal(registry.list().length, 1)
  assert.equal(registry.list()[0].credentials.appId, 'scan-app')
  manager.stopAll()
  rmSync(root3, { recursive: true, force: true })
})

test('BotManager：重复扫码同一台 QQ 机器人会返回失败，不创建第二条', async () => {
  const rootDup = mkdtempSync(join(tmpdir(), 'companion-bot-dup-'))
  const registry = new BotRegistry({ root: rootDup })
  registry.add({ channel: 'qq', name: '已有 QQ', credentials: { appId: 'dup-scan', appSecret: 's' } })
  let calls = 0
  const manager = new BotManager({}, {
    registry,
    bridge: {},
    getConfig: () => baseConfig,
    createQq: (ctx, options) => {
      calls += 1
      if (calls === 1) {
        return {
          async startQr() {
            await options.onLogin({ appId: 'dup-scan', appSecret: 's' })
            return { status: 'connected' }
          },
          qrStatus() { return { status: 'connected', connected: true } },
          stop() {},
        }
      }
      return { async start() {}, stop() {}, status() { return { connected: true, bound: true } } }
    },
  })
  await manager.startProvisionQr()
  await new Promise((resolve) => setTimeout(resolve, 80))
  const result = manager.provisionStatus()
  assert.equal(result.botId, '')
  assert.match(result.error, /已经接入/)
  assert.equal(registry.list().length, 1)
  manager.stopAll()
  rmSync(rootDup, { recursive: true, force: true })
})

test('BotManager：QQ 二维码响应统一为 status/qr/botId，页面不会拿到空 qr', async () => {
  const root4 = mkdtempSync(join(tmpdir(), 'companion-qq-provision-shape-'))
  const registry = new BotRegistry({ root: root4 })
  const manager = new BotManager({}, {
    registry,
    bridge: {},
    getConfig: () => baseConfig,
    createQq: () => ({
      async startQr() { return { status: 'starting', qrCodeDataUrl: '', verificationUrl: '' } },
      qrStatus() { return { status: 'pending', qrCodeDataUrl: 'data:image/png;base64,QQ', verificationUrl: 'https://qq.example/qr' } },
      stop() {},
    }),
  })
  const result = await manager.startProvisionChannel('qq')
  assert.equal(result.status, 'pending')
  assert.equal(result.botId, '')
  assert.equal(result.qr.qrCodeDataUrl, 'data:image/png;base64,QQ')
  assert.equal(result.qr.verificationUrl, 'https://qq.example/qr')
  manager.stopAll()
  rmSync(root4, { recursive: true, force: true })
})

test('机器人称呼：configFor 把机器人自己的称呼合进 identity，QQ 私聊的对方名字跟着变', () => {
  const rootOwner = mkdtempSync(join(tmpdir(), 'companion-bot-owner-'))
  const identity = { selfName: '伙伴', ownerName: '主人', aliases: '', pronoun: 'ta' }
  const registry = new BotRegistry({ root: rootOwner })
  const withOwner = registry.add({ channel: 'qq', name: '测试机器人', ownerName: '小明', credentials: { appId: 'owner-a', appSecret: 's' } })
  const withoutOwner = registry.add({ channel: 'qq', name: '微信壳', credentials: { appId: 'owner-b', appSecret: 's' } })
  const manager = new BotManager({}, {
    registry,
    bridge: {},
    getConfig: () => ({ ...baseConfig, identity }),
  })
  assert.equal(manager.configFor(withOwner).identity.ownerName, '小明')
  // 没设过的机器人落回插件级默认：升级前后的行为一致。
  assert.equal(manager.configFor(withoutOwner).identity.ownerName, '主人')
  // identity 的其它字段不能被这次合并丢掉（selfName 还进记忆/心情的提示词）。
  assert.equal(manager.configFor(withOwner).identity.selfName, '伙伴')
  manager.stopAll()
  rmSync(rootOwner, { recursive: true, force: true })
})

test.after(() => rmSync(root, { recursive: true, force: true }))
