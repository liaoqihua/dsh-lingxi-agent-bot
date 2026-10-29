import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'companion-provision-api-'))

const configMod = await import('../lib/config.js')
const { installApi } = await import('../lib/api.js')
const { createFakeCtx } = await import('./fake-ctx.mjs')

function request(body) {
  const raw = JSON.stringify(body)
  return { method: 'POST', url: '/api/companion/bots', headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from(raw) } }
}

test('接入 API：provisionQr/status/cancel/verify 都按 channel 路由', async () => {
  const config = configMod.loadConfig()
  const ctx = createFakeCtx()
  const calls = []
  const botManager = {
    status: () => [],
    async startProvisionChannel(channel, options) { calls.push(['start', channel, options]); return { status: 'pending', qr: { status: 'pending' } } },
    provisionChannelStatus(channel) { calls.push(['status', channel]); return { status: 'pending', qr: { status: 'pending' }, botId: '' } },
    cancelProvisionChannel(channel) { calls.push(['cancel', channel]); return { status: 'cancelled', qr: null, botId: '' } },
    async verifyProvision(channel, code) { calls.push(['verify', channel, code]); return { status: 'connected', qr: null, botId: 'bot-scan' } },
  }
  installApi(ctx, {
    getConfig: () => config,
    setConfig: () => {},
    patchConfig: () => config,
    bridge: { status: () => ({ conversations: [] }), listConversations: () => [] },
    channels: { status: () => [] },
    botManager,
    botProactive: null,
    proactive: null,
    logger: console,
    listModels: async () => [],
    mood: { snapshot: () => null },
  })
  const route = ctx.__routes.find((row) => row.path === '/api/companion/bots')
  async function call(body) {
    const res = { status: 0, body: '', writeHead(code) { this.status = code }, end(value) { this.body = String(value ?? '') } }
    await route.handler(request(body), res)
    return { status: res.status, json: JSON.parse(res.body) }
  }
  await call({ action: 'provisionQr', channel: 'feishu', name: '飞书测试' })
  await call({ action: 'provisionStatus', channel: 'webhook' })
  await call({ action: 'provisionVerify', channel: 'webhook', code: '123456' })
  await call({ action: 'cancelProvision', channel: 'feishu' })
  assert.deepEqual(calls.map((row) => row.slice(0, 2)), [
    ['start', 'feishu'], ['status', 'webhook'], ['verify', 'webhook'], ['cancel', 'feishu'],
  ])
  assert.equal(calls[2][2], '123456')
  for (const dispose of ctx.__disposers.splice(0)) dispose()
})
