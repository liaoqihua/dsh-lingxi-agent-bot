import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'companion-test-'))

const configMod = await import('../lib/config.js')
const persona = await import('../lib/persona.js')
const memory = await import('../lib/memory.js')
const mood = await import('../lib/mood.js')
const proactive = await import('../lib/proactive-bots.js')
const { SessionBridge } = await import('../lib/session-bridge.js')
const { sanitizeConfig, cleanUiPatch } = await import('../lib/api.js')
const { createFakeCtx, makeAgent, makeBot, makeRecord } = await import('./fake-ctx.mjs')

function freshConfig() {
  return configMod.normalize({ channels: { feishu: { enabled: false }, webhook: { enabled: false } } })
}

test('设置页：密钥空值不会覆盖已有值', () => {
  const current = {
    channels: { feishu: { appSecret: 'real-secret' } },
    voice: { apiKey: 'real-key' },
  }
  const { config, secretSet } = sanitizeConfig(current)
  assert.equal(config.channels.feishu.appSecret, '')
  assert.equal(secretSet['channels.feishu.appSecret'], true)
  const patch = cleanUiPatch({ channels: { feishu: { appSecret: '', appId: 'cli_x' } }, voice: { apiKey: '' } }, current)
  assert.equal(patch.channels.feishu.appSecret, undefined)
  assert.equal(patch.voice.apiKey, undefined)
  assert.equal(patch.channels.feishu.appId, 'cli_x')
  const cleared = cleanUiPatch({ channels: { feishu: { appSecret: 'new-secret' } } }, current)
  assert.equal(cleared.channels.feishu.appSecret, 'new-secret')
})

test('配置：人格/记忆/心情没有插件级开关（旧字段加载时忽略）', () => {
  const config = freshConfig()
  for (const key of ['persona', 'memory', 'mood']) {
    assert.equal(config[key].enabled, undefined, `${key} 不该有插件级 enabled`)
  }
  // 手写 config.json 里留了这些旧字段也不能让模块静默失效：归一化直接丢掉。
  const normalized = configMod.normalize({
    persona: { enabled: false },
    memory: { enabled: false, dailyQuota: 5 },
    mood: { enabled: false, base: 60 },
  })
  assert.equal(normalized.persona.enabled, undefined)
  assert.equal(normalized.memory.enabled, undefined)
  assert.equal(normalized.mood.enabled, undefined)
  assert.equal(normalized.memory.dailyQuota, 5, '其它字段照常生效')
  assert.equal(normalized.mood.base, 60)
})

test('人格：普通会话不注入 companion 人格', () => {
  const config = freshConfig()
  let captured = null
  const ctx = { systemPrompt: { context(options) { captured = options; return () => {} } } }
  persona.installPersonaInjection(ctx, () => config, {
    getBotForSession: () => null,
    getBotPersona: () => '不该出现',
  })
  assert.equal(captured.text({ agent: { session: { id: 'normal' } } }), '')
})

test('人格：机器人会话只注入它自己的人格文件，不混全局底座', () => {
  const config = freshConfig()
  let captured = null
  const ctx = {
    systemPrompt: {
      context(options) { captured = options; return () => {} },
    },
  }
  const bot = { id: 'qq-a', name: '甲' }
  persona.installPersonaInjection(ctx, () => config, {
    getBotForSession: (sessionId) => (sessionId === 'bot-session' ? bot : null),
    getBotPersona: () => '# 甲的人格\n只属于甲。',
  })
  const text = captured.text({ agent: { session: { id: 'bot-session', header: { cwd: process.cwd() } } } })
  assert.equal(text, '# 甲的人格\n只属于甲。')
  const ordinary = captured.text({ agent: { session: { id: 'normal', header: { cwd: process.cwd() } } } })
  assert.doesNotMatch(ordinary, /只属于甲/)
})

test('记忆：证据召回、事实键取代、软删除、每日配额', () => {
  const config = freshConfig()
  const sessionId = 'session-memory-test'
  const botId = 'bot-memory'
  rmSync(memory.storePath(sessionId, botId), { force: true })
  const added = memory.addMemories(sessionId, [
    { text: '主人喜欢下雨天，说雨声能让心静下来', importance: 80, emotion: 50, longTerm: true },
    { text: '主人身高一米七', importance: 60, factKey: '主人.身高' },
    { text: '主人在车站旁边买过一盆绿萝', importance: 40 },
  ], { config, source: 'tool', botId })
  assert.equal(added.added.length, 3)
  const recall = memory.recall({ sessionId, botId, query: '你还记得车站那盆花吗', config })
  assert.ok(recall.items.some((item) => item.text.includes('车站')))
  assert.equal(recall.items.some((item) => item.text.includes('下雨天')), false)

  memory.addMemories(sessionId, [{ text: '主人身高一米七五', factKey: '主人.身高' }], { config, source: 'tool', botId })
  const store = memory.loadStore(sessionId, botId)
  const old = store.memories.find((m) => m.text.includes('一米七'))
  assert.ok(old.supersededAt > 0)
  const after = memory.recall({ sessionId, botId, query: '主人身高多少', config })
  assert.equal(after.items.some((item) => item.text === '主人身高一米七'), false)
  assert.ok(after.items.some((item) => item.text.includes('一米七五')))

  const forgotten = memory.forgetForTool(sessionId, { query: '下雨天' }, botId)
  assert.equal(forgotten.forgotten, 1)
  assert.equal(memory.recall({ sessionId, botId, query: '下雨天', config }).items.length, 0)
  rmSync(memory.storePath(sessionId, botId), { force: true })
})

test('记忆：同一机器人的不同聊天共享记忆，不同机器人隔离', () => {
  const config = freshConfig()
  memory.addMemories('chat-a', [{ text: '主人喜欢在雨天听老歌，尤其喜欢《晴天》' }], {
    config, source: 'tool', botId: 'bot-a',
  })
  memory.addMemories('chat-b', [{ text: '主人说雨天不要忘记带伞' }], {
    config, source: 'tool', botId: 'bot-a',
  })
  const shared = memory.recall({ sessionId: 'chat-c', botId: 'bot-a', query: '雨天听歌', config })
  assert.ok(shared.items.some((item) => item.text.includes('老歌')))
  assert.ok(shared.items.some((item) => item.text.includes('带伞')))
  const other = memory.recall({ sessionId: 'chat-c', botId: 'bot-b', query: '雨天听歌', config })
  assert.equal(other.items.length, 0)
  assert.ok(memory.storePath('chat-a', 'bot-a').includes('bots'))
  rmSync(memory.storePath('chat-a', 'bot-a'), { force: true })
})

test('记忆：模型提炼写入，超额时降级/跳过', async () => {
  const config = freshConfig()
  config.memory.extractEveryTurns = 1
  const ctx = createFakeCtx({
    llmText: JSON.stringify({ memories: [{ text: '主人今天说想养一只猫，叫团子', importance: 70, emotion: 40, longTerm: false }] }),
  })
  const agent = makeAgent('session-extract', ctx)
  agent.session.append('user/message', { content: [{ type: 'text', text: '我想养一只猫，叫团子' }], source: { kind: 'user' } })
  agent.session.append('assistant/message', { message: { content: [{ type: 'text', text: '团子这个名字好可爱' }] } })
  const result = await memory.maybeExtract(ctx, {
    agent,
    session: agent.session,
    userText: '我想养一只猫，叫团子',
    replyText: '团子这个名字好可爱',
    config,
    botId: 'bot-extract',
  })
  assert.equal(result.added.length, 1)
  assert.match(result.added[0].text, /团子/)
  rmSync(memory.storePath('session-extract', 'bot-extract'), { force: true })
})

test('心情：模型判断后全局状态更新，一次变化只注入一次', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx({
    llmText: JSON.stringify({
      moodDelta: 6,
      dims: { happy: 5, sweet: 3 },
      reason: '饲养员夸我，我当时尾巴都要摇起来了',
      confidence: 92,
    }),
  })
  const agent = makeAgent('session-mood', ctx)
  const state = await mood.maybeJudge(ctx, {
    agent,
    userText: '大肥鱼今天表现真好，夸夸你',
    replyText: '被你夸得有点不好意思了',
    config,
    ownerName: '饲养员',
    botId: 'bot-mood',
  })
  assert.ok(state)
  assert.equal(state.mood, 72)
  assert.equal(state.dims.happy, 5)
  const snapshot = mood.moodSnapshot(config, 'bot-mood')
  assert.equal(snapshot.injectable, true)
  assert.match(snapshot.preview, /尾巴/)
  const line = mood.moodLine(mood.getState(config, { persist: false, botId: 'bot-mood' }), config, '饲养员')
  assert.match(line, /饲养员/)
  rmSync(mood.statePath('bot-mood'), { force: true })
})

test('心情：衰减会向基线回落', () => {
  const config = freshConfig()
  const state = mood.blankState()
  state.mood = 95
  state.lastNotedMood = 95
  state.lastDecayAt = Date.now() - 24 * 3_600_000
  mood.decay(state, config, Date.now())
  assert.ok(state.mood < 95 && state.mood > config.mood.base)
})

test('主动搭话：安静时段与命中线计算', () => {
  assert.equal(proactive.inQuietHours(23, 23, 7), true)
  assert.equal(proactive.inQuietHours(3, 23, 7), true)
  assert.equal(proactive.inQuietHours(12, 23, 7), false)
  assert.equal(proactive.inQuietHours(0, 0, 0), false)
  const { line, bonus } = proactive.hitLineOf({ hitLine: 30, missBonus: 10, bonusCap: 40, misses: 2 })
  assert.equal(bonus, 20)
  assert.equal(line, 50)
})

test('心情：不同机器人各自独立，重置只影响自己', () => {
  const config = freshConfig()
  const a = mood.loadState('bot-a')
  a.mood = 90
  a.dims.happy = 70
  mood.saveState(a)
  const b = mood.loadState('bot-b')
  b.mood = 30
  mood.saveState(b)
  assert.equal(mood.moodSnapshot(config, 'bot-a').mood, 90)
  assert.equal(mood.moodSnapshot(config, 'bot-b').mood, 30)
  mood.resetMood(config, 'bot-a')
  assert.equal(mood.moodSnapshot(config, 'bot-a').mood, config.mood.base)
  assert.equal(mood.moodSnapshot(config, 'bot-b').mood, 30)
  rmSync(mood.statePath('bot-a'), { force: true })
  rmSync(mood.statePath('bot-b'), { force: true })
})

test('会话桥：入站 followup 与出站回合投递', async () => {
  const config = freshConfig()
  config.channels.webhook.maxChars = 1_500
  const ctx = createFakeCtx()
  const sent = []
  const fakeChannel = { send: async (payload) => { sent.push(payload); return { ok: true, messageId: 1 } } }
  const bridge = new SessionBridge(ctx, { getBot: (id) => makeBot({ id }), getConfig: () => config, getBotChannel: () => fakeChannel, logger: console })
  bridge.installOutbound()
  const result = await bridge.deliverInbound({
    channel: 'webhook', botId: 'bot-test', scope: 'c2c', peerId: 'wxid_1', senderName: '饲养员', text: '在吗',
    target: { conversation: 'wxid_1' }, meta: { messageId: 'm1' },
  })
  assert.equal(result.ok, true)
  assert.equal(ctx.__followups.length, 1)
  assert.equal(ctx.__followups[0].message.source.kind, 'companion-im')
  // 来源块的时间永远在；私聊与群聊都用场景行显式标记说话场景。
  const first = ctx.__followups[0].message.content[0].text
  assert.match(first, /<companion_context>/)
  assert.match(first, /now: \d{4}-\d{2}-\d{2} 周[一二三四五六日] \d{2}:\d{2}:\d{2}/)
  assert.match(first, /（私聊）\n在吗$/)
  const agent = ctx.agents.get(result.sessionId)
  ctx.emit('session/event', agent.session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '在的，刚想找你。' }] } },
  })
  ctx.emit('session/event', agent.session, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /刚想找你/)
  assert.equal(sent[0].record.key, 'bot-test:webhook:c2c:wxid_1')
  rmSync(configMod.PATHS.sessions, { force: true })
})

test('会话桥：群聊正文带发言人标记', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  const bridge = new SessionBridge(ctx, { getBot: (id) => makeBot({ id }), getConfig: () => config, getChannel: () => undefined, logger: console })
  await bridge.deliverInbound({
    channel: 'qq', botId: 'bot-g2', scope: 'group', peerId: 'g1', senderName: '群友甲', text: '在吗',
    target: { scope: 'group', targetId: 'g1' }, meta: { messageId: 'sc-1' },
  })
  assert.match(ctx.__followups.at(-1).message.content[0].text, /（群聊 · 发言人：群友甲）\n在吗$/)
  rmSync(configMod.PATHS.sessions, { force: true })
})

test('会话桥：QQ 的工作目录 / Preset / 模型按 scope 取，两段互不串味', async () => {
  const config = freshConfig()
  const bot = makeBot({
    id: 'qq-settings',
    sessionDefaults: {
      c2c: { workspace: 'D:\\.dsh\\qq', preset: 'whale-girl', provider: 'deepseek-account', model: 'deepseek-chat' },
      group: { workspace: 'D:\\.dsh\\qq-group', preset: 'group-preset', provider: 'p2', model: 'm2' },
    },
  })
  const ctx = createFakeCtx()
  const bridge = new SessionBridge(ctx, { getConfig: () => config, getBot: () => bot, getChannel: () => undefined, logger: console })
  await bridge.deliverInbound({
    channel: 'qq', botId: 'qq-settings', scope: 'c2c', peerId: 'u1', senderName: '饲养员', text: '在吗',
    target: { scope: 'c2c', targetId: 'u1' }, meta: { messageId: 'q1' },
  })
  const c2cOptions = ctx.__created[0].options
  assert.equal(c2cOptions.meta.cwd, 'D:\\.dsh\\qq')
  assert.equal(c2cOptions.meta.agentPreset, 'whale-girl')
  assert.equal(c2cOptions.agentOptions.provider, 'deepseek-account')
  assert.equal(c2cOptions.agentOptions.model, 'deepseek-chat')
  await bridge.deliverInbound({
    channel: 'qq', botId: 'qq-settings', scope: 'group', peerId: 'g1', senderName: '群友', text: '在吗',
    target: { scope: 'group', targetId: 'g1' }, meta: { messageId: 'q2' },
  })
  const groupOptions = ctx.__created[1].options
  assert.equal(groupOptions.meta.cwd, 'D:\\.dsh\\qq-group')
  assert.equal(groupOptions.meta.agentPreset, 'group-preset')
  assert.equal(groupOptions.agentOptions.model, 'm2')
  rmSync(configMod.PATHS.sessions, { force: true })
})

test('会话桥：缺工作区不回落，入站返回带原因的 notify', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  const bot = makeBot({ id: 'bot-nocfg', sessionDefaults: { group: { workspace: '' } } })
  const bridge = new SessionBridge(ctx, { getConfig: () => config, getBot: () => bot, getChannel: () => undefined, logger: console })
  const result = await bridge.deliverInbound({
    channel: 'qq', botId: 'bot-nocfg', scope: 'group', peerId: 'g1', senderName: '群友', text: '在吗',
    target: { scope: 'group', targetId: 'g1' }, meta: { messageId: 'nocfg-1' },
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /群聊会话默认：workspace/)
  assert.match(result.notify, /群聊会话默认：workspace/)
  assert.equal(ctx.__followups.length, 0)
  assert.equal(ctx.__created.length, 0)
  rmSync(configMod.PATHS.sessions, { force: true })
})

test('会话：新会话主动搭话开关按 scope 默认（私聊开 / 群聊关）', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  const bridge = new SessionBridge(ctx, { getBot: (id) => makeBot({ id }), getConfig: () => config, getChannel: () => undefined, logger: console })
  const c2c = bridge.touchConversation({ channel: 'qq', botId: 'bot-switch', scope: 'c2c', peerId: 'u1' })
  const group = bridge.touchConversation({ channel: 'qq', botId: 'bot-switch', scope: 'group', peerId: 'g1' })
  assert.equal(c2c.proactive.enabled, true)
  assert.equal(group.proactive.enabled, false)
  const updated = bridge.updateConversation(group.key, { proactive: { enabled: true, cooldownMinutes: 5 } })
  assert.equal(updated.proactive.enabled, true)
  // 冷却只属于机器人级「主动搭话」参数：会话记录里没有这个字段，旧参数传进来也不落库。
  assert.equal(updated.proactive.cooldownMinutes, undefined)
  assert.equal(bridge.status().conversations.find((row) => row.key === group.key).proactive.cooldownMinutes, undefined)
  rmSync(configMod.PATHS.sessions, { force: true })
})

test('会话：主动语音开关与主动搭话同构（私聊默认开 / 群聊默认关，可按聊天改）', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  const bridge = new SessionBridge(ctx, { getBot: (id) => makeBot({ id }), getConfig: () => config, getChannel: () => undefined, logger: console })
  const c2c = bridge.touchConversation({ channel: 'qq', botId: 'bot-voice', scope: 'c2c', peerId: 'u1' })
  const group = bridge.touchConversation({ channel: 'qq', botId: 'bot-voice', scope: 'group', peerId: 'g1' })
  assert.equal(c2c.voicePrompt.enabled, true)
  assert.equal(group.voicePrompt.enabled, false, '群里默认不发语音')

  const updated = bridge.updateConversation(group.key, { voicePrompt: { enabled: true } })
  assert.equal(updated.voicePrompt.enabled, true)
  // 状态接口与 listConversations 都要带上（设置页按它渲染勾选）。
  assert.equal(bridge.status().conversations.find((row) => row.key === group.key).voicePrompt.enabled, true)
  assert.equal(bridge.listConversations().find((row) => row.key === c2c.key).voicePrompt.enabled, true)

  bridge.updateConversation(c2c.key, { voicePrompt: { enabled: false } })
  // 落盘后重新加载：显式关掉的不会被 scope 默认值翻回开。
  const reloaded = new SessionBridge(ctx, { getBot: (id) => makeBot({ id }), getConfig: () => config, getChannel: () => undefined, logger: console })
  assert.equal(reloaded.recordForConversation({ channel: 'qq', botId: 'bot-voice', scope: 'c2c', peerId: 'u1' }).voicePrompt.enabled, false)
  rmSync(configMod.PATHS.sessions, { force: true })
})

test('会话：重命名后不再被入站自动标题覆盖', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  const bridge = new SessionBridge(ctx, { getBot: (id) => makeBot({ id }), getConfig: () => config, getChannel: () => undefined, logger: console })
  const record = bridge.touchConversation({ channel: 'qq', botId: 'bot-rename', scope: 'c2c', peerId: 'u1', title: '自动标题' })
  bridge.updateConversation(record.key, { title: '老友' })
  const again = bridge.touchConversation({ channel: 'qq', botId: 'bot-rename', scope: 'c2c', peerId: 'u1', title: '自动标题' })
  assert.equal(again.title, '老友')
  assert.equal(again.renamed, true)
  rmSync(configMod.PATHS.sessions, { force: true })
})

test('会话桥：不同 botId 的同一个 peer 会分成不同会话', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  const bridge = new SessionBridge(ctx, { getBot: (id) => makeBot({ id }), getConfig: () => config, getChannel: () => undefined, logger: console })
  const a = await bridge.deliverInbound({
    channel: 'qq', botId: 'qq-a', botName: '甲', scope: 'c2c', peerId: 'same', senderName: '饲养员', text: '我是甲',
    target: { scope: 'c2c', targetId: 'same' }, meta: { messageId: 'bot-a-1' },
  })
  const b = await bridge.deliverInbound({
    channel: 'qq', botId: 'qq-b', botName: '乙', scope: 'c2c', peerId: 'same', senderName: '饲养员', text: '我是乙',
    target: { scope: 'c2c', targetId: 'same' }, meta: { messageId: 'bot-b-1' },
  })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.notEqual(a.record.key, b.record.key)
  assert.notEqual(a.record.sessionId, b.record.sessionId)
  assert.match(a.record.title, /甲/)
  assert.match(b.record.title, /乙/)
  rmSync(configMod.PATHS.sessions, { force: true })
})

test('会话桥：出站优先走机器人自己的连接', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  const sent = []
  const botChannel = { async send(payload) { sent.push(payload); return { ok: true, messageId: 'm1' } } }
  const bridge = new SessionBridge(ctx, {
    getConfig: () => config,
    getChannel: () => ({ async send() { throw new Error('不应该走旧通道') } }),
    getBotChannel: () => botChannel,
    logger: console,
  })
  const record = bridge.touchConversation({ channel: 'qq', botId: 'qq-a', scope: 'c2c', peerId: 'u1' })
  const result = await bridge.sendToConversation(record, { text: '你好' })
  assert.equal(result.ok, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].record.botId, 'qq-a')
  rmSync(configMod.PATHS.sessions, { force: true })
})

test('会话桥：一个聊天可以绑已有会话，同一个会话不能同时绑两个聊天', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  await ctx.agents.create({ sessionId: 'existing-session', meta: { cwd: process.cwd() } })
  const bridge = new SessionBridge(ctx, { getBot: (id) => makeBot({ id }), getConfig: () => config, getChannel: () => undefined, logger: console })
  const first = bridge.touchConversation({ channel: 'qq', botId: 'bot-a', scope: 'c2c', peerId: 'u1' })
  const second = bridge.touchConversation({ channel: 'qq', botId: 'bot-a', scope: 'c2c', peerId: 'u2' })
  const bound = await bridge.bindSession(first.key, 'existing-session')
  assert.equal(bound.sessionId, 'existing-session')
  await assert.rejects(() => bridge.bindSession(second.key, 'existing-session'), /另一个聊天/)
  const auto = await bridge.bindSession(second.key, '')
  assert.notEqual(auto.sessionId, 'existing-session')
  assert.notEqual(auto.sessionId, 'existing-session')
  rmSync(configMod.PATHS.sessions, { force: true })
})

test('群聊默认关闭：机器人开了群聊才接收群消息', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  const bot = makeBot({ id: 'qq-group', groupEnabled: false })
  const bridge = new SessionBridge(ctx, {
    getConfig: () => config,
    getChannel: () => undefined,
    getBot: () => bot,
    logger: console,
  })
  const blocked = await bridge.deliverInbound({
    channel: 'qq', botId: 'qq-group', scope: 'group', peerId: 'g1', senderName: '群友', text: '在吗',
    target: { scope: 'group', targetId: 'g1' }, meta: { messageId: 'g-1' },
  })
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /群聊/)
  // 不该因为「机器人没开群聊」回话给群里——只留结构化错误。
  assert.equal(blocked.notify, undefined)
  bot.groupEnabled = true
  const allowed = await bridge.deliverInbound({
    channel: 'qq', botId: 'qq-group', scope: 'group', peerId: 'g1', senderName: '群友', text: '在吗',
    target: { scope: 'group', targetId: 'g1' }, meta: { messageId: 'g-2' },
  })
  assert.equal(allowed.ok, true)
  rmSync(configMod.PATHS.sessions, { force: true })
})

test('会话桥：移除机器人聊天会释放会话，不再占用', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  const bridge = new SessionBridge(ctx, { getBot: (id) => makeBot({ id }), getConfig: () => config, getChannel: () => undefined, logger: console })
  const record = bridge.touchConversation({ channel: 'webhook', botId: 'bot-x', scope: 'c2c', peerId: 'p1' })
  const sessionId = record.sessionId
  await ctx.agents.create({ sessionId, meta: { cwd: process.cwd() } })
  assert.equal(bridge.removeConversation(record.key), true)
  assert.equal(bridge.listConversations().length, 0)
  const other = bridge.touchConversation({ channel: 'webhook', botId: 'bot-y', scope: 'c2c', peerId: 'p2' })
  const bound = await bridge.bindSession(other.key, sessionId)
  assert.equal(bound.sessionId, sessionId)
  rmSync(configMod.PATHS.sessions, { force: true })
})

test('访问控制：block 名单拒绝，allow 名单放行；上下文增强会带来源字段', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  const bot = makeBot({
    id: 'bot-access',
    groupEnabled: true,
    access: { mode: 'block', users: ['bad'], groups: [] },
    contextEnhancement: { enabled: true, includeSender: true, includeChat: true, guidance: '群里只回答被 @ 的问题' },
  })
  const bridge = new SessionBridge(ctx, { getBot: (id) => makeBot({ id }), getConfig: () => config, getChannel: () => undefined, getBot: () => bot, logger: console })
  const blocked = await bridge.deliverInbound({
    channel: 'webhook', botId: bot.id, scope: 'c2c', peerId: 'bad', senderId: 'bad', senderName: '坏人', text: '在吗',
    target: { conversation: 'bad' }, meta: { messageId: 'access-1' },
  })
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /访问名单/)
  // 被访问名单挡掉的消息不回提示（否则等于给拉黑的人回声）。
  assert.equal(blocked.notify, undefined)
  bot.access = { mode: 'allow', users: ['good'], groups: [] }
  const allowed = await bridge.deliverInbound({
    channel: 'webhook', botId: bot.id, scope: 'c2c', peerId: 'good', senderId: 'good', senderName: '好人', text: '在吗',
    target: { conversation: 'good' }, meta: { messageId: 'access-2' },
  })
  assert.equal(allowed.ok, true)
  const text = ctx.__followups.at(-1).message.content[0].text
  assert.match(text, /<companion_context>/)
  assert.match(text, /access|webhook/)
  assert.match(text, /（私聊）/)
  rmSync(configMod.PATHS.sessions, { force: true })
})

test('会话：手动把聊天绑到已有会话后，第一条消息直接用它', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  const sessionId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  await ctx.agents.create({ sessionId, meta: { cwd: process.cwd() } })
  const bridge = new SessionBridge(ctx, { getBot: (id) => makeBot({ id }), getConfig: () => config, getChannel: () => undefined, logger: console })
  const touched = bridge.touchConversation({ channel: 'qq', botId: 'bot-session', scope: 'c2c', peerId: 'u1' })
  await bridge.bindSession(touched.key, sessionId)
  const result = await bridge.deliverInbound({
    channel: 'qq', botId: 'bot-session', scope: 'c2c', peerId: 'u1', senderName: '饲养员', text: '在吗',
    target: { scope: 'c2c', targetId: 'u1' }, meta: { messageId: 'manual-session-1' },
  })
  assert.equal(result.ok, true)
  assert.equal(result.record.sessionId, sessionId)
  assert.equal(ctx.__followups.at(-1).agentId, sessionId)
  rmSync(configMod.PATHS.sessions, { force: true })
})

test('称呼：改完立刻刷新 QQ 私聊标签，群聊与微信不动', async () => {
  const config = freshConfig()
  const ctx = createFakeCtx()
  const bridge = new SessionBridge(ctx, { getBot: (id) => makeBot({ id }), getConfig: () => config, getChannel: () => undefined, logger: console })
  const c2c = bridge.touchConversation({ channel: 'qq', botId: 'bot-owner', scope: 'c2c', peerId: 'u1', senderName: '主人' })
  const group = bridge.touchConversation({ channel: 'qq', botId: 'bot-owner', scope: 'group', peerId: 'g1', senderName: '群友' })
  const wx = bridge.touchConversation({ channel: 'webhook', botId: 'bot-owner', scope: 'c2c', peerId: 'p1', senderName: '微信昵称' })
  assert.equal(c2c.senderName, '主人')
  // QQ 私聊正好只有一条；群聊用真实发言人昵称，微信的 senderName 来自桥接侧，都不该被覆盖。
  assert.equal(bridge.relabelOwnerName('bot-owner', '小明'), 1)
  assert.equal(bridge.recordForConversation({ channel: 'qq', botId: 'bot-owner', scope: 'c2c', peerId: 'u1' }).senderName, '小明')
  assert.match(bridge.recordForConversation({ channel: 'qq', botId: 'bot-owner', scope: 'c2c', peerId: 'u1' }).title, /小明/)
  assert.equal(bridge.recordForConversation({ channel: 'qq', botId: 'bot-owner', scope: 'group', peerId: 'g1' }).senderName, '群友')
  assert.equal(bridge.recordForConversation({ channel: 'webhook', botId: 'bot-owner', scope: 'c2c', peerId: 'p1' }).senderName, '微信昵称')
  // 别的机器人的聊天一行都不动。
  assert.equal(bridge.relabelOwnerName('bot-other', '小红'), 0)
  rmSync(configMod.PATHS.sessions, { force: true })
})

test('插件装配：注入、工具、API 路由都能装起来', async () => {
  const config = freshConfig()
  config.proactive.enabled = false
  configMod.saveConfig(config)
  const { apply } = await import('../index.js')
  const ctx = createFakeCtx()
  apply(ctx)
  assert.equal(ctx.__tools.has('memory_remember'), true)
  assert.equal(ctx.__tools.has('companion_send'), true)
  assert.equal(ctx.__tools.has('companion_voice'), true)
  assert.ok(ctx.__routes.some((route) => route.path === '/api/companion/state'))
  assert.ok(ctx.__contexts.some((context) => context.name === 'companion:persona'))
  assert.ok(ctx.__contexts.some((context) => context.name === 'companion:memory'))
  assert.ok(ctx.__contexts.some((context) => context.name === 'companion:mood'))
  for (const dispose of ctx.__disposers.splice(0)) {
    try { await dispose() } catch { /* ignore */ }
  }
})

