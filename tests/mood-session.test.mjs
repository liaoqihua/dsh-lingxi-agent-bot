import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'companion-mood-session-'))

const configMod = await import('../lib/config.js')
const mood = await import('../lib/mood.js')

function configForTest() {
  const config = configMod.loadConfig()
  config.mood.injectMode = 'event'
  config.mood.injectConfidence = 0
  config.mood.injectPerDay = 2
  return config
}

function prepareState(botId) {
  const state = mood.blankState(botId)
  state.lastReason = '测试心情变化'
  state.lastConfidence = 100
  state.dims.happy = 50
  state.updatedAt = Date.now()
  state.lastDecayAt = Date.now()
  mood.saveState(state)
}

test('心情：同一版本按 session 去重，额度满时挤掉最早一次照样说', () => {
  const config = configForTest()
  prepareState('bot-a')
  let captured = null
  const ctx = { systemPrompt: { context(definition) { captured = definition; return () => {} } } }
  const bot = { id: 'bot-a' }
  mood.installMoodInjection(ctx, () => config, { getBotForSession: () => bot })
  const first = captured.text({ agent: { session: { id: 's1' } } })
  assert.match(first, /测试心情变化/)
  assert.equal(captured.text({ agent: { session: { id: 's1' } } }), '')
  const second = captured.text({ agent: { session: { id: 's2' } } })
  assert.match(second, /测试心情变化/)
  assert.equal(captured.text({ agent: { session: { id: 's1' } } }), '')
  assert.equal(mood.moodSnapshot(config, 'bot-a').saidToday, 2)
  // 额度（2）已经用满：不拒绝，而是挤掉当天最早那次，注进去的永远是当下这份心情。
  const third = captured.text({ agent: { session: { id: 's3' } } })
  assert.match(third, /测试心情变化/, '额度满了也照说')
  const snapshot = mood.moodSnapshot(config, 'bot-a')
  assert.equal(snapshot.saidToday, 2, '条数不超上限')
  // 满额之后心情再变，依然算「可注入」：配额只影响记几条，不影响说不说。
  const bumped = mood.loadState('bot-a')
  bumped.updatedAt = Date.now() + 10
  mood.saveState(bumped)
  assert.equal(mood.moodSnapshot(config, 'bot-a').injectable, true, '满额不等于不可注入')
  rmSync(mood.statePath('bot-a'), { force: true })
})

test('心情：注入配额为 0 时整个关掉', () => {
  const config = configForTest()
  config.mood.injectPerDay = 0
  prepareState('bot-a')
  let captured = null
  const ctx = { systemPrompt: { context(definition) { captured = definition; return () => {} } } }
  mood.installMoodInjection(ctx, () => config, { getBotForSession: () => ({ id: 'bot-a' }) })
  assert.equal(captured.text({ agent: { session: { id: 's1' } } }), '')
  assert.equal(mood.moodSnapshot(config, 'bot-a').injectable, false)
  rmSync(mood.statePath('bot-a'), { force: true })
})

test('心情：普通非 bot 会话不读取旧全局心情', () => {
  const config = configForTest()
  prepareState('bot-a')
  let captured = null
  const ctx = { systemPrompt: { context(definition) { captured = definition; return () => {} } } }
  mood.installMoodInjection(ctx, () => config, { getBotForSession: () => null })
  assert.equal(captured.text({ agent: { session: { id: 'ordinary' } } }), '')
  rmSync(mood.statePath('bot-a'), { force: true })
})

test('心情：注入后快照带出上次说的时间', () => {
  const config = configForTest()
  prepareState('bot-a')
  const before = mood.moodSnapshot(config, 'bot-a')
  assert.equal(before.lastInjectedAt, 0, '还没说过时是 0，前端显示破折号')
  assert.equal(before.saidToday, 0)
  let captured = null
  const ctx = { systemPrompt: { context(definition) { captured = definition; return () => {} } } }
  mood.installMoodInjection(ctx, () => config, { getBotForSession: () => ({ id: 'bot-a' }) })
  assert.match(captured.text({ agent: { session: { id: 's1' } } }), /测试心情变化/)
  const after = mood.moodSnapshot(config, 'bot-a')
  assert.equal(after.saidToday, 1)
  assert.ok(after.lastInjectedAt > 0, '说过之后要有时间戳')
  assert.ok(Date.now() - after.lastInjectedAt < 60_000)
  rmSync(mood.statePath('bot-a'), { force: true })
})
