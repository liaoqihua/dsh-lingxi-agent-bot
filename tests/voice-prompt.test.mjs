// 语音注入：主动发语音靠的是提示词注入，不是工具说明。
//
// 覆盖三件事：
//   1. 纯函数 voicePromptText 的门槛（通道 / 合成开关 / 主动开关 / 自定义 / 节奏）；
//   2. 注册形状（context + required，和人格/记忆/心情同一条约定）；
//   3. 记账：发过一条语音之后，下几轮要能压住「先用文字」。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'companion-voice-prompt-'))

const configMod = await import('../lib/config.js')
const promptMod = await import('../lib/voice-prompt.js')
const { createFakeCtx } = await import('./fake-ctx.mjs')

function baseConfig(voice = {}) {
  return { voice: { enabled: true, promptEnabled: true, prompt: '', ...voice } }
}

test('语音注入：默认规则讲清了「主动发」而不是「想发才发」', () => {
  assert.match(promptMod.DEFAULT_VOICE_PROMPT, /主动用声音说话/)
  assert.match(promptMod.DEFAULT_VOICE_PROMPT, /companion_voice/)
  // 节制与形式这两条必须写进默认文本，否则模型会把每条回复都念出来。
  assert.match(promptMod.DEFAULT_VOICE_PROMPT, /别连着两条都发语音/)
  assert.match(promptMod.DEFAULT_VOICE_PROMPT, /10~60 字/)
})

test('语音注入：只有 QQ + 合成开着 + 主动开关开着才注入', () => {
  assert.equal(promptMod.voicePromptText(baseConfig(), { channel: 'webhook' }), '')
  assert.equal(promptMod.voicePromptText(baseConfig(), { channel: 'feishu' }), '')
  assert.equal(promptMod.voicePromptText(baseConfig(), { channel: '' }), '')

  const qq = promptMod.voicePromptText(baseConfig(), { channel: 'qq' })
  assert.equal(qq, promptMod.DEFAULT_VOICE_PROMPT)

  // 合成关着：给一句「别调」，别让模型反复撞报错。
  const disabled = promptMod.voicePromptText(baseConfig({ enabled: false }), { channel: 'qq' })
  assert.equal(disabled, promptMod.VOICE_DISABLED_LINE)
  assert.match(disabled, /不要调用 companion_voice/)

  // 主动开关关着：整段消失，回到「模型自己想用才用」。
  assert.equal(promptMod.voicePromptText(baseConfig({ promptEnabled: false }), { channel: 'qq' }), '')

  // 会话管理里把这个聊天关了：同样整段消失（总闸开着也不注入）。
  assert.equal(promptMod.voicePromptText(baseConfig(), { channel: 'qq', chatEnabled: false }), '')
  assert.equal(promptMod.voicePromptText(baseConfig({ promptEnabled: false }), { channel: 'qq', chatEnabled: false }), '')
})

test('语音注入：自定义提示词整段替换默认规则，空白不算自定义', () => {
  const custom = promptMod.voicePromptText(baseConfig({ prompt: '只在道晚安的时候用声音。' }), { channel: 'qq' })
  assert.equal(custom, '只在道晚安的时候用声音。')
  assert.equal(custom.includes(promptMod.DEFAULT_VOICE_PROMPT), false)

  assert.equal(
    promptMod.voicePromptText(baseConfig({ prompt: '   \n  ' }), { channel: 'qq' }),
    promptMod.DEFAULT_VOICE_PROMPT,
  )
})

test('语音注入：刚发过语音时补一句压制，过了间隔就不补', () => {
  const recent = promptMod.voicePromptText(baseConfig(), { channel: 'qq', minutesSinceLast: 3 })
  assert.ok(recent.startsWith(promptMod.DEFAULT_VOICE_PROMPT))
  assert.match(recent, /上一条语音是 3 分钟前发的/)
  assert.match(recent, /这一轮先用文字/)

  assert.equal(
    promptMod.voicePromptText(baseConfig(), { channel: 'qq', minutesSinceLast: 45 }),
    promptMod.DEFAULT_VOICE_PROMPT,
  )
  assert.equal(
    promptMod.voicePromptText(baseConfig(), { channel: 'qq', minutesSinceLast: null }),
    promptMod.DEFAULT_VOICE_PROMPT,
  )
})

test('语音记账：noteVoiceSent 写盘，minutesSinceLastVoice 读得回来', () => {
  const dir = join(process.env.DSH_HOME, 'bots', 'bot-voice')
  mkdirSync(dir, { recursive: true })

  assert.equal(promptMod.minutesSinceLastVoice(dir), null, '还没发过应该是 null')

  promptMod.noteVoiceSent(dir, '晚安，做个好梦。', Date.now() - 5 * 60_000)
  const usage = promptMod.readVoiceUsage(dir)
  assert.equal(usage.count, 1)
  assert.equal(usage.lastText, '晚安，做个好梦。')
  assert.equal(promptMod.minutesSinceLastVoice(dir), 5)

  promptMod.noteVoiceSent(dir, '再念一句。')
  assert.equal(promptMod.readVoiceUsage(dir).count, 2)
  assert.equal(promptMod.minutesSinceLastVoice(dir), 0)

  // 拿不到目录时不炸，也不写垃圾。
  assert.equal(promptMod.noteVoiceSent('', 'x'), null)
})

test('语音注入：注册成 required 的 context，只对 QQ 机器人返回正文', () => {
  const ctx = createFakeCtx()
  const config = baseConfig()
  const bots = {
    'qq-session': { id: 'bot-qq', channel: 'qq' },
    'wx-session': { id: 'bot-wx', channel: 'webhook' },
  }
  const dirs = new Map()
  const dispose = promptMod.installVoiceInjection(ctx, () => config, {
    getBotForSession: (sessionId) => bots[sessionId] ?? null,
    stateDirFor: (bot) => {
      if (!dirs.has(bot.id)) {
        const dir = join(process.env.DSH_HOME, 'bots', bot.id)
        mkdirSync(dir, { recursive: true })
        dirs.set(bot.id, dir)
      }
      return dirs.get(bot.id)
    },
  })

  const row = ctx.__contexts.find((item) => item.name === promptMod.VOICE_PROMPT_NAME)
  assert.ok(row, 'companion:voice 应该注册成 context')
  assert.equal(row.required, true, '必须标 required：预设的抑制器只动可选上下文')
  assert.equal(row.order, promptMod.VOICE_PROMPT_ORDER)

  const assembly = (id) => ({ agent: { session: { id, header: { id } } } })
  assert.equal(row.text(assembly('qq-session')), promptMod.DEFAULT_VOICE_PROMPT)
  assert.equal(row.text(assembly('wx-session')), '', '微信/飞书没有 sendVoice，不该注入')
  assert.equal(row.text(assembly('ordinary-session')), '', '普通 DSH 会话不注入')

  // 发过一条之后，同一台机器人的下一轮要带压制句。
  promptMod.noteVoiceSent(dirs.get('bot-qq'), '晚安。')
  assert.match(row.text(assembly('qq-session')), /这一轮先用文字/)

  dispose()
  assert.equal(ctx.__contexts.some((item) => item.name === promptMod.VOICE_PROMPT_NAME), false)
})

// ---- 接线：走 apply() 的整条链路（机器人反查 / 状态目录 / 配置热更新） ----

function httpRequest(method, url, body) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url,
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw, 'utf8') },
  }
}

function httpResponse() {
  return {
    status: 0,
    body: '',
    writeHead(code) { this.status = code },
    end(value) { this.body = String(value ?? '') },
  }
}

async function callRoute(ctx, method, url, body) {
  const route = ctx.__routes.find((item) => item.path === url.split('?')[0])
  assert.ok(route, `路由 ${url} 应该注册`)
  const res = httpResponse()
  await route.handler(httpRequest(method, url, body), res)
  return { status: res.status, json: JSON.parse(res.body || '{}') }
}

test('语音注入：apply() 接线——QQ 机器人拿得到规则，改配置立刻生效', async () => {
  configMod.saveConfig(configMod.normalize({ proactive: { enabled: false } }))
  const { BotRegistry } = await import('../lib/bots.js')
  const registry = new BotRegistry({ root: configMod.PATHS.root })
  const bot = registry.add({
    id: 'bot-wire',
    channel: 'qq',
    name: '接线机',
    enabled: false,
    credentials: {},
    sessionDefaults: {
      c2c: { workspace: process.cwd(), defaultPermission: 'workspace-write' },
      group: { workspace: process.cwd(), defaultPermission: 'read-only' },
    },
  })
  // 聊天的会话绑定：SessionBridge 起来时按这份记录反查 botId。
  writeFileSync(configMod.PATHS.sessions, JSON.stringify({
    version: 1,
    records: {
      [`${bot.id}:qq:c2c:u1`]: {
        key: `${bot.id}:qq:c2c:u1`,
        channel: 'qq',
        botId: bot.id,
        scope: 'c2c',
        peerId: 'u1',
        title: 'QQ 主人',
        senderName: '主人',
        sessionId: 'sess-wire',
        target: { scope: 'c2c', targetId: 'u1' },
        proactive: { enabled: false, cooldownMinutes: 0, lastSpokeAt: 0 },
      },
    },
  }), 'utf8')

  const { apply } = await import('../index.js')
  const ctx = createFakeCtx()
  apply(ctx)
  try {
    const row = ctx.__contexts.find((item) => item.name === promptMod.VOICE_PROMPT_NAME)
    assert.ok(row, 'apply() 应该注册 companion:voice')
    const assembly = { agent: { session: { id: 'sess-wire', header: { id: 'sess-wire' } } } }

    assert.equal(row.text(assembly), promptMod.DEFAULT_VOICE_PROMPT, 'QQ 机器人默认拿到内置规则')
    assert.equal(
      row.text({ agent: { session: { id: 'plain', header: { id: 'plain' } } } }),
      '',
      '普通 DSH 会话不注入',
    )

    // 关掉主动语音：cookie 立刻不再注入（设置页保存走的就是这条 API）。
    const off = await callRoute(ctx, 'POST', '/api/companion/config', { config: { voice: { promptEnabled: false } } })
    assert.equal(off.status, 200)
    assert.equal(row.text(assembly), '')

    // 打开 + 自定义：整段换成用户写的那份。
    const custom = '只在道晚安的时候用声音。'
    await callRoute(ctx, 'POST', '/api/companion/config', { config: { voice: { promptEnabled: true, prompt: custom } } })
    assert.equal(row.text(assembly), custom)

    // 会话管理里的那个勾：关掉这个聊天 → 总闸开着也不注入；再打开就回来。
    const chatKey = `${bot.id}:qq:c2c:u1`
    const chatOff = await callRoute(ctx, 'POST', '/api/companion/bots', {
      action: 'chat.update', botId: bot.id, key: chatKey, patch: { voicePromptEnabled: false },
    })
    assert.equal(chatOff.status, 200, chatOff.json && chatOff.json.error)
    assert.equal(chatOff.json.chat.voicePrompt.enabled, false)
    assert.equal(row.text(assembly), '', '这个聊天关掉主动语音后不该再注入')

    const chatOn = await callRoute(ctx, 'POST', '/api/companion/bots', {
      action: 'chat.update', botId: bot.id, key: chatKey, patch: { voicePromptEnabled: true },
    })
    assert.equal(chatOn.json.chat.voicePrompt.enabled, true)
    assert.equal(row.text(assembly), custom)

    // 发一条语音之后：记账落在机器人目录里，下一轮带「先用文字」。
    promptMod.noteVoiceSent(registry.stateDir(bot.id), '晚安，做个好梦。')
    const afterVoice = row.text(assembly)
    assert.ok(afterVoice.startsWith(custom))
    assert.match(afterVoice, /这一轮先用文字/)
  } finally {
    for (const dispose of ctx.__disposers.splice(0)) {
      try { await dispose() } catch { /* ignore */ }
    }
  }
})