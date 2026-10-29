import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'companion-bot-only-modules-'))

const configMod = await import('../lib/config.js')
const { installApi } = await import('../lib/api.js')
const { createFakeCtx } = await import('./fake-ctx.mjs')
const { storePath } = await import('../lib/memory.js')
const { statePath: moodStatePath } = await import('../lib/mood.js')
const { statePath: proactiveStatePath } = await import('../lib/proactive-bots.js')

function request(method, url, body) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  return { method, url, headers: {}, async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw) } }
}
function response() {
  return { status: 0, body: '', writeHead(code) { this.status = code }, end(value) { this.body = String(value ?? '') } }
}
async function call(ctx, method, url, body) {
  const route = ctx.__routes.find((item) => item.path === url.split('?')[0])
  assert.ok(route)
  const res = response()
  await route.handler(request(method, url, body), res)
  return { status: res.status, json: JSON.parse(res.body || '{}') }
}

test('无机器人时：心情和主动搭话没有全局兜底状态或接口', async () => {
  const config = configMod.loadConfig()
  const ctx = createFakeCtx()
  installApi(ctx, {
    getConfig: () => config,
    setConfig: () => {},
    patchConfig: () => config,
    bridge: { status: () => ({ conversations: [] }), listConversations: () => [] },
    channels: { status: () => [] },
    botManager: { status: () => [], registry: { get: () => null } },
    botProactive: {
      status: () => ({ enabled: false, botId: '', conversations: [], logs: [] }),
      async trigger() { throw new Error('主动搭话只属于机器人') },
    },
    proactive: { status: () => ({ enabled: true, botId: 'legacy-global' }) },
    mood: { snapshot: () => ({ mood: 99, botId: 'legacy-global' }) },
    logger: console,
    listModels: async () => [],
  })
  const state = await call(ctx, 'GET', '/api/companion/state')
  assert.equal(state.json.mood, undefined)
  assert.equal(state.json.proactive, undefined)
  assert.equal(state.json.persona, undefined)
  const mood = await call(ctx, 'GET', '/api/companion/mood')
  assert.equal(mood.status, 400)
  const proactive = await call(ctx, 'GET', '/api/companion/proactive')
  assert.equal(proactive.json.proactive.enabled, false)
  assert.equal(proactive.json.proactive.botId, '')
  const triggered = await call(ctx, 'POST', '/api/companion/proactive', {})
  assert.equal(triggered.status, 400)
  for (const dispose of ctx.__disposers.splice(0)) dispose()
})

test('配置与状态路径：没有 botId 就没有全局目录或全局文件', () => {
  const config = configMod.loadConfig()
  assert.equal('activeChannel' in config, false)
  assert.equal('cwd' in config.channels.qq, false)
  assert.equal('sessionId' in config.channels.qq, false)
  assert.equal('includeGlobal' in config.persona, false)
  assert.throws(() => storePath('ordinary'), /缺少 botId/)
  assert.throws(() => moodStatePath(''), /缺少 botId/)
  assert.throws(() => proactiveStatePath(''), /缺少 botId/)
})

test('宿主装配：不再启动旧全局主动搭话，非 bot 回合不做心情/记忆收尾', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'index.js'), 'utf8')
  assert.doesNotMatch(source, /\bproactive\.start\(\)/)
  assert.match(source, /if \(!record\?\.botId\) return/)
})

