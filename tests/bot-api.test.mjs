import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'companion-bot-api-'))

const configMod = await import('../lib/config.js')
const { createFakeCtx } = await import('./fake-ctx.mjs')

function request(method, url, body) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  return { method, url, headers: {}, async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw, 'utf8') } }
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

test('机器人 API：工作区归属、共享记忆与新会话默认校验', async () => {
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
      name: '接口机器人',
      sessionDefaults: {
        c2c: { workspace: process.cwd(), defaultPermission: 'workspace-write' },
        group: { workspace: process.cwd(), defaultPermission: 'read-only' },
      },
    })
    assert.equal(added.status, 200, added.raw)
    const botId = added.json.bot.id
    await ctx.agents.create({ sessionId: 'api-ungrouped-session', meta: { cwd: process.cwd() } })

    const state = await call(ctx, 'GET', '/api/companion/state')
    assert.equal(state.status, 200, state.raw)
    assert.ok(Array.isArray(state.json.workspaceDetails))
    assert.equal(state.json.workspaceDetails[0].path, process.cwd())
    // 宿主会话目录不再塞进 /state（整目录扫描太贵），改由 /sessions 按需给。
    assert.equal(state.json.sessionsAll, undefined)
    const sessions = await call(ctx, 'GET', '/api/companion/sessions?botId=' + encodeURIComponent(botId))
    assert.equal(sessions.status, 200, sessions.raw)
    const row = sessions.json.sessions.find((item) => item.id === 'api-ungrouped-session')
    assert.ok(row, sessions.raw)
    assert.equal(row.workspaceId, state.json.workspaceDetails[0].id)
    assert.equal(row.grouped, false)
    assert.equal(row.boundKey, '')
    const missingBot = await call(ctx, 'GET', '/api/companion/sessions?botId=nope')
    assert.equal(missingBot.status, 404)
    assert.ok(Array.isArray(state.json.personas))
    assert.ok(Array.isArray(state.json.memories))

    const remembered = await call(ctx, 'POST', '/api/companion/memory', {
      action: 'remember', botId, text: '主人喜欢机器人共享的雨天记忆', importance: 80,
    })
    assert.equal(remembered.status, 200, remembered.raw)
    const memory = await call(ctx, 'GET', '/api/companion/memory?botId=' + encodeURIComponent(botId))
    assert.equal(memory.status, 200, memory.raw)
    assert.equal(memory.json.count, 1)
    const memoryId = memory.json.memories[0].id
    const forgotten = await call(ctx, 'POST', '/api/companion/memory', { action: 'forget', botId, id: memoryId })
    assert.equal(forgotten.status, 200, forgotten.raw)
    assert.equal(forgotten.json.forgotten, 1)

    // 新会话默认配置：缺哪项就报哪项，补齐后才落库。
    const incomplete = await call(ctx, 'POST', '/api/companion/bots', {
      action: 'update',
      botId,
      patch: {
        sessionDefaults: {
          c2c: { workspace: process.cwd(), defaultPermission: 'workspace-write' },
          group: { workspace: '', defaultPermission: 'read-only' },
        },
      },
    })
    assert.equal(incomplete.status, 400)
    assert.deepEqual(incomplete.json.missing, ['群聊：工作区'])
    const badPermission = await call(ctx, 'POST', '/api/companion/bots', {
      action: 'update',
      botId,
      patch: {
        sessionDefaults: {
          c2c: { workspace: process.cwd(), defaultPermission: 'not-a-mode' },
          group: { workspace: process.cwd(), defaultPermission: 'read-only' },
        },
      },
    })
    assert.equal(badPermission.status, 400)
    assert.deepEqual(badPermission.json.missing, ['私聊：默认权限'])
    const stillOld = await call(ctx, 'GET', '/api/companion/state')
    assert.equal(stillOld.json.bots.find((item) => item.id === botId).sessionDefaults.group.workspace, process.cwd())
    assert.equal(stillOld.json.bots.find((item) => item.id === botId).sessionDefaults.c2c.defaultPermission, 'workspace-write')

    const updated = await call(ctx, 'POST', '/api/companion/bots', {
      action: 'update',
      botId,
      patch: {
        sessionDefaults: {
          c2c: { workspace: 'D:\\bot-work', defaultPermission: 'read-only' },
          group: { workspace: 'D:\\bot-work-group', defaultPermission: 'read-only' },
        },
      },
    })
    assert.equal(updated.status, 200, updated.raw)
    assert.equal(updated.json.bot.sessionDefaults.c2c.workspace, 'D:\\bot-work')
    assert.equal(updated.json.bot.sessionDefaults.c2c.defaultPermission, 'read-only')
    assert.equal(updated.json.bot.sessionDefaults.group.workspace, 'D:\\bot-work-group')

    // 「她怎么叫你」走同一条 update：存进 bots.json，state 里能读回来。
    const renamed = await call(ctx, 'POST', '/api/companion/bots', {
      action: 'update',
      botId,
      patch: { ownerName: ' 小明 ' },
    })
    assert.equal(renamed.status, 200, renamed.raw)
    assert.equal(renamed.json.bot.ownerName, '小明')
    const withOwner = await call(ctx, 'GET', '/api/companion/state')
    assert.equal(withOwner.json.bots.find((item) => item.id === botId).ownerName, '小明')
    // 清空 = 回落到插件级默认，不是把字段删掉。
    const cleared = await call(ctx, 'POST', '/api/companion/bots', {
      action: 'update',
      botId,
      patch: { ownerName: '' },
    })
    assert.equal(cleared.json.bot.ownerName, '')
  } finally {
    for (const dispose of ctx.__disposers.splice(0)) {
      try { await dispose() } catch { /* ignore */ }
    }
    rmSync(join(process.env.DSH_HOME, 'dsh-lingxi-agent-bot'), { recursive: true, force: true })
  }
})
