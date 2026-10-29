// 新会话的元数据写入：预设与权限都必须按宿主契约走。
//
// 两个真实故障：
//   · 机器人没配预设时，旧实现什么都不传 → 会话没有 preset 行，界面显示「无预设」；
//     应当落到宿主登记的默认预设（ctx.agentPresets.resolve()）。
//   · 权限只裸写 `sandbox/mode` → preset 行仍是宿主默认值，两者组合对不上任何预设，
//     界面显示 custom。应当走 ctx.permissionPresets.set(session, preset)，它会同时
//     写 preset 行与 sandbox/approval 开关；没有该服务时才回退裸写。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'companion-create-'))

const configMod = await import('../lib/config.js')
const { SessionBridge } = await import('../lib/session-bridge.js')
const { createFakeCtx, makeBot } = await import('./fake-ctx.mjs')

function freshConfig() {
  return configMod.normalize({ channels: { feishu: { enabled: false }, webhook: { enabled: false } } })
}

async function createSession(ctx, bot, config) {
  const bridge = new SessionBridge(ctx, {
    getBot: () => bot,
    getConfig: () => config,
    getChannel: () => undefined,
    logger: console,
  })
  const result = await bridge.deliverInbound({
    channel: 'webhook',
    botId: bot.id,
    scope: 'c2c',
    peerId: 'wxid_1',
    senderName: '测试者',
    text: '在吗',
    target: { conversation: 'wxid_1' },
    meta: { messageId: `m-${Date.now()}-${Math.random()}` },
  })
  assert.equal(result.ok, true)
  return { bridge, result, created: ctx.__created.at(-1) }
}

test('新会话：机器人没指定预设时落到宿主默认预设', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  ctx.agentPresets = { resolve: async () => ({ id: 'standard', name: '标准' }) }
  const { created } = await createSession(ctx, makeBot({ id: 'bot-a' }), config)
  assert.equal(created.options.meta.agentPreset, 'standard')
  rmSync(configMod.PATHS.sessions, { force: true })
})

test('新会话：机器人指定了预设就用它，不去问默认', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  let resolveCalls = 0
  ctx.agentPresets = { resolve: async () => { resolveCalls += 1; return { id: 'standard' } } }
  const bot = makeBot({ id: 'bot-b', sessionDefaults: { c2c: { preset: 'whale-girl' } } })
  const { created } = await createSession(ctx, bot, config)
  assert.equal(created.options.meta.agentPreset, 'whale-girl')
  assert.equal(resolveCalls, 0)
  rmSync(configMod.PATHS.sessions, { force: true })
})

test('新会话：权限走宿主权限预设，而不是裸写 sandbox/mode', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  const calls = []
  ctx.permissionPresets = {
    set(session, name) { calls.push({ id: session?.id, name }) },
  }
  const bot = makeBot({ id: 'bot-c', sessionDefaults: { c2c: { defaultPermission: 'danger-full-access' } } })
  const { created } = await createSession(ctx, bot, config)
  assert.deepEqual(calls.map((row) => row.name), ['danger-full-access'])
  assert.equal(calls[0].id, created.options.sessionId)
  const agent = created.handle.agent
  assert.equal(
    agent.session.events.some((event) => event.type === 'sandbox/mode'),
    false,
    '有权限预设服务时不该再裸写 sandbox/mode',
  )
  rmSync(configMod.PATHS.sessions, { force: true })
})

test('新会话：宿主没有权限预设服务时回退到裸写 sandbox/mode', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  const bot = makeBot({ id: 'bot-d', sessionDefaults: { c2c: { defaultPermission: 'read-only' } } })
  const { created } = await createSession(ctx, bot, config)
  const agent = created.handle.agent
  assert.equal(
    agent.session.events.some((event) => event.type === 'sandbox/mode' && event.data?.mode === 'read-only'),
    true,
  )
  rmSync(configMod.PATHS.sessions, { force: true })
})

test('飞书入站走同一条创建路径：默认预设与权限预设同样生效', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  ctx.agentPresets = { resolve: async () => ({ id: 'standard' }) }
  const permissionCalls = []
  ctx.permissionPresets = { set(session, name) { permissionCalls.push({ id: session?.id, name }) } }

  const bot = makeBot({
    id: 'bot-fs',
    channel: 'feishu',
    sessionDefaults: { c2c: { preset: '', defaultPermission: 'danger-full-access' } },
  })
  const { FeishuChannel } = await import('../lib/channels/feishu.js')
  const bridge = new SessionBridge(ctx, {
    getBot: () => bot,
    getConfig: () => config,
    getChannel: () => undefined,
    logger: console,
  })
  const channel = new FeishuChannel(ctx, { bridge, getConfig: () => config, botId: bot.id, logger: console })
  await channel.handleEvent({
    message: {
      message_id: 'fs-m1',
      chat_id: 'oc_demo',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '在吗' }),
    },
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_demo' } },
  })

  assert.equal(ctx.__followups.length, 1, '飞书入站应投递到会话')
  assert.equal(ctx.__created.at(-1).options.meta.agentPreset, 'standard', '飞书会话也要落到宿主默认预设')
  assert.deepEqual(permissionCalls.map((row) => row.name), ['danger-full-access'], '飞书会话权限同样走权限预设')
  rmSync(configMod.PATHS.sessions, { force: true })
})