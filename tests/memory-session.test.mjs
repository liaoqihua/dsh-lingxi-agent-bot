import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'companion-memory-session-'))

const configMod = await import('../lib/config.js')
const memory = await import('../lib/memory.js')
const { createFakeCtx, makeAgent } = await import('./fake-ctx.mjs')

test('记忆：普通非 bot 会话不回退旧记忆，bot 会话正常召回', () => {
  const config = configMod.loadConfig()
  memory.addMemories('ordinary', [{ text: '主人喜欢下雨天，特别喜欢雨声' }], { config, source: 'tool', botId: 'bot-other' })
  memory.addMemories('s-bot', [{ text: '主人喜欢机器人自己的雨天记忆' }], { config, source: 'tool', botId: 'bot-a' })
  const ctx = createFakeCtx()
  const agent = makeAgent('ordinary', ctx)
  agent.session.append('user/message', { content: [{ type: 'text', text: '你还记得下雨天吗' }], source: { kind: 'user' } })
  memory.installMemoryInjection(ctx, () => config, { getBotForSession: () => null })
  const ordinary = ctx.__contexts.find((row) => row.name === 'companion:memory')
  assert.equal(ordinary.text({ agent }), '')
  rmSync(memory.storePath('ordinary', 'bot-other'), { force: true })

  const botCtx = createFakeCtx()
  const botAgent = makeAgent('s-bot', botCtx)
  botAgent.session.append('user/message', { content: [{ type: 'text', text: '你还记得机器人自己的雨天记忆吗' }], source: { kind: 'user' } })
  memory.installMemoryInjection(botCtx, () => config, { getBotForSession: () => ({ id: 'bot-a' }) })
  const botContext = botCtx.__contexts.find((row) => row.name === 'companion:memory')
  assert.match(botContext.text({ agent: botAgent }), /机器人自己的雨天记忆/)
  // 手写 config.json 塞一个 memory.enabled=false 也不能让记忆静默失效（插件级开关已移除）。
  const legacyConfig = { ...config, memory: { ...config.memory, enabled: false } }
  const legacyCtx = createFakeCtx()
  const legacyAgent = makeAgent('s-bot', legacyCtx)
  legacyAgent.session.append('user/message', { content: [{ type: 'text', text: '还记得robot自己的雨天记忆吗 机器人自己的雨天记忆' }], source: { kind: 'user' } })
  memory.installMemoryInjection(legacyCtx, () => legacyConfig, { getBotForSession: () => ({ id: 'bot-a' }) })
  const legacyContext = legacyCtx.__contexts.find((row) => row.name === 'companion:memory')
  assert.match(legacyContext.text({ agent: legacyAgent }), /机器人自己的雨天记忆/)
  rmSync(memory.storePath('s-bot', 'bot-a'), { force: true })
})

test('记忆：召回的查询词只取对方真正说的话，来源块不算', () => {
  const config = configMod.loadConfig()
  // 这条记忆只能靠来源块里的词命中：剥掉块之后就不该被召回。
  memory.addMemories('s-block', [{ text: '主人说过 part_of_day 这个词' }], { config, source: 'tool', botId: 'bot-block' })
  const ctx = createFakeCtx()
  const agent = makeAgent('s-block', ctx)
  agent.session.append('user/message', {
    source: { kind: 'companion-im' },
    content: [{
      type: 'text',
      text: '<companion_context>\nnow: 2026-10-29 周四 17:52:31（Asia/Shanghai，UTC+08:00）\npart_of_day: 傍晚\n</companion_context>\n（私聊）\n今天天气不错',
    }],
  })
  memory.installMemoryInjection(ctx, () => config, { getBotForSession: () => ({ id: 'bot-block' }) })
  const context = ctx.__contexts.find((row) => row.name === 'companion:memory')
  assert.equal(String(context.text({ agent })).includes('part_of_day 这个词'), false)
  rmSync(memory.storePath('s-block', 'bot-block'), { force: true })
})
