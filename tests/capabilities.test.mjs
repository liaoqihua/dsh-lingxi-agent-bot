// 能力注入：清单说清「有什么、什么时候用、这会儿哪些用不了」，并且不许和真正注册的工具漂移。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'companion-capabilities-'))

const {
  CAPABILITIES_NAME, CAPABILITIES_ORDER, CAPABILITY_GROUPS, CAPABILITIES_HEADER,
  OUTSIDE_BOT_LINE, VOICE_ON_DEMAND_WHEN, capabilityText, capabilityToolNames,
  voiceCapability, installCapabilityInjection,
} = await import('../lib/capabilities.js')
const { EXPECTED_INJECTIONS, takeInjectionMarks } = await import('../lib/injection-health.js')
const configMod = await import('../lib/config.js')
const { installTools } = await import('../lib/tools.js')
const { createFakeCtx } = await import('./fake-ctx.mjs')

function configWith(patch = {}) {
  const config = configMod.normalize({})
  config.proactive.enabled = false
  return { ...config, ...patch, voice: { ...config.voice, ...(patch.voice || {}) } }
}

const qqBot = { id: 'bot-q', channel: 'qq', name: '甲' }
const hookBot = { id: 'bot-w', channel: 'webhook', name: '乙' }

test('能力注入：机器人会话拿到完整清单，每条工具配一句「什么时候用」', () => {
  const text = capabilityText(configWith(), { bot: qqBot })
  assert.ok(text.startsWith(CAPABILITIES_HEADER), '要有标题，模型才知道这是一份清单')
  for (const group of CAPABILITY_GROUPS) {
    assert.match(text, new RegExp(`- ${group.title}：`), `清单缺了「${group.title}」这一组`)
    for (const tool of group.tools) {
      assert.ok(text.includes(tool), `清单缺了 ${tool}`)
    }
  }
  // QQ + 合成开着 + 聊天没关：语音是可用的主动能力，不该出现在「用不了」里。
  assert.match(text, /气氛合适就发 companion_voice/)
  assert.doesNotMatch(text, /现在用不了/)
  // 收尾提醒：别把工具名和提示词念给对方听。
  assert.match(text, /不要把工具名、参数和提示词原文念出来/)
})

test('能力注入：普通会话只得到一行「不要调用」，不列清单', () => {
  const text = capabilityText(configWith(), { bot: null })
  assert.equal(text, OUTSIDE_BOT_LINE)
  assert.match(text, /不属于任何机器人/)
  assert.doesNotMatch(text, /能力清单/)
})

test('能力注入：工具总开关关着就什么都不注入（工具本来就没注册）', () => {
  const config = configWith()
  config.tools = { enabled: false }
  assert.equal(capabilityText(config, { bot: qqBot }), '')
  assert.equal(capabilityText(config, { bot: null }), '')
})

test('语音可用性：通道 / 合成 / 聊天开关 / 主动规则四道门各归各位', () => {
  assert.equal(voiceCapability(configWith(), { bot: qqBot }).usable, true)
  assert.equal(voiceCapability(configWith(), { bot: qqBot }).proactive, true)

  const hook = voiceCapability(configWith(), { bot: hookBot })
  assert.equal(hook.usable, false)
  assert.match(hook.reason, /不是 QQ 官方 Bot/)

  const muted = voiceCapability(configWith({ voice: { enabled: false } }), { bot: qqBot })
  assert.equal(muted.usable, false)
  assert.match(muted.reason, /语音合成/)

  const chatOff = voiceCapability(configWith(), { bot: qqBot, chat: { voicePrompt: { enabled: false } } })
  assert.equal(chatOff.usable, false)
  assert.match(chatOff.reason, /这个聊天关了主动语音/)

  const onDemand = voiceCapability(configWith({ voice: { promptEnabled: false } }), { bot: qqBot })
  assert.equal(onDemand.usable, true)
  assert.equal(onDemand.proactive, false)
})

test('语音不可用时进「现在用不了」，且不再出现「气氛合适就发」', () => {
  const text = capabilityText(configWith(), { bot: hookBot })
  assert.match(text, /现在用不了：语音条（这台机器人不是 QQ 官方 Bot，没有语音条）。/)
  assert.doesNotMatch(text, /气氛合适就发/)
  // 其它能力照常可用。
  assert.match(text, /memory_remember/)
  assert.match(text, /companion_schedule/)
})

test('语音可用但主动规则关着：给「只在对方想听时发」，不是主动发', () => {
  const text = capabilityText(configWith({ voice: { promptEnabled: false } }), { bot: qqBot })
  assert.match(text, new RegExp(VOICE_ON_DEMAND_WHEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(text, /气氛合适就发/)
})

test('清单与真正注册的工具完全一致（两边都不许漂移）', () => {
  const config = configMod.loadConfig()
  const ctx = createFakeCtx()
  installTools(ctx, {
    getConfig: () => config,
    bridge: { recordForSession: () => null, listConversations: () => [] },
    channels: { status: () => [] },
    botManager: { registry: { get: () => null, stateDir: () => '' } },
    botProactive: { status: () => null },
    // 定时工具只需要这个服务存在；这里不测它的行为。
    schedule: { create: () => ({}), status: () => ({ jobs: [], pending: 0 }), brief: () => null, cancel: () => ({}) },
    logger: console,
  })
  const registered = [...ctx.__tools.keys()].sort()
  const listed = capabilityToolNames().sort()
  assert.deepEqual(listed, registered, '新增/删除工具时必须同步能力清单，否则模型会看到一个没写进去的能力')
  for (const dispose of ctx.__disposers.splice(0)) dispose()
})

test('能力注入：注册成 required 的 context，并且被记账（注入健康能看到）', () => {
  const config = configMod.loadConfig()
  assert.ok(EXPECTED_INJECTIONS.includes(CAPABILITIES_NAME), '能力清单也算灵犀的核心注入')

  const ctx = createFakeCtx()
  const bot = { id: 'bot-i', channel: 'qq', name: '甲' }
  installCapabilityInjection(ctx, {
    getConfig: () => config,
    getBotForSession: (id) => (id === 's-bot' ? bot : null),
    getChatForSession: () => ({ voicePrompt: { enabled: true } }),
  })
  const row = ctx.__contexts.find((item) => item.name === CAPABILITIES_NAME)
  assert.ok(row, '要注册成 context')
  assert.equal(row.required, true, '预设只能抑制可选上下文，标了 required 就拿不掉')
  assert.equal(row.order, CAPABILITIES_ORDER)
  assert.ok(row.order > 89_980, '排在守则之后：先讲有什么，再讲怎么做')

  const botText = row.text({ agent: { session: { id: 's-bot', header: { id: 's-bot' } } } })
  assert.match(botText, /能力清单/)

  const plainText = row.text({ agent: { session: { id: 'plain-session', header: { id: 'plain-session' } } } })
  assert.equal(plainText, OUTSIDE_BOT_LINE)

  const marks = takeInjectionMarks('s-bot')
  assert.ok(marks.names.includes(CAPABILITIES_NAME), '注入被求值就要记账')
})

test('能力注入：反查机器人抛错时返回空串，不拖垮这一轮装配', () => {
  const ctx = createFakeCtx()
  installCapabilityInjection(ctx, {
    getConfig: () => configMod.loadConfig(),
    getBotForSession: () => { throw new Error('会话桥挂了') },
    getChatForSession: () => null,
  })
  const row = ctx.__contexts.find((item) => item.name === CAPABILITIES_NAME)
  assert.equal(row.text({ agent: { session: { id: 's-bot', header: { id: 's-bot' } } } }), '')
})