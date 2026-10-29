// 时间上下文：自主开口时注入的时钟信息。
//
// 这些断言都是在钉住「模型能看到的字面」：时间字段少了/格式漂了，就会退回时间幻觉。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'companion-time-context-'))

const {
  PROMPT_MARKER, agoText, clockText, dayPart, dayPartText, humanDuration,
  nowLines, proactiveBody, proactivePromptOf, spokenTextOf, stripCompanionContext, utcOffsetText, zoneText,
} = await import('../lib/time-context.js')
const { activationText } = await import('../lib/schedule.js')

/** 一个固定的本地时刻：2026-10-29 17:52:31（周四）。 */
const AT = new Date(2026, 9, 29, 17, 52, 31).getTime()

test('时钟：日期 + 星期 + 时分秒，用的是本地时间', () => {
  assert.equal(clockText(AT), '2026-10-29 周四 17:52:31')
  assert.match(clockText(), /^\d{4}-\d{2}-\d{2} 周[一二三四五六日] \d{2}:\d{2}:\d{2}$/)
  assert.match(utcOffsetText(AT), /^UTC[+-]\d{2}:\d{2}$/)
  assert.match(zoneText(AT), /UTC[+-]\d{2}:\d{2}$/)
  // 入站与主动搭话共用这两行，格式只有一处定义。
  assert.deepEqual(nowLines(AT), [`now: 2026-10-29 周四 17:52:31（${zoneText(AT)}）`, 'part_of_day: 傍晚'])
})

test('时段：边界按小时分档，不依赖语言环境', () => {
  assert.equal(dayPart(0), '凌晨')
  assert.equal(dayPart(4), '凌晨')
  assert.equal(dayPart(5), '早上')
  assert.equal(dayPart(9), '上午')
  assert.equal(dayPart(12), '中午')
  assert.equal(dayPart(15), '下午')
  assert.equal(dayPart(18), '傍晚')
  assert.equal(dayPart(21), '晚上')
  assert.equal(dayPart(23), '深夜')
  assert.equal(dayPartText(AT), '傍晚')
})

test('时长：只保留两级，够读到判断「隔了多久」就行', () => {
  assert.equal(humanDuration(30_000), '不到 1 分钟')
  assert.equal(humanDuration(43 * 60_000), '43 分钟')
  assert.equal(humanDuration(65 * 60_000), '1 小时 5 分钟')
  assert.equal(humanDuration(3 * 3_600_000), '3 小时')
  assert.equal(humanDuration(26 * 3_600_000), '1 天 2 小时')
  assert.equal(humanDuration(-1000), '不到 1 分钟')
  assert.equal(agoText(AT - 3 * 3_600_000, AT), '3 小时前')
  assert.equal(agoText(0, AT), '')
})

test('主动搭话正文：now 必须出现，由头单独成段', () => {
  const body = proactiveBody({
    record: { scope: 'c2c', lastHumanAt: AT - 3 * 3_600_000, proactive: { lastSpokeAt: AT - 10 * 60_000 } },
    promptText: '在想你',
    now: AT,
  })
  assert.match(body, /<companion_context>/)
  assert.match(body, /kind: proactive/)
  // 关键：绝对时刻要带着星期一起给，模型才不用自己推算。
  assert.match(body, new RegExp(`now: 2026-10-29 周四 17:52:31`))
  assert.match(body, /part_of_day: 傍晚/)
  assert.match(body, /last_human: 2026-10-29 周四 14:52:31（3 小时前，对方最后一条消息）/)
  assert.match(body, /last_proactive: .*我上次在这里主动开口/)
  assert.match(body, /不要自己推算/)
  // 由头在最后，且能原样取回（回合收尾靠这一步把背景块摘掉）。
  assert.ok(body.endsWith(`${PROMPT_MARKER}\n在想你`))
  assert.equal(proactivePromptOf(body), '在想你')
})

test('主动搭话正文：群聊说「群里」；没有历史时间就不编', () => {
  const group = proactiveBody({ record: { scope: 'group', lastHumanAt: 0 }, promptText: '冒个泡', now: AT })
  assert.match(group, /last_human: 群里还没在这个聊天里说过话/)
  assert.match(group, /想在群里开口/)
  assert.equal(group.includes('last_proactive:'), false)
  assert.equal(proactivePromptOf(group), '冒个泡')
})

test('由头还原：没有标记时原样返回，不会把正文吞成空串', () => {
  assert.equal(proactivePromptOf('老格式的一句话'), '老格式的一句话')
  assert.equal(proactivePromptOf(''), '')
})

test('会话桥：deliverProactive 注入的时间戳就是调用这一刻', async () => {
  const configMod = await import('../lib/config.js')
  const { SessionBridge } = await import('../lib/session-bridge.js')
  const { createFakeCtx, makeBot } = await import('./fake-ctx.mjs')
  const ctx = createFakeCtx()
  const bot = makeBot({ id: 'bot-clock' })
  const bridge = new SessionBridge(ctx, {
    getConfig: () => configMod.loadConfig(), getChannel: () => undefined, getBot: () => bot, logger: console,
  })
  const record = bridge.touchConversation({ channel: 'qq', botId: bot.id, scope: 'c2c', peerId: 'u1' })
  record.lastHumanAt = AT - 5 * 60_000

  const messages = []
  const agent = { session: { id: 's-clock' }, followup: async (message) => { messages.push(message) } }
  await bridge.deliverProactive(record, agent, '在想你', { now: AT })

  const text = messages[0].content[0].text
  assert.equal(messages[0].source.kind, 'companion-proactive')
  assert.match(text, /now: 2026-10-29 周四 17:52:31/)
  assert.match(text, /last_human: .*（5 分钟前，对方最后一条消息）/)
  assert.equal(proactivePromptOf(text), '在想你')

  // 第二次开口：这次应该带上「上次开口是多久前」。
  await bridge.deliverProactive(record, agent, '在想你', { now: AT + 10 * 60_000 })
  assert.match(messages[1].content[0].text, /last_proactive: .*我上次在这里主动开口/)
  rmSync(configMod.PATHS.sessions, { force: true })
})

test('定时激活正文：除了提交时间，还要给「现在」', () => {
  const created = AT - 43 * 60_000
  const text = activationText({ id: 'sch_x', createdAt: created, text: '提醒喝水' }, AT)
  assert.match(text, /提交，等了 43 分钟/)
  assert.match(text, /现在是 2026-10-29 周四 17:52:31/)
  assert.match(text, /自己之前给自己定的任务/)
  assert.ok(text.endsWith('提醒喝水'))
})

test('去块：只删来源块，正文与场景行都留着', () => {
  const body = '<companion_context>\nnow: x\n</companion_context>\n（私聊）\n在吗'
  assert.equal(stripCompanionContext(body), '（私聊）\n在吗')
  assert.equal(stripCompanionContext('没有块的消息'), '没有块的消息')
  // 闲聊正文里恰好出现尖括号也不该被吃掉。
  assert.equal(stripCompanionContext('（私聊）\n今天 <3 你'), '（私聊）\n今天 <3 你')
})

test('真正的正文：入站去块，主动搭话只要由头', () => {
  assert.equal(spokenTextOf('<companion_context>\nnow: x\n</companion_context>\n（私聊）\n在吗'), '（私聊）\n在吗')
  const proactive = proactiveBody({ record: { scope: 'c2c', lastHumanAt: 0 }, promptText: '在想你', now: AT })
  assert.equal(spokenTextOf(proactive), '在想你')
  assert.equal(spokenTextOf('就一句普通的话'), '就一句普通的话')
})

async function inboundText({ contextEnhancement, text = '在吗' } = {}) {
  const configMod = await import('../lib/config.js')
  const { SessionBridge } = await import('../lib/session-bridge.js')
  const { createFakeCtx, makeBot } = await import('./fake-ctx.mjs')
  const ctx = createFakeCtx()
  const bot = makeBot({ id: 'bot-in', contextEnhancement })
  const bridge = new SessionBridge(ctx, {
    getConfig: () => configMod.loadConfig(), getChannel: () => undefined, getBot: () => bot, logger: console,
  })
  const result = await bridge.deliverInbound({
    channel: 'qq', botId: bot.id, scope: 'c2c', peerId: 'u1', senderName: '小明', text, meta: { messageId: 'tc-' + Math.random() },
  })
  rmSync(configMod.PATHS.sessions, { force: true })
  return { result, text: ctx.__followups.at(-1)?.message.content[0].text ?? '' }
}

test('入站：上下文增强关着（默认）也带时间', async () => {
  const { result, text } = await inboundText({ contextEnhancement: { enabled: false } })
  assert.equal(result.ok, true)
  assert.match(text, /<companion_context>/)
  assert.match(text, /now: \d{4}-\d{2}-\d{2} 周[一二三四五六日] \d{2}:\d{2}:\d{2}/)
  assert.match(text, /part_of_day: /)
  // 增强关着时不该有来源字段，也不该把整段笔记塞进来。
  assert.equal(text.includes('channel:'), false)
  assert.equal(text.includes('sender:'), false)
  assert.match(text, /（私聊）\n在吗$/)
  assert.equal(stripCompanionContext(text), '（私聊）\n在吗')
})

test('入站：增强开着时来源字段与时间同时都在', async () => {
  const { text } = await inboundText({
    contextEnhancement: { enabled: true, includeSender: true, includeChat: true, guidance: '群里只回答被 @ 的问题' },
  })
  assert.match(text, /now: /)
  assert.match(text, /channel: qq/)
  assert.match(text, /scope: c2c/)
  assert.match(text, /sender: 小明/)
  assert.match(text, /chat: u1/)
  assert.match(text, /guidance: 群里只回答被 @ 的问题/)
})

test.after(() => rmSync(process.env.DSH_HOME, { recursive: true, force: true }))
