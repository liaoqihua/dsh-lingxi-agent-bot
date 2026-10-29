import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'companion-workspace-'))

const configMod = await import('../lib/config.js')
const { SessionBridge } = await import('../lib/session-bridge.js')
const { createFakeCtx, makeBot } = await import('./fake-ctx.mjs')

function freshConfig() {
  return configMod.normalize({ channels: { feishu: { enabled: false }, webhook: { enabled: false } } })
}

function cleanup() {
  rmSync(configMod.PATHS.sessions, { force: true })
}

test('工作区：自动创建会 attach 到 bot Workspace，且在首轮 followup 前完成', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  const bot = makeBot({ id: 'bot-workspace', name: '工作区机器人', sessionDefaults: { c2c: { workspace: 'D:\\bot-work' } } })
  const bridge = new SessionBridge(ctx, { getConfig: () => config, getChannel: () => undefined, getBot: () => bot, logger: console })
  const result = await bridge.deliverInbound({
    channel: 'qq', botId: bot.id, scope: 'c2c', peerId: 'u1', text: '在吗', meta: { messageId: 'ws-create-1' },
  })
  assert.equal(result.ok, true)
  assert.equal(ctx.__created[0].options.meta.cwd, bot.sessionDefaults.c2c.workspace)
  const workspace = ctx.__workspaces.find((row) => row.path === bot.sessionDefaults.c2c.workspace)
  assert.ok(workspace)
  assert.ok(workspace.sessionIds.includes(result.sessionId))
  assert.equal(ctx.__workspaceAttachments[0].sessionId, result.sessionId)
  assert.equal(ctx.__followups.length, 1)
  assert.equal(ctx.__sessionRenames.length, 1)
  assert.match(ctx.__sessionRenames[0].title, /^伴侣·工作区机器人-\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  cleanup()
})

test('工作区：attach 失败禁止回退 cwd、禁止投递首轮消息', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  ctx.__workspaceFailure.error = new Error('模拟 attach 失败')
  const bot = makeBot({ id: 'bot-attach-fail', sessionDefaults: { c2c: { workspace: 'D:\\must-attach' } } })
  const bridge = new SessionBridge(ctx, { getConfig: () => config, getChannel: () => undefined, getBot: () => bot, logger: console })
  const result = await bridge.deliverInbound({
    channel: 'qq', botId: bot.id, scope: 'c2c', peerId: 'u1', text: '在吗', meta: { messageId: 'ws-fail-1' },
  })
  assert.equal(result.ok, false)
  assert.equal(ctx.__created[0].options.meta.cwd, bot.sessionDefaults.c2c.workspace)
  assert.equal(ctx.__followups.length, 0)
  assert.match(result.notify, /工作区挂接失败|attach/)
  cleanup()
})

test('工作区：手动绑定已有会话会正式归组', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  const bot = makeBot({ id: 'bot-bind' })
  await ctx.agents.create({ sessionId: 'existing-ungrouped', meta: { cwd: process.cwd() } })
  const bridge = new SessionBridge(ctx, { getConfig: () => config, getChannel: () => undefined, getBot: () => bot, logger: console })
  const record = bridge.touchConversation({ channel: 'qq', botId: bot.id, scope: 'c2c', peerId: 'u1' })
  const bound = await bridge.bindSession(record.key, 'existing-ungrouped')
  assert.equal(bound.sessionId, 'existing-ungrouped')
  assert.ok(ctx.__workspaces[0].sessionIds.includes('existing-ungrouped'))
  cleanup()
})

test('工作区：跨工作区/跨聊天绑定拒绝且不改变原绑定', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  const bot = makeBot({ id: 'bot-cross' })
  await ctx.agents.create({ sessionId: 'other-workspace-session', meta: { cwd: 'D:\\other-workspace' } })
  const bridge = new SessionBridge(ctx, { getConfig: () => config, getChannel: () => undefined, getBot: () => bot, logger: console })
  const record = bridge.touchConversation({ channel: 'qq', botId: bot.id, scope: 'c2c', peerId: 'u1' })
  const before = record.sessionId
  await assert.rejects(() => bridge.bindSession(record.key, 'other-workspace-session'), /工作区|workspace/i)
  assert.equal(record.sessionId, before)
  cleanup()
})

test('工作区：已有会话不需要「新会话默认配置」也能恢复，只有新建才拦', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  // 两段默认配置都空着（真实场景：老机器人的顶层 workspace 被忽略后就是这样）。
  const bot = makeBot({ id: 'bot-no-defaults', sessionDefaults: { c2c: { workspace: '' }, group: { workspace: '' } } })
  // 先把一个会话建在别处，再把它绑给聊天 —— 它自带 cwd，不需要默认值。
  await ctx.agents.create({ sessionId: 'legacy-session', meta: { cwd: process.cwd() } })
  const bridge = new SessionBridge(ctx, { getConfig: () => config, getChannel: () => undefined, getBot: () => bot, logger: console })
  const record = bridge.touchConversation({ channel: 'qq', botId: bot.id, scope: 'c2c', peerId: 'u1' })
  record.sessionId = 'legacy-session'
  bridge.save()
  // 放进「磁盘」再把内存里的 agent 删掉：等价于 DSH 重启后只能 resume。
  ctx.__persisted.set('legacy-session', { header: { ...ctx.__agents.get('legacy-session').session.header } })
  ctx.__agents.delete('legacy-session')
  const resumed = await bridge.ensureAgent(bridge.db.records[record.key])
  assert.ok(resumed, '已有会话应该能 resume 起来')
  assert.equal(resumed.session.id, 'legacy-session')

  // 而第一次来的新聊天要新建会话：这时缺 workspace 必须明确报错。
  const created = await bridge.deliverInbound({
    channel: 'qq', botId: bot.id, scope: 'c2c', peerId: 'u2', text: '在吗', meta: { messageId: 'no-defaults-1' },
  })
  assert.equal(created.ok, false)
  assert.match(created.error, /私聊会话默认：workspace/)
  assert.match(created.notify, /私聊会话默认：workspace/)
  cleanup()
})

test('消息处理：忙碌 queue 使用当前 record.sessionId，并在 turn/end 后 drain', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  const bot = makeBot({ id: 'bot-queue', busyMessageMode: 'queue' })
  const bridge = new SessionBridge(ctx, { getConfig: () => config, getChannel: () => undefined, getBot: () => bot, logger: console })
  bridge.installOutbound()
  const first = await bridge.deliverInbound({ channel: 'qq', botId: bot.id, scope: 'c2c', peerId: 'u1', text: '第一条', meta: { messageId: 'queue-1' } })
  assert.equal(first.ok, true)
  const agent = ctx.agents.get(first.sessionId)
  agent.status = 'running'
  const queued = await bridge.deliverInbound({ channel: 'qq', botId: bot.id, scope: 'c2c', peerId: 'u1', text: '第二条', meta: { messageId: 'queue-2' } })
  assert.equal(queued.ok, true)
  assert.equal(queued.queued, true)
  assert.equal(queued.sessionId, first.sessionId)
  ctx.emit('session/event', agent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(ctx.__followups.length, 2)
  cleanup()
})

test('会话默认：群聊会话用群聊那一段，且缺工作区时入站回提示', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  const bot = makeBot({
    id: 'bot-two-scopes',
    sessionDefaults: { c2c: { workspace: process.cwd() }, group: { workspace: 'D:\\group-only', defaultPermission: 'read-only' } },
  })
  const bridge = new SessionBridge(ctx, { getConfig: () => config, getChannel: () => undefined, getBot: () => bot, logger: console })
  const created = await bridge.deliverInbound({ channel: 'qq', botId: bot.id, scope: 'group', peerId: 'g1', text: '在吗', target: { scope: 'group', targetId: 'g1' }, meta: { messageId: 'two-scope-1' } })
  assert.equal(created.ok, true)
  assert.equal(ctx.__created[0].options.meta.cwd, 'D:\\group-only')
  assert.equal(ctx.agents.get(created.sessionId).session.events.at(-1).data.mode, 'read-only')

  bot.sessionDefaults.group.workspace = ''
  const blocked = await bridge.deliverInbound({ channel: 'qq', botId: bot.id, scope: 'group', peerId: 'g2', text: '在吗', target: { scope: 'group', targetId: 'g2' }, meta: { messageId: 'two-scope-2' } })
  assert.equal(blocked.ok, false)
  assert.match(blocked.notify, /群聊会话默认：workspace/)
  cleanup()
})
