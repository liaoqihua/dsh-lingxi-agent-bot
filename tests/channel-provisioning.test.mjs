import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const { BotRegistry } = await import('../lib/bots.js')
const { ChannelProvisioning } = await import('../lib/channel-provisioning.js')
const { sendWeixinText, WEIXIN_QR_BASE_URL } = await import('../lib/weixin-api.js')

function encodeQr(value) {
  return Promise.resolve('data:image/png;base64,' + Buffer.from(String(value)).toString('base64'))
}

test('飞书：先扫码并验证，成功后才创建机器人', async () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-feishu-provision-'))
  const registry = new BotRegistry({ root })
  const calls = []
  const lark = {
    defaultHttpInstance: {
      async request(options) {
        if (String(options.url).includes('tenant_access_token')) return { code: 0, tenant_access_token: 'tenant-token' }
        if (String(options.url).includes('/bot/v3/info/')) return { code: 0, bot: { app_name: '飞书扫码机器人', open_id: 'bot-open-id', activate_status: 1 } }
        throw new Error('unexpected request')
      },
    },
    async registerApp(options) {
      calls.push(options)
      await options.onQRCodeReady({ url: 'https://open.feishu.cn/qr/demo', expireIn: 60 })
      return { client_id: 'cli_scan', client_secret: 'secret_scan', user_info: { open_id: 'owner-open-id', tenant_brand: 'feishu' } }
    },
  }
  const started = []
  const provisioning = new ChannelProvisioning({ registry, lark, encodeQr, startBot: async (bot) => { started.push(bot.id) } })
  const pending = await provisioning.start('feishu', { name: '自定义名字' })
  assert.equal(pending.status, 'pending')
  assert.match(pending.qr.qrCodeDataUrl, /^data:image\/png/)
  assert.equal(registry.list().length, 0)
  await provisioning.whenSettled('feishu')
  const result = provisioning.status('feishu')
  assert.equal(result.status, 'connected')
  assert.ok(result.botId)
  assert.equal(registry.list().length, 1)
  assert.equal(registry.list()[0].name, '飞书扫码机器人')
  assert.equal(registry.list()[0].credentials.appId, 'cli_scan')
  assert.equal(registry.list()[0].credentials.appSecret, 'secret_scan')
  assert.deepEqual(started, [result.botId])
  assert.equal(calls.length, 1)
  assert.ok(calls[0].addons.scopes.tenant.includes('im:message:send_as_bot'))
  rmSync(root, { recursive: true, force: true })
})

test('飞书：同一 AppID 重复接入会失败，不创建第二条', async () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-feishu-dup-'))
  const registry = new BotRegistry({ root })
  registry.add({ channel: 'feishu', name: '已有飞书', credentials: { appId: 'cli_dup', appSecret: 's', ownerOpenId: 'owner-dup' } })
  const lark = {
    defaultHttpInstance: {
      async request(options) {
        if (String(options.url).includes('tenant_access_token')) return { code: 0, tenant_access_token: 'tenant-token' }
        if (String(options.url).includes('/bot/v3/info/')) return { code: 0, bot: { app_name: '重复飞书', open_id: 'bot-open-id', activate_status: 1 } }
        throw new Error('unexpected request')
      },
    },
    async registerApp(options) {
      await options.onQRCodeReady({ url: 'https://open.feishu.cn/qr/dup', expireIn: 60 })
      return { client_id: 'cli_dup', client_secret: 's', user_info: { open_id: 'owner-dup', tenant_brand: 'feishu' } }
    },
  }
  const provisioning = new ChannelProvisioning({ registry, lark, encodeQr, startBot: async () => {} })
  await provisioning.start('feishu')
  await provisioning.whenSettled('feishu')
  const result = provisioning.status('feishu')
  assert.equal(result.status, 'error')
  assert.match(result.qr.error, /已经接入/)
  assert.equal(registry.list().length, 1)
  rmSync(root, { recursive: true, force: true })
})

test('飞书取消竞态：后续状态回调和注册结果都不能重新激活或落库', async () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-feishu-cancel-race-'))
  const registry = new BotRegistry({ root })
  let callbacks = null
  let finishRegistration = null
  const lark = {
    defaultHttpInstance: {
      async request(options) {
        if (String(options.url).includes('tenant_access_token')) return { code: 0, tenant_access_token: 'tenant-token' }
        return { code: 0, bot: { app_name: '不该创建', open_id: 'bot-open-id', activate_status: 1 } }
      },
    },
    async registerApp(options) {
      callbacks = options
      await options.onQRCodeReady({ url: 'https://open.feishu.cn/qr/cancel-race', expireIn: 60 })
      return new Promise((resolve) => { finishRegistration = () => resolve({ client_id: 'cli_late', client_secret: 'secret_late', user_info: { open_id: 'owner-late', tenant_brand: 'feishu' } }) })
    },
  }
  const provisioning = new ChannelProvisioning({ registry, lark, encodeQr, startBot: async () => {} })
  await provisioning.start('feishu')
  provisioning.cancel('feishu')
  await callbacks.onStatusChange({ status: 'polling' })
  finishRegistration()
  await provisioning.whenSettled('feishu')
  assert.equal(provisioning.status('feishu').status, 'cancelled')
  assert.equal(registry.list().length, 0)
  rmSync(root, { recursive: true, force: true })
})

test('微信：扫码、配对码、确认后才创建机器人', async () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-weixin-provision-'))
  const registry = new BotRegistry({ root })
  const requests = []
  let confirmed = false
  const fetchImpl = async (url, options) => {
    const href = String(url)
    requests.push({ url: href, options })
    if (href.includes('get_bot_qrcode')) return new Response(JSON.stringify({ qrcode: 'qr-token', qrcode_img_content: 'https://ilinkai.weixin.qq.com/qr/demo' }), { status: 200 })
    if (href.includes('get_qrcode_status')) {
      if (!confirmed) return new Response(JSON.stringify({ status: 'need_verifycode' }), { status: 200 })
      return new Response(JSON.stringify({ status: 'confirmed', bot_token: 'wechat-token', ilink_bot_id: 'wechat-account', ilink_user_id: 'wechat-owner', baseurl: WEIXIN_QR_BASE_URL }), { status: 200 })
    }
    throw new Error('unexpected url ' + href)
  }
  const provisioning = new ChannelProvisioning({ registry, fetchImpl, encodeQr, startBot: async () => {} })
  await provisioning.start('webhook', { name: '微信扫码机器人' })
  for (let i = 0; i < 20 && !provisioning.status('webhook').qr.verificationRequired; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(provisioning.status('webhook').qr.verificationRequired, true)
  assert.equal(registry.list().length, 0)
  await provisioning.verifyWechat('123456')
  confirmed = true
  await provisioning.whenSettled('webhook')
  const result = provisioning.status('webhook')
  assert.equal(result.status, 'connected')
  assert.equal(registry.list().length, 1)
  assert.equal(registry.list()[0].credentials.token, 'wechat-token')
  assert.equal(registry.list()[0].credentials.accountId, 'wechat-account')
  assert.equal(registry.list()[0].credentials.ownerOpenId, 'wechat-owner')
  assert.ok(requests.some((row) => row.url.includes('verify_code=123456')))
  rmSync(root, { recursive: true, force: true })
})

test('接入取消：不会创建机器人', async () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-provision-cancel-'))
  const registry = new BotRegistry({ root })
  const fetchImpl = async (url) => {
    if (String(url).includes('get_bot_qrcode')) return new Response(JSON.stringify({ qrcode: 'qr-cancel', qrcode_img_content: 'https://ilinkai.weixin.qq.com/qr/cancel' }), { status: 200 })
    return new Promise(() => {})
  }
  const provisioning = new ChannelProvisioning({ registry, fetchImpl, encodeQr, startBot: async () => {} })
  await provisioning.start('webhook')
  const cancelled = provisioning.cancel('webhook')
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(registry.list().length, 0)
  rmSync(root, { recursive: true, force: true })
})

test('微信原生发送：使用扫码 token 调 sendmessage', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
  }
  const result = await sendWeixinText({ baseUrl: WEIXIN_QR_BASE_URL, token: 'wechat-token', toUserId: 'owner', text: '扫码后的测试消息', fetchImpl })
  assert.equal(result.providerMessageIds.length, 1)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /ilink\/bot\/sendmessage/)
  const body = JSON.parse(calls[0].options.body)
  assert.equal(body.msg.to_user_id, 'owner')
  assert.equal(body.msg.item_list[0].text_item.text, '扫码后的测试消息')
})
