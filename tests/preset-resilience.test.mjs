// 预设韧性：灵犀必须在「用户自带任意 Agent Preset」的情况下依然可用。
//
// 预设能合法地拿走我们的贡献，两条已知路径：
//   · `@deepseek-ai/dsh-persona` 的 `includeRuntimeContext: false` → suppressRuntimeContext()
//     只抑制**可选**上下文（context）；
//   · 同一行的 `complete: true` → 该前缀成为唯一段落，所有 **section** 被顶掉。
// 所以：核心状态必须注册成 required 的 context（拿不掉），并且要能对账出「还是被拿掉了」。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'companion-preset-'))

const configMod = await import('../lib/config.js')
const health = await import('../lib/injection-health.js')
const { createFakeCtx } = await import('./fake-ctx.mjs')

const SESSION_ID = 'sess-preset-1'
const CHAT_KEY = 'bot-h:webhook:c2c:peer1'
const INJECTIONS = ['companion:persona', 'companion:memory', 'companion:mood', 'companion:guide', 'companion:capabilities', 'companion:voice']

function freshConfig() {
  const config = configMod.normalize({ channels: { feishu: { enabled: false }, webhook: { enabled: false } } })
  config.proactive.enabled = false
  return config
}

function seedSession() {
  mkdirSync(configMod.PATHS.root, { recursive: true })
  writeFileSync(configMod.PATHS.sessions, JSON.stringify({
    version: 1,
    records: {
      [CHAT_KEY]: {
        key: CHAT_KEY,
        channel: 'webhook',
        botId: 'bot-h',
        scope: 'c2c',
        peerId: 'peer1',
        title: '微信 测试者',
        senderName: '测试者',
        sessionId: SESSION_ID,
        target: { conversation: 'peer1' },
        proactive: { enabled: true, cooldownMinutes: 0, lastSpokeAt: 0 },
      },
    },
  }), 'utf8')
  // 守则/人格/记忆/心情都以「这台机器人真的存在」为前提，所以机器人也要种进去。
  writeFileSync(join(configMod.PATHS.root, 'bots.json'), JSON.stringify({
    version: 1,
    bots: [{
      id: 'bot-h',
      channel: 'webhook',
      name: '测试机',
      enabled: false,
      credentials: {},
      sessionDefaults: {
        c2c: { workspace: process.cwd(), preset: '', provider: '', model: '', defaultPermission: 'workspace-write' },
        group: { workspace: process.cwd(), preset: '', provider: '', model: '', defaultPermission: 'workspace-write' },
      },
    }],
  }), 'utf8')
}

function fakeSession() {
  const events = [
    {
      type: 'user/message',
      time: Date.now(),
      data: { message: { role: 'user', content: [{ type: 'text', text: '在吗' }] } },
    },
  ]
  return { id: SESSION_ID, header: { id: SESSION_ID }, events, snapshotEvents() { return events } }
}

test('预设韧性：核心注入都是 required 的 context，守则不再走 section', async () => {
  configMod.saveConfig(freshConfig())
  const { apply } = await import('../index.js')
  const ctx = createFakeCtx()
  apply(ctx)

  const byName = new Map(ctx.__contexts.map((row) => [row.name, row]))
  for (const name of INJECTIONS) {
    const row = byName.get(name)
    assert.ok(row, `${name} 应该注册为 context`)
    assert.equal(row.required, true, `${name} 必须标 required：抑制器只动可选上下文，标了就拿不掉`)
  }
  // 守则如果还是 section，一个 complete:true 的预设人设就能把它整段顶掉。
  assert.equal(
    ctx.__sections.some((row) => row.name === 'companion:guide'),
    false,
    'companion:guide 不该再注册成 section',
  )

  for (const dispose of ctx.__disposers.splice(0)) {
    try { await dispose() } catch { /* ignore */ }
  }
})

test('预设韧性：注入整体没进装配时能对账出来，恢复后告警自动撤掉', async () => {
  configMod.saveConfig(freshConfig())
  seedSession()
  health.resetInjectionHealth()

  const { apply } = await import('../index.js')
  const ctx = createFakeCtx()
  apply(ctx)
  const session = fakeSession()

  // ① 模拟「预设把灵犀的上下文整体拿掉」：五个注入函数一次都没被求值。
  ctx.emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const rows = health.injectionHealth()
  assert.equal(rows.length, 1, '一轮里一个注入都没求值，就该记成被抑制')
  assert.equal(rows[0].sessionId, SESSION_ID)
  assert.equal(rows[0].botId, 'bot-h')
  assert.deepEqual(rows[0].missing.slice().sort(), [...INJECTIONS].sort())
  assert.match(readFileSync(configMod.PATHS.diag, 'utf8'), /注入被抑制/)

  // ② 正常一轮：注入函数都被求值（等价于它们真的进了装配）。
  for (const row of ctx.__contexts) {
    row.text({
      agent: { session: { id: SESSION_ID, header: { id: SESSION_ID } } },
      session: { id: SESSION_ID },
    })
  }
  ctx.emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(health.injectionHealth().length, 0, '恢复正常后不该留着过期告警')

  for (const dispose of ctx.__disposers.splice(0)) {
    try { await dispose() } catch { /* ignore */ }
  }
  rmSync(configMod.PATHS.sessions, { force: true })
})

test('预设韧性：整轮直接失败不算「被抑制」的证据', () => {
  health.resetInjectionHealth()
  const marks = health.takeInjectionMarks('sess-failed')
  const result = health.checkInjection('sess-failed', marks, { botId: 'bot-h', title: '微信 测试者', reasonKind: 'error' })
  assert.equal(result.warned, false, '渲染就失败的回合可能根本没走到装配，不该误报')
  assert.equal(health.injectionHealth().length, 0)
})

test('预设韧性：陪伴守则只注入机器人会话', async () => {
  configMod.saveConfig(freshConfig())
  seedSession()
  health.resetInjectionHealth()

  const { apply } = await import('../index.js')
  const ctx = createFakeCtx()
  apply(ctx)
  const guide = ctx.__contexts.find((row) => row.name === 'companion:guide')
  assert.ok(guide, '守则应该注册成 context')

  const botText = guide.text({ agent: { session: { id: SESSION_ID, header: { id: SESSION_ID } } } })
  assert.match(botText, /长期记忆/, '机器人会话要拿到守则')
  // 工具清单不写进守则：它归 companion:capabilities，两处各写一份必然漂移。
  assert.doesNotMatch(botText, /companion_schedule/, '守则不该再列工具名')

  const capabilities = ctx.__contexts.find((row) => row.name === 'companion:capabilities')
  assert.ok(capabilities, '能力清单应该注册成 context')
  const capabilitiesText = capabilities.text({ agent: { session: { id: SESSION_ID, header: { id: SESSION_ID } } } })
  assert.match(capabilitiesText, /companion_schedule/, '能力清单要提到定时任务')
  assert.match(capabilitiesText, /memory_remember/, '能力清单要提到记忆')
  assert.match(capabilitiesText, /现在用不了：语音条/, 'webhook 机器人没有语音条，要写清楚')

  const otherText = guide.text({ agent: { session: { id: 'plain-session', header: { id: 'plain-session' } } } })
  assert.equal(otherText, '', '普通 DSH 会话不该被灌陪伴守则')

  for (const dispose of ctx.__disposers.splice(0)) {
    try { await dispose() } catch { /* ignore */ }
  }
  rmSync(configMod.PATHS.sessions, { force: true })
})