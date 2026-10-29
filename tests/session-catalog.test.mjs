// 会话目录接口：宿主会话日志很贵（整目录解压+解析），所以
//   · /state 不再扫宿主会话；
//   · 换绑候选走 /api/companion/sessions，按需 + 缓存，refresh=1 才重扫。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'companion-session-catalog-'))

const configMod = await import('../lib/config.js')
const { createFakeCtx } = await import('./fake-ctx.mjs')

function request(method, url, body) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw, 'utf8') },
  }
}
function response() {
  return { status: 0, body: '', writeHead(code) { this.status = code }, end(value) { this.body = String(value ?? '') } }
}
async function call(ctx, method, url, body) {
  const route = ctx.__routes.find((item) => item.path === url.split('?')[0])
  assert.ok(route, `route ${url} 应该注册`)
  const res = response()
  await route.handler(request(method, url, body), res)
  return { status: res.status, json: JSON.parse(res.body || '{}'), raw: res.body }
}

test('会话目录：按需接口 + 缓存，refresh=1 才重扫宿主；/state 不扫', async () => {
  const config = configMod.loadConfig()
  config.proactive.enabled = false
  configMod.saveConfig(config)
  const { apply } = await import('../index.js')
  const ctx = createFakeCtx()
  apply(ctx)
  try {
    const added = await call(ctx, 'POST', '/api/companion/bots', {
      action: 'add',
      channel: 'qq',
      name: '会话目录机器人',
      sessionDefaults: {
        c2c: { workspace: process.cwd(), defaultPermission: 'workspace-write' },
        group: { workspace: process.cwd(), defaultPermission: 'read-only' },
      },
    })
    assert.equal(added.status, 200, added.raw)
    const botId = added.json.bot.id
    await ctx.agents.create({ sessionId: 'catalog-session', meta: { cwd: process.cwd() } })

    // 数一数宿主会话目录被扫了几次。
    const realList = ctx.sessionQuery.listSessions.bind(ctx.sessionQuery)
    let scans = 0
    ctx.sessionQuery.listSessions = async () => { scans += 1; return realList() }

    // 打开设置页（总览）不该扫宿主会话。
    const state = await call(ctx, 'GET', '/api/companion/state')
    assert.equal(state.status, 200)
    assert.equal(state.json.sessionsAll, undefined)
    assert.equal(scans, 0)

    const first = await call(ctx, 'GET', '/api/companion/sessions?botId=' + encodeURIComponent(botId))
    assert.equal(first.status, 200, first.raw)
    assert.equal(scans, 1)
    assert.ok(first.json.sessions.some((row) => row.id === 'catalog-session'))

    const cached = await call(ctx, 'GET', '/api/companion/sessions?botId=' + encodeURIComponent(botId))
    assert.equal(scans, 1, '缓存期内的第二次调用不该重扫宿主')
    assert.deepEqual(cached.json.sessions.map((row) => row.id), first.json.sessions.map((row) => row.id))

    const forced = await call(ctx, 'GET', '/api/companion/sessions?botId=' + encodeURIComponent(botId) + '&refresh=1')
    assert.equal(forced.status, 200, forced.raw)
    assert.equal(scans, 2, 'refresh=1 应该绕过缓存重扫')

    // 换到别的机器人：结果缓存键不同要重算，但宿主目录还在 30 秒缓存里。
    const second = await call(ctx, 'POST', '/api/companion/bots', {
      action: 'add',
      channel: 'qq',
      name: '第二台',
      credentials: { appId: 'second-app' },
      sessionDefaults: {
        c2c: { workspace: process.cwd(), defaultPermission: 'workspace-write' },
        group: { workspace: process.cwd(), defaultPermission: 'read-only' },
      },
    })
    assert.equal(second.status, 200, second.raw)
    const otherId = second.json.bot.id
    const other = await call(ctx, 'GET', '/api/companion/sessions?botId=' + encodeURIComponent(otherId))
    assert.equal(other.status, 200, other.raw)
    assert.equal(scans, 2, '宿主目录缓存还没过期，换个机器人不该再扫一遍')
    const missing = await call(ctx, 'GET', '/api/companion/sessions?botId=nope')
    assert.equal(missing.status, 404)
    assert.equal(missing.json.ok, false)
  } finally {
    for (const dispose of ctx.__disposers.splice(0)) {
      try { await dispose() } catch { /* ignore */ }
    }
    rmSync(join(process.env.DSH_HOME, 'dsh-lingxi-agent-bot'), { recursive: true, force: true })
  }
})