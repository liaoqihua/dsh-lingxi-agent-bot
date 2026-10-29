import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'companion-status-'))

const configMod = await import('../lib/config.js')
const { installTools } = await import('../lib/tools.js')
const { createFakeCtx, makeAgent, makeRecord } = await import('./fake-ctx.mjs')

test('companion_status：当前会话返回对应机器人的心情、记忆和主动搭话', async () => {
  const config = configMod.loadConfig()
  const ctx = createFakeCtx()
  const record = makeRecord({ botId: 'bot-a', sessionId: 'sid-a' })
  const bridge = {
    recordForSession: () => record,
    listConversations: () => [record],
  }
  const botProactive = { status: (botId) => ({ botId, enabled: true }) }
  installTools(ctx, {
    getConfig: () => config,
    bridge,
    channels: { status: () => [] },
    botManager: { registry: { get: () => ({ id: 'bot-a', name: '机器人甲' }) } },
    proactive: { status: () => ({ botId: 'legacy', enabled: false }) },
    botProactive,
    logger: console,
  })
  const agent = makeAgent('sid-a', ctx)
  const result = await ctx.__tools.get('companion_status').execute({}, { agent })
  assert.equal(result.mood.botId, 'bot-a')
  assert.equal(result.memory.botId, 'bot-a')
  assert.equal(result.proactive.botId, 'bot-a')
  for (const dispose of ctx.__disposers.splice(0)) dispose()
})

test('无机器人会话：companion_status / mood_status 不返回全局心情和主动搭话', async () => {
  const config = configMod.loadConfig()
  const ctx = createFakeCtx()
  const bridge = { recordForSession: () => null, listConversations: () => [] }
  installTools(ctx, {
    getConfig: () => config,
    bridge,
    channels: { status: () => [] },
    botManager: { registry: { get: () => null } },
    proactive: { status: () => ({ botId: 'legacy', enabled: true }) },
    botProactive: { status: () => ({ enabled: false, botId: '' }) },
    logger: console,
  })
  const agent = makeAgent('ordinary-session', ctx)
  const result = await ctx.__tools.get('companion_status').execute({}, { agent })
  assert.equal(result.mood, null)
  assert.equal(result.memory, null)
  assert.equal(result.proactive, null)
  const mood = await ctx.__tools.get('mood_status').execute({}, { agent })
  assert.equal(mood.botId, '')
  assert.equal(mood.mood, null)
  assert.match(mood.text, /只属于机器人/)
  for (const dispose of ctx.__disposers.splice(0)) dispose()
})
