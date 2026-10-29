import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'companion-api-'))

const configMod = await import('../lib/config.js')
const { createFakeCtx } = await import('./fake-ctx.mjs')

function request(method, url, body) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw, 'utf8') },
  }
}

function response() {
  return {
    status: 0,
    body: '',
    writeHead(code) { this.status = code },
    end(value) { this.body = String(value ?? '') },
  }
}

async function call(ctx, method, url, body) {
  const path = url.split('?')[0]
  const route = ctx.__routes.find((item) => item.path === path)
  assert.ok(route, `route ${path} 应该注册`)
  const res = response()
  await route.handler(request(method, url, body), res)
  let json = null
  try { json = JSON.parse(res.body) } catch { /* ignore */ }
  return { status: res.status, json, raw: res.body }
}

test('语音 API：全局合成自检 + 按机器人取可发送的 QQ 聊天', async () => {
  // 先放一台 QQ 机器人和一台微信机器人，各带一条会话：只有 QQ 那条该出现在 targets 里。
  const root = join(process.env.DSH_HOME, 'dsh-lingxi-agent-bot')
  mkdirSync(root, { recursive: true })
  const scopeDefaults = { c2c: { workspace: process.cwd(), defaultPermission: 'workspace-write' }, group: { workspace: process.cwd(), defaultPermission: 'read-only' } }
  writeFileSync(join(root, 'bots.json'), JSON.stringify({
    version: 1,
    bots: [
      { id: 'qq-a', channel: 'qq', name: 'QQ 机器人', credentials: { appId: 'demo-app', appSecret: 's' }, sessionDefaults: scopeDefaults },
      { id: 'wx-a', channel: 'webhook', name: '微信机器人', credentials: {}, sessionDefaults: scopeDefaults },
    ],
  }, null, 2), 'utf8')
  writeFileSync(configMod.PATHS.sessions, JSON.stringify({
    version: 1,
    records: {
      'qq-a:qq:c2c:u1': {
        key: 'qq-a:qq:c2c:u1', channel: 'qq', botId: 'qq-a', scope: 'c2c', peerId: 'u1', title: 'QQ 主人',
        sessionId: 'voice-q-1', target: { scope: 'c2c', targetId: 'u1' },
        proactive: { enabled: true, cooldownMinutes: 0, lastSpokeAt: 0 },
        createdAt: 1, updatedAt: 1, lastHumanAt: 1, messageCount: 1,
      },
      'qq-a:qq:group:g1': {
        key: 'qq-a:qq:group:g1', channel: 'qq', botId: 'qq-a', scope: 'group', peerId: 'g1', title: 'QQ群 g1',
        sessionId: 'voice-q-2', target: {},
        proactive: { enabled: false, cooldownMinutes: 0, lastSpokeAt: 0 },
        createdAt: 1, updatedAt: 1, lastHumanAt: 1, messageCount: 1,
      },
      'wx-a:webhook:c2c:wx1': {
        key: 'wx-a:webhook:c2c:wx1', channel: 'webhook', botId: 'wx-a', scope: 'c2c', peerId: 'wx1', title: '微信 某人',
        sessionId: 'voice-w-1', target: { conversation: 'wx1' },
        proactive: { enabled: true, cooldownMinutes: 0, lastSpokeAt: 0 },
        createdAt: 1, updatedAt: 1, lastHumanAt: 1, messageCount: 1,
      },
    },
  }, null, 2), 'utf8')
  const config = configMod.loadConfig()
  config.voice.provider = 'auto'
  config.voice.endpoint = ''
  configMod.saveConfig(config)
  const { apply } = await import('../index.js')
  const ctx = createFakeCtx()
  apply(ctx)
  try {
    // 不带 botId：只有全局合成状态，不给「能发给谁」。
    const plain = await call(ctx, 'GET', '/api/companion/voice')
    assert.equal(plain.status, 200, plain.raw)
    assert.equal(plain.json.bot, null)
    assert.deepEqual(plain.json.targets, [])
    const voice = plain.json.voice
    assert.equal(voice.enabled, true)
    // provider=auto 且没填地址 → 实际会借宿主朗读路由。
    assert.equal(voice.effective, 'xiaomi')
    assert.equal(voice.provider, 'auto')
    assert.equal(voice.apiKeySet, false)
    assert.equal(voice.custom.configured, false)
    assert.equal(typeof voice.xiaomi.available, 'boolean')
    assert.equal(typeof voice.xiaomi.error, 'string')
    assert.equal(voice.temp.count >= 0, true)
    assert.equal(typeof voice.dir, 'string')
    assert.ok(voice.checkedAt > 0)
    // 主动语音（提示词注入）的状态也一起给出来：设置页靠它显示开关、默认/自定义与上次语音。
    assert.equal(voice.prompt.enabled, true)
    assert.equal(voice.prompt.custom, false)
    assert.equal(voice.prompt.pacingMinutes, 10)
    assert.equal(voice.prompt.lastSentAt, 0)
    assert.match(voice.prompt.defaultText, /主动用声音说话/)
    assert.ok(plain.json.qq, 'qq 通道状态也要给出来')

    // 带 botId：给这台机器人自己的 QQ 聊天 + 只有它有回复目标的才算 ready。
    const res = await call(ctx, 'GET', '/api/companion/voice?botId=qq-a')
    assert.equal(res.status, 200, res.raw)
    assert.equal(res.json.bot.id, 'qq-a')
    assert.equal(res.json.bot.channel, 'qq')
    assert.equal(res.json.targets.length, 2, res.raw)
    const ready = res.json.targets.filter((row) => row.ready)
    assert.equal(ready.length, 1, res.raw)
    assert.equal(ready[0].key, 'qq-a:qq:c2c:u1')
    assert.equal(ready[0].title, 'QQ 主人')
    assert.equal(res.json.targets.find((row) => row.scope === 'group').ready, false)

    // 微信机器人：没有语音条目标（它本来也没有 sendVoice）。
    const wx = await call(ctx, 'GET', '/api/companion/voice?botId=wx-a')
    assert.equal(wx.status, 200, wx.raw)
    assert.equal(wx.json.bot.channel, 'webhook')
    assert.deepEqual(wx.json.targets, [])
    const missing = await call(ctx, 'GET', '/api/companion/voice?botId=nope')
    assert.equal(missing.status, 404)

    // 整个插件卸载后，挂饰路由也要跟着撤（否则重载会叠一层旧实例的路由）。
    for (const dispose of ctx.__disposers.splice(0)) {
      try { await dispose() } catch { /* ignore */ }
    }
    assert.equal(ctx.__routes.some((row) => row.path === '/api/companion/widget.js'), false)
  } finally {
    for (const dispose of ctx.__disposers.splice(0)) {
      try { await dispose() } catch { /* ignore */ }
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('API：状态、保存设置、人格、日志', async () => {
  const config = configMod.loadConfig()
  config.proactive.enabled = false
  configMod.saveConfig(config)
  const { apply } = await import('../index.js')
  const ctx = createFakeCtx()
  apply(ctx)
  try {
    const state = await call(ctx, 'GET', '/api/companion/state?sessionId=s-test')
    assert.equal(state.status, 200)
    assert.equal(state.json.ok, true)
    assert.equal(state.json.identity.selfName, config.identity.selfName)
    assert.ok(Array.isArray(state.json.channels))
    assert.ok(state.json.configPath.endsWith('config.json'))

    const saved = await call(ctx, 'POST', '/api/companion/config', { config: { identity: { selfName: '测试鱼', ownerName: '测试员' } } })
    assert.equal(saved.status, 200, saved.raw)
    assert.equal(saved.json.identity.selfName, '测试鱼')
    const disk = JSON.parse(readFileSync(configMod.PATHS.config, 'utf8'))
    assert.equal(disk.identity.selfName, '测试鱼')

    const added = await call(ctx, 'POST', '/api/companion/bots', { action: 'add', channel: 'qq', name: '测试机器人' })
    assert.equal(added.status, 200, added.raw)
    assert.equal(added.json.bots.length, 1)
    assert.equal(added.json.bots[0].name, '测试机器人')
    assert.equal(added.json.bots[0].sessionDefaults.c2c.defaultPermission, 'workspace-write')
    assert.equal('workspace' in added.json.bots[0], false)
    const botId = added.json.bot.id

    // 新会话默认配置不完整时拒绝保存，并指出缺哪一项。
    const incomplete = await call(ctx, 'POST', '/api/companion/bots', {
      action: 'update', botId, patch: { sessionDefaults: { c2c: { workspace: 'D:\\bot-work' }, group: {} } },
    })
    assert.equal(incomplete.status, 400)
    assert.equal(incomplete.json.ok, false)
    assert.ok(incomplete.json.missing.includes('群聊：工作区'), incomplete.raw)

    const updated = await call(ctx, 'POST', '/api/companion/bots', {
      action: 'update',
      botId,
      patch: {
        sessionDefaults: {
          c2c: { workspace: 'D:\\bot-work', defaultPermission: 'workspace-write' },
          group: { workspace: 'D:\\bot-work-group', defaultPermission: 'read-only' },
        },
      },
    })
    assert.equal(updated.status, 200, updated.raw)
    assert.equal(updated.json.bots[0].sessionDefaults.c2c.workspace, 'D:\\bot-work')
    assert.equal(updated.json.bots[0].sessionDefaults.group.workspace, 'D:\\bot-work-group')

    // 会话模块：用一台 webhook 机器人走真实入站登记，再改名 / 开关主动搭话。
    const hookAdded = await call(ctx, 'POST', '/api/companion/bots', {
      action: 'add',
      channel: 'webhook',
      name: '会话测试机器人',
      sessionDefaults: {
        c2c: { workspace: process.cwd(), defaultPermission: 'workspace-write' },
        group: { workspace: process.cwd(), defaultPermission: 'read-only' },
      },
    })
    assert.equal(hookAdded.status, 200, hookAdded.raw)
    const hookBotId = hookAdded.json.bot.id
    const inboundPath = `/api/companion/bots/${hookBotId}/webhook/inbound`
    const inboundRoute = ctx.__routes.find((item) => item.path === inboundPath)
    assert.ok(inboundRoute, '机器人 webhook 入站路由应该注册')
    const inboundRes = response()
    await inboundRoute.handler(request('POST', inboundPath, { conversation: 'wxid_chat', senderName: '饲养员', text: '在吗', messageId: 'chat-1' }), inboundRes)
    assert.equal(inboundRes.status, 200)
    const chatKey = `${hookBotId}:webhook:c2c:wxid_chat`
    let chatRow = null
    for (let i = 0; i < 60 && !chatRow; i++) {
      const snapshot = await call(ctx, 'GET', '/api/companion/state')
      chatRow = snapshot.json.sessions.conversations.find((row) => row.key === chatKey) || null
      if (!chatRow) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(chatRow, '入站之后会话应该登记到 sessions.json')
    assert.equal(chatRow.proactive.enabled, true)
    assert.equal(chatRow.voicePrompt.enabled, true, '私聊默认开主动语音')

    const renamed = await call(ctx, 'POST', '/api/companion/bots', {
      action: 'chat.update', botId: hookBotId, key: chatKey, patch: { title: '老友', proactiveEnabled: false, proactiveCooldownMinutes: 45 },
    })
    assert.equal(renamed.status, 200, renamed.raw)
    assert.equal(renamed.json.chat.title, '老友')
    assert.equal(renamed.json.chat.proactive.enabled, false)
    // 冷却只属于机器人级「主动搭话」参数，会话记录里不该再有这个字段（旧参数直接忽略）。
    assert.equal(renamed.json.chat.proactive.cooldownMinutes, undefined)
    // 会话级主动语音开关：同一个 chat.update 接口，互不影响。
    const voiceOff = await call(ctx, 'POST', '/api/companion/bots', {
      action: 'chat.update', botId: hookBotId, key: chatKey, patch: { voicePromptEnabled: false },
    })
    assert.equal(voiceOff.status, 200, voiceOff.raw)
    assert.equal(voiceOff.json.chat.voicePrompt.enabled, false)
    assert.equal(voiceOff.json.chat.proactive.enabled, false, '改语音不该动主动搭话')
    const stateWithChat = await call(ctx, 'GET', '/api/companion/state')
    const updatedChat = stateWithChat.json.sessions.conversations.find((row) => row.key === chatKey)
    assert.equal(updatedChat.title, '老友')
    assert.equal(updatedChat.proactive.cooldownMinutes, undefined)
    assert.equal(updatedChat.voicePrompt.enabled, false, '状态接口要能读出会话级语音开关')
    const wrongBot = await call(ctx, 'POST', '/api/companion/bots', {
      action: 'chat.update', botId: 'other-bot', key: chatKey, patch: { title: 'x' },
    })
    assert.equal(wrongBot.status, 400)
    const missKey = await call(ctx, 'POST', '/api/companion/bots', { action: 'chat.update', botId: hookBotId, key: 'nope:webhook:c2c:x', patch: {} })
    assert.equal(missKey.status, 404)

    // 换绑会话：会话必须在这个 scope 的工作区里，且不能被两个聊天同时占用。
    await ctx.agents.create({ sessionId: 'api-existing-session', meta: { cwd: process.cwd() } })
    const bound = await call(ctx, 'POST', '/api/companion/bots', {
      action: 'bindSession', botId: hookBotId, chatKey, sessionId: 'api-existing-session',
    })
    assert.equal(bound.status, 200, bound.raw)
    assert.equal(bound.json.chat.sessionId, 'api-existing-session')
    await ctx.agents.create({ sessionId: 'api-other-workspace', meta: { cwd: 'D:\\somewhere-else' } })
    const rejected = await call(ctx, 'POST', '/api/companion/bots', {
      action: 'bindSession', botId: hookBotId, chatKey, sessionId: 'api-other-workspace',
    })
    assert.equal(rejected.status, 400)
    assert.match(rejected.json.error, /工作区|workspace/i)

    const hookRemoved = await call(ctx, 'POST', '/api/companion/bots', { action: 'remove', botId: hookBotId })
    assert.equal(hookRemoved.status, 200, hookRemoved.raw)
    assert.equal(hookRemoved.json.bots.length, 1)

    const personaGet = await call(ctx, 'POST', '/api/companion/bots', { action: 'getPersona', botId })
    assert.equal(personaGet.status, 200, personaGet.raw)
    const personaSet = await call(ctx, 'POST', '/api/companion/bots', { action: 'setPersona', botId, text: '# 机器人甲\n只属于甲。' })
    assert.equal(personaSet.status, 200, personaSet.raw)
    const personaRead = await call(ctx, 'POST', '/api/companion/bots', { action: 'getPersona', botId })
    assert.match(personaRead.json.text, /只属于甲/)
    const removed = await call(ctx, 'POST', '/api/companion/bots', { action: 'remove', botId })
    assert.equal(removed.status, 200, removed.raw)
    assert.equal(removed.json.bots.length, 0)

    const personaBot = await call(ctx, 'POST', '/api/companion/bots', { action: 'add', channel: 'qq', name: '人格测试机器人' })
    const personaBotId = personaBot.json.bot.id
    const persona = await call(ctx, 'POST', '/api/companion/persona', { botId: personaBotId, text: '# 测试人格\n你是测试鱼。' })
    assert.equal(persona.status, 200)
    assert.equal(persona.json.ok, true)
    const read = await call(ctx, 'GET', '/api/companion/persona?botId=' + encodeURIComponent(personaBotId))
    assert.match(read.json.text, /测试鱼/)
    const state2 = await call(ctx, 'GET', '/api/companion/state')
    const personaSummary = state2.json.personas.find((row) => row.botId === personaBotId)
    assert.match(personaSummary.effective.preview, /测试鱼/)
    await call(ctx, 'POST', '/api/companion/bots', { action: 'remove', botId: personaBotId })

    const diag = await call(ctx, 'GET', '/api/companion/diag?lines=20')
    assert.equal(diag.status, 200)
    assert.ok(Array.isArray(diag.json.lines))

    const missing = await call(ctx, 'GET', '/api/companion/memory')
    assert.equal(missing.status, 400)
  } finally {
    for (const dispose of ctx.__disposers.splice(0)) {
      try { await dispose() } catch { /* ignore */ }
    }
    rmSync(join(process.env.DSH_HOME, 'dsh-lingxi-agent-bot'), { recursive: true, force: true })
  }
})
