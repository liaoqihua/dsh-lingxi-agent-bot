// 右下角心情挂饰：路由注册、页面注入去重、图片可读。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'companion-widget-'))

const { createFakeCtx } = await import('./fake-ctx.mjs')
const { installMoodWidget } = await import('../lib/widget.js')
const { installApi } = await import('../lib/api.js')

function response() {
  const headers = {}
  let body = ''
  return {
    status: 0,
    headers,
    get body() { return body },
    writeHead(code, nextHeaders) {
      this.status = code
      Object.assign(headers, nextHeaders || {})
    },
    end(value) { body = Buffer.isBuffer(value) ? value : String(value ?? '') },
  }
}

test('心情挂饰：注册脚本与图片路由，并在 index-inject 时注入一次', async () => {
  const ctx = createFakeCtx()
  const dispose = installMoodWidget(ctx, { logger: console })

  const scriptRoute = ctx.__routes.find((row) => row.path === '/api/companion/widget.js')
  const imageRoute = ctx.__routes.find((row) => row.path === '/api/companion/widget/feiyu.png')
  assert.ok(scriptRoute, '应该注册 widget.js 路由')
  assert.ok(imageRoute, '应该注册形象图路由')

  const scriptRes = response()
  await scriptRoute.handler({ method: 'GET', url: '/api/companion/widget.js' }, scriptRes)
  assert.equal(scriptRes.status, 200)
  assert.match(String(scriptRes.headers['content-type']), /javascript/)
  assert.match(String(scriptRes.body), /__lingxiMoodInited/)

  const imageRes = response()
  await imageRoute.handler({ method: 'GET', url: '/api/companion/widget/feiyu.png' }, imageRes)
  assert.equal(imageRes.status, 200)
  assert.equal(imageRes.headers['content-type'], 'image/png')
  assert.ok(imageRes.body.length > 1000, '形象图应该真的读到了')

  const table = []
  ctx.emit('webserver/index-inject', table)
  assert.equal(table.length, 1)
  assert.match(String(table[0].text), /\/api\/companion\/widget\.js/)

  // 再次注入不应该重复加一行
  ctx.emit('webserver/index-inject', table)
  assert.equal(table.length, 1)

  dispose()
  // 卸载必须把路由一并撤掉：否则重载插件会在 webserver 里留下旧实例的路由。
  assert.equal(ctx.__routes.filter((row) => row.path.startsWith('/api/companion/widget')).length, 0)
  const afterDispose = []
  ctx.emit('webserver/index-inject', afterDispose)
  assert.equal(afterDispose.length, 0, '卸载后不该再注入脚本行')
  rmSync(join(process.env.DSH_HOME, 'dsh-lingxi-agent-bot'), { recursive: true, force: true })
})

test('挂饰：脚本用约定的全局变量与事件取当前会话', async () => {
  const ctx = createFakeCtx()
  const dispose = installMoodWidget(ctx, { logger: console })
  const route = ctx.__routes.find((row) => row.path === '/api/companion/widget.js')
  const res = response()
  await route.handler({ method: 'GET', url: '/api/companion/widget.js' }, res)
  // 与 client.js 的约定：全局变量给初值、事件给变化；两边名字必须一致。
  assert.match(res.body, /__dshCompanionSessionId/)
  assert.match(res.body, /dsh-companion:session/)
  assert.match(res.body, /\/session\?sessionId=/)
  dispose()
  rmSync(join(process.env.DSH_HOME, 'dsh-lingxi-agent-bot'), { recursive: true, force: true })
})

test('挂饰：/api/companion/session 按会话推断机器人，非机器人会话给 bound=false', async () => {
  const record = {
    key: 'qq-a:qq:c2c:u1', channel: 'qq', botId: 'bot-a', scope: 'c2c', peerId: 'u1', title: 'QQ 主人',
  }
  const ctx = createFakeCtx()
  installApi(ctx, {
    getConfig: () => ({}),
    setConfig: () => {},
    patchConfig: () => ({}),
    bridge: {
      status: () => ({ conversations: [] }),
      listConversations: () => [],
      // 会话 id 的两种写法（带/不带 session- 前缀）都认。
      recordForSession: (sessionId) => (sessionId === 's-bot' || sessionId === 'session-s-bot' ? record : null),
    },
    channels: { status: () => [] },
    botManager: {
      status: () => [],
      registry: { get: (id) => (id === 'bot-a' ? { id: 'bot-a', name: '机器人甲' } : null) },
    },
    botProactive: { status: () => null },
    logger: console,
  })

  const route = ctx.__routes.find((row) => row.path === '/api/companion/session')
  assert.ok(route, '应该注册 /api/companion/session')

  const bound = response()
  await route.handler({ method: 'GET', url: '/api/companion/session?sessionId=s-bot' }, bound)
  const boundJson = JSON.parse(bound.body)
  assert.equal(boundJson.bound, true)
  assert.equal(boundJson.botId, 'bot-a')
  assert.equal(boundJson.botName, '机器人甲')
  assert.equal(boundJson.chatKey, 'qq-a:qq:c2c:u1')
  assert.equal(boundJson.scope, 'c2c')

  const prefixed = response()
  await route.handler({ method: 'GET', url: '/api/companion/session?sessionId=session-s-bot' }, prefixed)
  assert.equal(JSON.parse(prefixed.body).bound, true)

  const plain = response()
  await route.handler({ method: 'GET', url: '/api/companion/session?sessionId=s-plain' }, plain)
  const plainJson = JSON.parse(plain.body)
  assert.equal(plainJson.bound, false)
  assert.equal(plainJson.botId, '')

  // 机器人被删掉时按未绑定处理：会话记录还留着，但界面不该再出现挂饰。
  const gone = createFakeCtx()
  installApi(gone, {
    getConfig: () => ({}),
    setConfig: () => {},
    patchConfig: () => ({}),
    bridge: {
      status: () => ({ conversations: [] }),
      listConversations: () => [],
      recordForSession: () => record,
    },
    channels: { status: () => [] },
    botManager: { status: () => [], registry: { get: () => null } },
    botProactive: { status: () => null },
    logger: console,
  })
  const goneRoute = gone.__routes.find((row) => row.path === '/api/companion/session')
  const goneRes = response()
  await goneRoute.handler({ method: 'GET', url: '/api/companion/session?sessionId=s-bot' }, goneRes)
  assert.equal(JSON.parse(goneRes.body).bound, false)

  const missing = response()
  await route.handler({ method: 'GET', url: '/api/companion/session' }, missing)
  assert.equal(missing.status, 400)

  const wrongMethod = response()
  await route.handler({ method: 'POST', url: '/api/companion/session' }, wrongMethod)
  assert.equal(wrongMethod.status, 405)

  for (const target of [ctx, gone]) {
    for (const dispose of target.__disposers.splice(0)) {
      try { dispose() } catch { /* ignore */ }
    }
  }
  rmSync(join(process.env.DSH_HOME, 'dsh-lingxi-agent-bot'), { recursive: true, force: true })
})