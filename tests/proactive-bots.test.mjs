import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'companion-proactive-bots-'))
const { installBotProactive, loadState, statePath, coolingDown } = await import('../lib/proactive-bots.js')

const config = {
  proactive: { prompt: '在想你', enabled: true, intervalMinutes: 30, hitLine: 30, missBonus: 10, bonusCap: 40, quietStart: 23, quietEnd: 7, minIdleMinutes: 60, cooldownMinutes: 20, maxPerDay: 6 },
}

function conversation(overrides = {}) {
  return {
    key: 'a:qq:c2c:u1', botId: 'bot-a', channel: 'qq', scope: 'c2c', peerId: 'u1', title: '甲的好友',
    sessionId: 's-a', lastHumanAt: Date.now() - 3 * 3600_000,
    proactive: { enabled: true, cooldownMinutes: 0, lastSpokeAt: 0 },
    ...overrides,
  }
}

function makeBridge(rows) {
  const spoken = []
  return {
    spoken,
    rows,
    listConversations: () => rows,
    ensureAgent: async () => ({ status: 'idle' }),
    deliverProactive: async (record, agent, text) => { spoken.push({ botId: record.botId, key: record.key, text }) },
  }
}

function engineFor(bridge, bots, activeConfig = config) {
  return installBotProactive({ interval: () => () => {}, effect: () => () => {} }, {
    getConfig: () => activeConfig, getBots: () => bots, bridge, logger: console,
  })
}

test('主动搭话：文案只认机器人自己的；空文案不会回落到插件级默认', async () => {
  const bots = [{ id: 'bot-a', name: '甲' }]
  const bridge = makeBridge([conversation()])
  const engine = engineFor(bridge, bots)
  // 新机器人的状态是从插件级默认 seed 出来的，所以第一句是有文案的。
  const seeded = loadState('bot-a', config)
  assert.equal(seeded.prompt, '在想你')
  // 把机器人自己的文案清空：即使 config.proactive.prompt 还在，也不该再发那句。
  const manual = loadState('bot-a', config)
  manual.prompt = ''
  manual.enabled = true
  manual.lastSpokeAt = 0
  mkdirSync(join(statePath('bot-a'), '..'), { recursive: true })
  writeFileSync(statePath('bot-a'), JSON.stringify(manual), 'utf8')
  const result = await engine.trigger('bot-a')
  assert.equal(result.spoke, false)
  assert.match(result.reason, /触发文案是空的/)
  assert.equal(bridge.spoken.length, 0)
  rmSync(statePath('bot-a'), { force: true })
})

test('主动搭话：每台机器人只在自己的聊天里开口，状态独立', async () => {
  const bots = [{ id: 'bot-a', name: '甲' }, { id: 'bot-b', name: '乙' }]
  const bridge = makeBridge([
    conversation({ key: 'a:qq:c2c:u1', botId: 'bot-a', peerId: 'u1', title: '甲的好友', sessionId: 's-a' }),
    conversation({ key: 'b:qq:c2c:u2', botId: 'bot-b', peerId: 'u2', title: '乙的好友', sessionId: 's-b' }),
  ])
  const engine = engineFor(bridge, bots)
  const a = await engine.trigger('bot-a')
  assert.equal(a.spoke, true)
  assert.equal(bridge.spoken.length, 1)
  assert.equal(bridge.spoken[0].botId, 'bot-a')
  assert.equal(loadState('bot-a', config).lastSpokeAt > 0, true)
  assert.equal(loadState('bot-b', config).lastSpokeAt, 0)
  const b = await engine.trigger('bot-b')
  assert.equal(b.spoke, true)
  assert.equal(bridge.spoken[1].botId, 'bot-b')
  assert.match(engine.status('bot-a').botName, /甲/)
  rmSync(statePath('bot-a'), { force: true })
  rmSync(statePath('bot-b'), { force: true })
})

test('主动搭话：只挑开了会话级开关的聊天，按最近有人说话降序', async () => {
  const bots = [{ id: 'bot-a', name: '甲' }]
  const now = Date.now()
  const bridge = makeBridge([
    conversation({ key: 'a:qq:c2c:u1', peerId: 'u1', lastHumanAt: now - 10 * 3600_000, proactive: { enabled: true, cooldownMinutes: 0, lastSpokeAt: 0 } }),
    conversation({ key: 'a:qq:group:g1', scope: 'group', peerId: 'g1', lastHumanAt: now - 3600_000, proactive: { enabled: true, cooldownMinutes: 0, lastSpokeAt: 0 } }),
    conversation({ key: 'a:qq:c2c:u3', peerId: 'u3', lastHumanAt: now - 60_000, proactive: { enabled: false, cooldownMinutes: 0, lastSpokeAt: 0 } }),
  ])
  const engine = engineFor(bridge, bots)
  const result = await engine.trigger('bot-a')
  assert.equal(result.spoke, true)
  assert.equal(bridge.spoken[0].key, 'a:qq:group:g1')
  const status = engine.status('bot-a')
  assert.equal(status.conversations.find((row) => row.key === 'a:qq:group:g1').proactive.enabled, true)
  assert.equal(status.conversations.find((row) => row.key === 'a:qq:c2c:u3').proactive.enabled, false)
  assert.equal('targets' in status, false)
  assert.equal('target' in status, false)
  rmSync(statePath('bot-a'), { force: true })
})

test('主动搭话：没有任何会话开着开关就不开口', async () => {
  const bots = [{ id: 'bot-a', name: '甲' }]
  const bridge = makeBridge([
    conversation({ key: 'a:qq:c2c:u1', proactive: { enabled: false, cooldownMinutes: 0, lastSpokeAt: 0 } }),
  ])
  const engine = engineFor(bridge, bots)
  const result = await engine.trigger('bot-a')
  assert.equal(result.spoke, false)
  assert.match(result.reason, /开启主动搭话/)
  assert.equal(bridge.spoken.length, 0)
})

test('主动搭话：冷却只按机器人级那一个值算，会话记录里的旧字段被忽略', async () => {
  const now = Date.now()
  // 只看机器人级冷却：20 分钟内有 lastSpokeAt → 冷却中；没有 → 不在冷却。
  assert.equal(coolingDown({ proactive: { lastSpokeAt: now - 5 * 60_000 } }, 20, now), true)
  assert.equal(coolingDown({ proactive: { lastSpokeAt: 0 } }, 20, now), false)
  // 会话记录里残留的旧 cooldownMinutes 不再有覆盖能力。
  assert.equal(coolingDown({ proactive: { cooldownMinutes: 1, lastSpokeAt: now - 5 * 60_000 } }, 20, now), true)
  assert.equal(coolingDown({ proactive: { cooldownMinutes: 60, lastSpokeAt: now - 5 * 60_000 } }, 0, now), false)

  const bots = [{ id: 'bot-a', name: '甲' }]
  const bridge = makeBridge([
    conversation({
      key: 'a:qq:c2c:u1', lastHumanAt: now - 10 * 3600_000,
      proactive: { enabled: true, lastSpokeAt: now - 5 * 60_000 },
    }),
    conversation({
      key: 'a:qq:c2c:u2', peerId: 'u2', lastHumanAt: now - 9 * 3600_000,
      proactive: { enabled: true, lastSpokeAt: now - 40 * 60_000 },
    }),
  ])
  const bands = { proactive: { ...config.proactive, hitLine: 100 } }
  const engine = engineFor(bridge, bots, bands)
  await engine.tick()
  assert.equal(bridge.spoken.length, 1)
  assert.equal(bridge.spoken[0].key, 'a:qq:c2c:u2')
  assert.equal(loadState('bot-a', config).lastSpokeAt > 0, true)
  rmSync(statePath('bot-a'), { force: true })
})

test('主动搭话：会话拉不起来时给原因，不抛出去', async () => {
  const bots = [{ id: 'bot-a', name: '甲' }]
  const bridge = makeBridge([conversation({ lastHumanAt: Date.now() - 10 * 3600_000 })])
  bridge.ensureAgent = async () => { throw new Error('机器人没有配置私聊会话默认：workspace') }
  const engine = engineFor(bridge, bots)
  const result = await engine.trigger('bot-a')
  assert.equal(result.spoke, false)
  assert.match(result.reason, /私聊会话默认：workspace/)
  rmSync(statePath('bot-a'), { force: true })
})

test('主动搭话：尝试日志会写进 proactive.json，设置页读得到', async () => {
  const bots = [{ id: 'bot-a', name: '甲' }]
  const bridge = makeBridge([conversation({ lastHumanAt: Date.now() - 10 * 3600_000 })])
  // 命中线 0 → 掷骰必定没中，覆盖 tick 里的「没掷中」日志。
  const missAll = { proactive: { ...config.proactive, hitLine: 0, missBonus: 0, bonusCap: 0, quietStart: 0, quietEnd: 0 } }
  const engine = engineFor(bridge, bots, missAll)
  await engine.tick()
  const saved = loadState('bot-a', missAll)
  assert.equal(saved.logs.length, 1)
  assert.match(saved.logs[0].text, /没掷中/)
  assert.equal(engine.status('bot-a').logs.length, 1)

  // 手动开口成功也要落盘（以前 note 在 saveState 之后，日志永远读不到）。
  const hitAll = { proactive: { ...config.proactive, hitLine: 100, quietStart: 0, quietEnd: 0 } }
  const manualEngine = engineFor(bridge, bots, hitAll)
  const result = await manualEngine.trigger('bot-a')
  assert.equal(result.spoke, true)
  const after = loadState('bot-a', hitAll)
  assert.equal(after.logs.length, 2)
  assert.match(after.logs[1].text, /手动 ✓/)
  assert.equal(manualEngine.status('bot-a').logs.length, 2)
  rmSync(statePath('bot-a'), { force: true })
})

test('主动搭话：旧 targets 字段加载时忽略', async () => {
  const dir = statePath('bot-legacy')
  mkdirSync(join(process.env.DSH_HOME, 'dsh-lingxi-agent-bot', 'bots', 'bot-legacy'), { recursive: true })
  writeFileSync(dir, JSON.stringify({
    version: 1, botId: 'bot-legacy', enabled: true, prompt: '旧文案',
    target: 'a:qq:c2c:u1', targets: [{ key: 'a:qq:c2c:u1', enabled: false, cooldownMinutes: 5, lastSpokeAt: 1 }],
  }), 'utf8')
  const state = loadState('bot-legacy', config)
  assert.equal('targets' in state, false)
  assert.equal('target' in state, false)
  assert.equal(state.prompt, '旧文案')
  rmSync(dir, { force: true })
})

test.after(() => rmSync(process.env.DSH_HOME, { recursive: true, force: true }))
