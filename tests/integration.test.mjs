// 端到端（不连真 QQ）：Webhook 上报 → 会话 followup → DSH 回合结束 → Webhook 出站。
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'companion-e2e-'))

const { createFakeCtx } = await import('./fake-ctx.mjs')

function makeRequest(body, url = '/api/companion/channels/webhook/inbound') {
  const raw = JSON.stringify(body)
  return {
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', 'x-companion-secret': 'e2e-secret' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(raw, 'utf8') },
  }
}

function makeResponse() {
  return {
    status: 0,
    body: '',
    writeHead(code) { this.status = code },
    end(value) { this.body = String(value ?? '') },
  }
}

/** 通道在 botManager.startAll() 里异步注册路由，等它一下。 */
async function waitForRoute(ctx, path, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const route = ctx.__routes.find((item) => item.path === path)
    if (route) return route
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return null
}

test('端到端：定时激活到点 → followup → 回合结束 → 回复回到聊天', async () => {
  const received = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      received.push({ url: req.url, body: JSON.parse(raw || '{}') })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, messageId: '9101' }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const configMod = await import('../lib/config.js')
  const { loadStore } = await import('../lib/schedule.js')
  const config = configMod.loadConfig()
  config.channels.webhook.enabled = true
  config.channels.webhook.outboundUrl = `http://127.0.0.1:${port}/send`
  config.channels.webhook.secret = 'e2e-secret'
  config.proactive.enabled = false
  // 每轮都该提炼记忆：这样「定时激活那一轮跳过」才是可观测的。
  config.memory.extractEveryTurns = 1
  configMod.saveConfig(config)

  const { apply } = await import('../index.js')
  const { BotRegistry } = await import('../lib/bots.js')
  const registry = new BotRegistry({ root: configMod.PATHS.root })
  const bot = registry.add({
    channel: 'webhook',
    name: '定时机器人',
    credentials: { outboundUrl: config.channels.webhook.outboundUrl, secret: 'e2e-secret' },
    sessionDefaults: {
      c2c: { workspace: process.cwd(), defaultPermission: 'workspace-write' },
      group: { workspace: process.cwd(), defaultPermission: 'read-only' },
    },
  })
  // 记忆提炼与心情判断都会走 ctx.llm.stream：数它就知道收尾有没有跑。
  let llmCalls = 0
  const streams = []
  const ctx = createFakeCtx({
    onStream: function* (request) {
      llmCalls += 1
      streams.push(request)
      yield { type: 'text-delta', text: '{}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  apply(ctx)
  const jsonRequest = (body) => ({
    method: 'POST',
    url: '/api/companion/schedule',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
  })
  try {
    assert.ok(ctx.__tools.get('companion_schedule'), '定时工具应该注册到宿主')
    const inboundUrl = `/api/companion/bots/${bot.id}/webhook/inbound`
    const inbound = await waitForRoute(ctx, inboundUrl)
    assert.ok(inbound, '机器人 Webhook 入站路由应该注册')
    const res = makeResponse()
    await inbound.handler(makeRequest({ conversation: 'wxid_9', senderName: '主人', text: '在吗', messageId: 'e2e-sched-1' }, inboundUrl), res)
    assert.equal(res.status, 200)

    let agent = null
    for (let i = 0; i < 50 && !agent; i++) {
      agent = [...ctx.__agents.values()][0] ?? null
      if (!agent) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(agent, '入站应该拉起会话')
    // 假会话不会自己把 followup 落成事件：拿真正注入的那条正文补上这一轮，
    // 收尾钩子才有输入（也才真的验到「来源块不进记忆」这条线）。
    const injected = ctx.__followups.at(-1)?.message?.content
    assert.ok(injected, '入站应该把消息 followup 进会话')
    agent.session.append('user/message', {
      source: { kind: 'companion-im', channel: 'webhook' },
      content: injected,
    })
    ctx.emit('session/event', agent.session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '在的。' }] } },
    })
    ctx.emit('session/event', agent.session, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const baselineCalls = llmCalls
    assert.ok(baselineCalls > 0, '普通回合应该跑过记忆/心情收尾')
    // 注入的来源块是我们自己写的背景，不能当成「对方说的话」进提炼与心情判断。
    const prompts = streams.slice(0, baselineCalls).map((row) => JSON.stringify(row))
    assert.ok(prompts.some((row) => row.includes('这一轮对方说的话')), '这一轮应该跑过记忆提炼')
    assert.equal(prompts.some((row) => row.includes('companion_context')), false, '收尾不该把来源块当成对方说的话')
    received.length = 0

    const scheduleRoute = ctx.__routes.find((item) => item.path === '/api/companion/schedule')
    assert.ok(scheduleRoute, '定时接口应该注册')
    const createRes = makeResponse()
    await scheduleRoute.handler(jsonRequest({
      action: 'create', botId: bot.id, conversation: `${bot.id}:webhook:c2c:wxid_9`,
      text: '提醒主人喝水', waitMinutes: 1,
    }), createRes)
    assert.equal(createRes.status, 200)
    const created = JSON.parse(createRes.body).jobs[0]
    assert.equal(created.text, '提醒主人喝水')
    assert.equal(created.waitMinutes, 1)
    assert.ok(created.submittedAt, '记录里要有提交时间')

    // 不真等一分钟：直接走「立即激活」，与 ticker 到点后走的是同一条 activate。
    const fireRes = makeResponse()
    await scheduleRoute.handler(jsonRequest({ action: 'fire', botId: bot.id, id: created.id }), fireRes)
    const fired = JSON.parse(fireRes.body)
    assert.equal(fired.result.ok, true)
    assert.equal(fired.jobs[0].status, 'done')

    const activation = ctx.__followups.find((row) => row.message?.source?.kind === 'companion-schedule')
    assert.ok(activation, '到点应该 followup 一条带来源标记的消息')
    assert.match(activation.message.content[0].text, /提醒主人喝水/)
    assert.match(activation.message.content[0].text, /等了 \d+ 分钟/)
    assert.equal(loadStore(bot.id).jobs[0].status, 'done')

    // 这一轮结束：正文照常回聊天，但记忆/心情收尾要跳过。
    agent.session.append('user/message', {
      source: { kind: 'companion-schedule', conversation: `${bot.id}:webhook:c2c:wxid_9`, jobId: created.id },
      content: [{ type: 'text', text: activation.message.content[0].text }],
    })
    ctx.emit('session/event', agent.session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '喝水啦。' }] } },
    })
    ctx.emit('session/event', agent.session, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
    for (let i = 0; i < 40 && received.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(received.length, 1, '定时激活的回复应该回到原聊天')
    assert.match(received[0].body.text, /喝水啦/)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(llmCalls, baselineCalls, '定时激活的回合不该触发记忆提炼/心情判断')
  } finally {
    for (const dispose of ctx.__disposers.splice(0)) {
      try { await dispose() } catch { /* ignore */ }
    }
    try { server.closeAllConnections?.() } catch { /* ignore */ }
    await new Promise((resolve) => server.close(resolve))
    rmSync(configMod.PATHS.sessions, { force: true })
  }
})

test('端到端：Webhook 上报进、回复出', async () => {
  const received = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      received.push({ url: req.url, body: JSON.parse(raw || '{}') })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, messageId: '9001' }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const configMod = await import('../lib/config.js')
  const config = configMod.loadConfig()
  config.channels.feishu.enabled = false
  config.channels.webhook.enabled = true
  config.channels.webhook.outboundUrl = `http://127.0.0.1:${port}/send`
  config.channels.webhook.secret = 'e2e-secret'
  config.proactive.enabled = false
  configMod.saveConfig(config)

  const { apply } = await import('../index.js')
  const { BotRegistry } = await import('../lib/bots.js')
  const registry = new BotRegistry({ root: configMod.PATHS.root })
  const bot = registry.add({
    channel: 'webhook',
    name: '端到端微信机器人',
    credentials: { outboundUrl: config.channels.webhook.outboundUrl, secret: 'e2e-secret' },
    sessionDefaults: {
      c2c: { workspace: process.cwd(), defaultPermission: 'workspace-write' },
      group: { workspace: process.cwd(), defaultPermission: 'read-only' },
    },
  })
  const ctx = createFakeCtx()
  apply(ctx)
  try {
    const route = await waitForRoute(ctx, `/api/companion/bots/${bot.id}/webhook/inbound`)
    assert.ok(route, '机器人 Webhook 入站路由应该注册')
    const res = makeResponse()
    await route.handler(makeRequest({
      conversation: 'wxid_1',
      senderName: '饲养员',
      text: '在吗',
      messageId: 'e2e-1',
    }, `/api/companion/bots/${bot.id}/webhook/inbound`), res)
    assert.equal(res.status, 200)

    // 等 followup 落到假会话
    let agent = null
    for (let i = 0; i < 50 && (ctx.__followups.length === 0 || !agent); i++) {
      agent = [...ctx.__agents.values()][0] ?? null
      if (!agent || ctx.__followups.length === 0) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(agent, '应该创建了一个聊天绑定的会话')
    assert.equal(ctx.__followups.length, 1)
    assert.equal(ctx.__followups[0].message.source.kind, 'companion-im')

    // 会话标题写入后，状态接口要能把它读出来（标题在日志投影里，不在 header 上）。
    // 宿主会话目录在 /sessions（按需 + 缓存），不在 /state。
    const sessionsRoute = ctx.__routes.find((item) => item.path === '/api/companion/sessions')
    assert.ok(sessionsRoute, '会话目录路由应该注册')
    const sessionsRes = makeResponse()
    await sessionsRoute.handler({ method: 'GET', url: `/api/companion/sessions?botId=${encodeURIComponent(bot.id)}`, headers: {} }, sessionsRes)
    assert.equal(sessionsRes.status, 200)
    const sessionsBody = JSON.parse(sessionsRes.body)
    const sessionRow = sessionsBody.sessions.find((row) => row.id === agent.session.id)
    assert.ok(sessionRow, '绑定的会话应该在候选里')
    assert.match(sessionRow.title, /^伴侣·端到端微信机器人-\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    assert.equal(sessionRow.boundKey, `${bot.id}:webhook:c2c:wxid_1`)

    // 模拟 DSH 跑完一轮
    ctx.emit('session/event', agent.session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '在的，刚想找你。' }] } },
    })
    ctx.emit('session/event', agent.session, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
    for (let i = 0; i < 30 && received.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(received.length, 1, '应该向 Webhook 桥发出回复')
    assert.equal(received[0].url, '/send')
    assert.equal(received[0].body.conversation, 'wxid_1')
    assert.match(received[0].body.text, /刚想找你/)
  } finally {
    for (const dispose of ctx.__disposers.splice(0)) {
      try { await dispose() } catch { /* ignore */ }
    }
    try { server.closeAllConnections?.() } catch { /* ignore */ }
    await new Promise((resolve) => server.close(resolve))
    rmSync(configMod.PATHS.sessions, { force: true })
  }
})
