// 定时激活：存储投影、到点判定、激活链路、失败退避，以及工具/接口两个面。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'companion-schedule-'))

const {
  installSchedule, createJob, loadStore, saveStore, dueJobs, activeJobs,
  cancelJob, removeJob, setEnabled, jobRow, activationText,
  MAX_PENDING, MAX_JOBS, FAIL_LIMIT, MIN_WAIT_MINUTES, MAX_WAIT_MINUTES,
} = await import('../lib/schedule.js')
const { installTools } = await import('../lib/tools.js')
const { installApi } = await import('../lib/api.js')
const configMod = await import('../lib/config.js')
const { localTime } = await import('../lib/util.js')
const { createFakeCtx, makeAgent } = await import('./fake-ctx.mjs')

function conversation(overrides = {}) {
  return {
    key: 'bot-a:qq:c2c:u1',
    botId: 'bot-a',
    channel: 'qq',
    scope: 'c2c',
    peerId: 'u1',
    title: '甲的好友',
    sessionId: 'sid-a',
    live: true,
    ...overrides,
  }
}

/**
 * 假会话桥：只实现定时激活用到的接口，激活结果记在 activations 里。
 * `channel`：'ready' | 'connecting' | 'offline' | 'unconfigured' | null（通道还没起来），
 * 用来复现「重启后 ticker 比通道先跑」这一种时序。
 */
function makeBridge(rows, options = {}) {
  const state = {
    agentStatus: options.agentStatus ?? 'idle',
    ensureError: options.ensureError ?? null,
    channel: options.channel === undefined ? 'ready' : options.channel,
  }
  const activations = []
  const bridge = {
    state,
    activations,
    rows,
    listConversations: () => rows,
    async ensureAgent(record) {
      if (state.ensureError) throw state.ensureError
      return { status: state.agentStatus, session: { id: record.sessionId } }
    },
    async deliverActivation(record, agent, text, meta) {
      activations.push({ key: record.key, text, jobId: meta?.jobId })
    },
  }
  // withChannel:false 模拟老宿主/更简的装配（没有 channelFor 时按就绪处理）。
  if (options.withChannel !== false) {
    bridge.channelFor = () => {
      if (state.channel === null) return null
      return {
        status: () => ({
          configured: state.channel !== 'unconfigured',
          connected: state.channel === 'ready',
          connecting: state.channel === 'connecting',
        }),
      }
    }
  }
  return bridge
}

function engineFor(bridge, bots) {
  return installSchedule({ interval: () => () => {}, effect: () => () => {} }, {
    getConfig: () => ({ }),
    getBots: () => bots,
    bridge,
    logger: { info() {}, warn() {} },
  })
}

/** 把任务的到点时间挪到过去/未来，省得测试真等。 */
function moveDue(botId, id, offsetMs = -1_000) {
  const store = loadStore(botId)
  const job = store.jobs.find((row) => row.id === id)
  job.dueAt = Date.now() + offsetMs
  saveStore(store)
}

test('存储：提交时间、等待间隔、任务内容都落在记录里', () => {
  const botId = 'bot-store'
  const record = conversation({ botId })
  const engine = engineFor(makeBridge([record]), [{ id: botId }])
  const before = Date.now()
  const job = engine.create({ record, text: '  十分钟后提醒对方喝水  ', waitMinutes: 10 })
  assert.equal(job.text, '十分钟后提醒对方喝水')
  assert.equal(job.waitMinutes, 10)
  assert.equal(job.repeatMinutes, 0)
  assert.equal(job.status, 'pending')
  assert.equal(job.statusText, '待激活')
  assert.ok(job.createdAt >= before && job.createdAt <= Date.now())
  assert.equal(job.submittedAt, localTime(job.createdAt))
  assert.equal(job.dueAt, job.createdAt + 10 * 60_000)
  assert.equal(job.dueText, localTime(job.dueAt))
  assert.equal(job.conversation, record.key)
  assert.equal(job.conversationTitle, '甲的好友')

  const stored = loadStore(botId).jobs[0]
  assert.equal(stored.text, '十分钟后提醒对方喝水')
  assert.equal(stored.waitMinutes, 10)
  assert.equal(jobRow(stored, { record }).submittedAt, job.submittedAt)
})

test('校验：空内容、等待间隔越界、缺聊天；待激活配额与记录上限', () => {
  const botId = 'bot-limits'
  const record = conversation({ botId })
  assert.throws(() => createJob(botId, { conversation: record.key, text: '   ' }), /任务内容不能为空/)
  assert.throws(() => createJob(botId, { conversation: record.key, text: 'x', waitMinutes: 0 }), /不能小于/)
  assert.throws(() => createJob(botId, { conversation: '', text: 'x' }), /缺少目标聊天/)
  assert.throws(
    () => createJob(botId, { conversation: record.key, text: 'x', waitMinutes: MAX_WAIT_MINUTES + 1 }),
    /最多/,
  )
  assert.equal(MIN_WAIT_MINUTES, 1)

  for (let i = 0; i < MAX_PENDING; i++) createJob(botId, { conversation: record.key, text: `第 ${i} 条` })
  assert.equal(activeJobs(loadStore(botId)).length, MAX_PENDING)
  assert.throws(
    () => createJob(botId, { conversation: record.key, text: '再一条' }),
    new RegExp(`${MAX_PENDING} 条在等激活`),
  )

  // 记录上限：已结束的记录会被最老的先挤掉，留出位置给新任务。
  const full = 'bot-full'
  const jobs = []
  for (let i = 0; i < MAX_JOBS; i++) {
    jobs.push({
      id: `old_${i}`, conversation: record.key, sessionId: 'sid-a', title: '旧任务',
      text: `旧 ${i}`, createdAt: Date.now() - (MAX_JOBS - i) * 60_000, waitMinutes: 5,
      repeatMinutes: 0, dueAt: Date.now() - 60_000, status: 'cancelled', enabled: false,
    })
  }
  saveStore({ version: 1, botId: full, jobs })
  createJob(full, { conversation: record.key, text: '新任务' })
  const after = loadStore(full)
  assert.equal(after.jobs.length, MAX_JOBS)
  assert.ok(after.jobs.some((job) => job.text === '新任务'))
  assert.equal(after.jobs.some((job) => job.id === 'old_0'), false)
})

test('到点才激活：正文带任务内容与等待时长，激活后记录变已激活', async () => {
  const botId = 'bot-fire'
  const record = conversation({ botId, sessionId: 'sid-fire' })
  const bridge = makeBridge([record])
  const engine = engineFor(bridge, [{ id: botId }])
  const job = engine.create({ record, text: '提醒喝水', waitMinutes: 5 })

  assert.equal(await engine.tick(), 0)
  assert.equal(bridge.activations.length, 0)

  moveDue(botId, job.id)
  assert.equal(await engine.tick(), 1)
  assert.equal(bridge.activations.length, 1)
  assert.equal(bridge.activations[0].key, record.key)
  assert.equal(bridge.activations[0].jobId, job.id)
  assert.match(bridge.activations[0].text, /提醒喝水/)
  assert.match(bridge.activations[0].text, /等了 \d+ 分钟/)
  assert.match(bridge.activations[0].text, new RegExp(`#${job.id}`))

  const after = loadStore(botId).jobs.find((row) => row.id === job.id)
  assert.equal(after.status, 'done')
  assert.equal(after.enabled, false)
  assert.equal(after.fireCount, 1)
  // 一次性的不会再激活。
  assert.equal(await engine.tick(), 0)
  assert.equal(dueJobs(loadStore(botId)).length, 0)
})

test('重启竞态：通道还没起来就等着，通道就绪后同一个任务补上激活', async () => {
  const botId = 'bot-restart'
  const record = conversation({ botId, sessionId: 'sid-restart' })
  // 刚重启：ticker 已经跑了，botManager.startAll() 还没建出通道。
  const bridge = makeBridge([record], { channel: null })
  const engine = engineFor(bridge, [{ id: botId }])
  const job = engine.create({ record, text: '重启后该说的话', waitMinutes: 1 })
  moveDue(botId, job.id)

  assert.equal(await engine.tick(), 0)
  assert.equal(bridge.activations.length, 0)
  const waiting = loadStore(botId).jobs[0]
  assert.equal(waiting.status, 'pending')
  assert.equal(waiting.attempts, 0, '通道没就绪不算失败，不该累积 attempts')
  assert.equal(waiting.lastError, '')

  // QQ 正在连接：继续等。
  bridge.state.channel = 'connecting'
  assert.equal(await engine.tick(), 0)
  assert.equal(loadStore(botId).jobs[0].status, 'pending')

  // 连上了：下个 tick 补激活。
  bridge.state.channel = 'ready'
  assert.equal(await engine.tick(), 1)
  assert.equal(bridge.activations.length, 1)
  assert.equal(loadStore(botId).jobs[0].status, 'done')
})

test('重启竞态：飞书不能拿 connected=false 挡住（配好了就该发）', async () => {
  const botId = 'bot-feishu'
  const record = conversation({ botId, channel: 'feishu', sessionId: 'sid-fs', key: `${botId}:feishu:c2c:p1` })
  // 飞书的 status().connected 恒为 false；configured 才是它「能发」的信号。
  const bridge = makeBridge([record], { channel: 'offline' })
  const engine = engineFor(bridge, [{ id: botId }])
  const job = engine.create({ record, text: '飞书提醒', waitMinutes: 1 })
  moveDue(botId, job.id)
  assert.equal(await engine.tick(), 1)
})

test('重启竞态：机器人停用期间不激活、不计失败，重新启用后补上', async () => {
  const botId = 'bot-disabled'
  const record = conversation({ botId, sessionId: 'sid-off' })
  const bridge = makeBridge([record])
  const engine = engineFor(bridge, [{ id: botId, enabled: false }])
  const job = engine.create({ record, text: '停用期间的任务', waitMinutes: 1 })
  moveDue(botId, job.id)
  assert.equal(await engine.tick(), 0)
  assert.equal(loadStore(botId).jobs[0].attempts, 0)

  const enabled = engineFor(bridge, [{ id: botId, enabled: true }])
  assert.equal(await enabled.tick(), 1)
  assert.equal(bridge.activations.length, 1)
})

test('重启后：任务落盘还在，新实例启动就补一次到点的', async () => {
  const botId = 'bot-reboot'
  const record = conversation({ botId, sessionId: 'sid-reboot' })
  // 第一个实例建任务（落盘），不跑 tick —— 等价于进程重启。
  const first = engineFor(makeBridge([record]), [{ id: botId }])
  first.create({ record, text: '重启前定的', waitMinutes: 30 })
  const stored = loadStore(botId).jobs[0]
  moveDue(botId, stored.id)

  // 新实例读同一份 DSH_HOME：记录还在，start() 立刻补一次。
  const bridge = makeBridge([record])
  const timers = []
  const second = installSchedule({
    interval: (fn) => { timers.push(fn); return () => {} },
    effect: () => () => {},
  }, { getConfig: () => ({}), getBots: () => [{ id: botId }], bridge, logger: { info() {}, warn() {} } })
  assert.equal(loadStore(botId).jobs.length, 1, '记录必须跨重启保留')
  second.start()
  for (let i = 0; i < 50 && bridge.activations.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(timers.length, 1, '应该挂一个周期 ticker')
  assert.equal(bridge.activations.length, 1, 'start() 应该立刻补一次到点的任务')
  assert.equal(loadStore(botId).jobs[0].status, 'done')
  second.stop()
})

test('会话正忙：不排队、不算失败、也不写错误，下个 tick 再来', async () => {
  const botId = 'bot-busy'
  const record = conversation({ botId, sessionId: 'sid-busy' })
  const bridge = makeBridge([record], { agentStatus: 'running' })
  const engine = engineFor(bridge, [{ id: botId }])
  const job = engine.create({ record, text: '提醒', waitMinutes: 1 })
  moveDue(botId, job.id)

  assert.equal(await engine.tick(), 0)
  assert.equal(bridge.activations.length, 0)
  const waiting = loadStore(botId).jobs[0]
  assert.equal(waiting.status, 'pending')
  assert.equal(waiting.attempts, 0)
  assert.equal(waiting.lastError, '')

  bridge.state.agentStatus = 'idle'
  assert.equal(await engine.tick(), 1)
  assert.equal(loadStore(botId).jobs[0].status, 'done')
})

test('连续失败自动停用，记录保留并写明原因', async () => {
  const botId = 'bot-fail'
  const bridge = makeBridge([])
  const engine = engineFor(bridge, [{ id: botId }])
  const job = engine.create({
    record: { key: `${botId}:qq:c2c:ghost`, botId, sessionId: 'sid-ghost', title: '已经不存在的聊天' },
    text: '提醒',
    waitMinutes: 1,
  })
  moveDue(botId, job.id)

  for (let i = 0; i < FAIL_LIMIT; i++) await engine.tick()
  const after = loadStore(botId).jobs[0]
  assert.equal(after.attempts, FAIL_LIMIT)
  assert.equal(after.status, 'failed')
  assert.equal(after.enabled, false)
  assert.match(after.lastError, /找不到目标聊天/)
  // 失败记录仍在列表里，页面上看得到「试过、没成、为什么」。
  assert.equal(loadStore(botId).jobs.length, 1)
  assert.equal(jobRow(after).statusText, '没激活成功')
})

test('重复任务：激活后按重复间隔排下一次，状态仍是待激活', async () => {
  const botId = 'bot-repeat'
  const record = conversation({ botId, sessionId: 'sid-repeat' })
  const bridge = makeBridge([record])
  const engine = engineFor(bridge, [{ id: botId }])
  const job = engine.create({ record, text: '循环提醒喝水', waitMinutes: 1, repeatMinutes: 30 })
  moveDue(botId, job.id)

  assert.equal(await engine.tick(), 1)
  const after = loadStore(botId).jobs[0]
  assert.equal(after.status, 'pending')
  assert.equal(after.fireCount, 1)
  assert.ok(after.dueAt > Date.now() + 29 * 60_000, '下一次要推到 30 分钟后')

  // 还没到下一次，不会连着再激活。
  assert.equal(await engine.tick(), 0)
  assert.equal(bridge.activations.length, 1)
})

test('错过太久不补激活：标记失败并写清原因', async () => {
  const botId = 'bot-missed'
  const record = conversation({ botId, sessionId: 'sid-missed' })
  const bridge = makeBridge([record])
  const engine = engineFor(bridge, [{ id: botId }])
  const job = engine.create({ record, text: '三天前的提醒', waitMinutes: 1 })
  moveDue(botId, job.id, -25 * 3600_000)

  assert.equal(await engine.tick(), 0)
  assert.equal(bridge.activations.length, 0)
  const after = loadStore(botId).jobs[0]
  assert.equal(after.status, 'failed')
  assert.match(after.lastError, /错过太久/)
})

test('取消 / 停用 / 删除：取消后不再激活，删除后记录消失', async () => {
  const botId = 'bot-manage'
  const record = conversation({ botId, sessionId: 'sid-manage' })
  const bridge = makeBridge([record])
  const engine = engineFor(bridge, [{ id: botId }])
  const job = engine.create({ record, text: '要取消的提醒', waitMinutes: 1 })

  const cancelled = cancelJob(botId, job.id)
  assert.equal(cancelled.status, 'cancelled')
  moveDue(botId, job.id)
  assert.equal(await engine.tick(), 0)
  assert.equal(bridge.activations.length, 0)
  assert.throws(() => setEnabled(botId, job.id, false), /不能再开关/)
  assert.throws(() => cancelJob(botId, job.id), /不用再取消/)
  assert.equal(removeJob(botId, job.id), true)
  assert.equal(loadStore(botId).jobs.length, 0)
  assert.throws(() => removeJob(botId, 'sch_nope'), /不存在/)

  // 停用只对还在等激活的任务有意义：关掉后 tick 不会碰它，打开也不会补激活旧账。
  const second = engine.create({ record, text: '先停用', waitMinutes: 1 })
  setEnabled(botId, second.id, false)
  moveDue(botId, second.id)
  assert.equal(await engine.tick(), 0)
  assert.equal(loadStore(botId).jobs.find((row) => row.id === second.id).status, 'pending')
})

test('激活正文：说清提交时间、等待时长和任务内容', () => {
  const created = Date.now() - 43 * 60_000
  const text = activationText({ id: 'sch_x', createdAt: created, text: '提醒喝水' }, created + 43 * 60_000)
  assert.match(text, /#sch_x/)
  assert.match(text, /提交，等了 43 分钟/)
  assert.match(text, /到点了/)
  assert.match(text, /提醒喝水/)
  assert.match(text, new RegExp(localTime(created)))
})

test('工具：机器人会话里能建、能查、能取消；没绑聊天时不猜目标', async () => {
  const config = configMod.loadConfig()
  const ctx = createFakeCtx()
  const botId = 'bot-tool'
  const record = conversation({ botId, sessionId: 'sid-tool', title: '甲的好友' })
  const bridge = {
    ...makeBridge([record]),
    recordForSession: (sessionId) => (sessionId === 'sid-tool' ? record : null),
  }
  const engine = engineFor(bridge, [{ id: botId }])
  installTools(ctx, {
    getConfig: () => config,
    bridge,
    channels: { status: () => [] },
    botManager: { registry: { get: () => ({ id: botId, name: '甲' }), stateDir: () => join(tmpdir(), 'companion-schedule-state') } },
    botProactive: { status: () => null },
    schedule: engine,
    logger: console,
  })
  const agent = makeAgent('sid-tool', ctx)
  const created = await ctx.__tools.get('companion_schedule').execute({ text: '提醒喝水', wait_minutes: 10 }, { agent })
  assert.equal(created.text, '提醒喝水')
  assert.equal(created.waitMinutes, 10)
  assert.equal(created.conversation, record.key)
  assert.equal(created.status, 'pending')

  const listed = await ctx.__tools.get('companion_schedule_list').execute({}, { agent })
  assert.equal(listed.botId, botId)
  assert.equal(listed.jobs.length, 1)
  assert.match(listed.text, /提醒喝水/)

  const cancelled = await ctx.__tools.get('companion_schedule_cancel').execute({ id: created.id }, { agent })
  assert.equal(cancelled.status, 'cancelled')

  // 普通会话：列表为空，创建要显式给 to，取消直接拒绝。
  const stranger = makeAgent('ordinary-session', ctx)
  const other = await ctx.__tools.get('companion_schedule_list').execute({}, { agent: stranger })
  assert.equal(other.botId, '')
  assert.equal(other.jobs.length, 0)
  await assert.rejects(
    () => ctx.__tools.get('companion_schedule').execute({ text: '随便' }, { agent: stranger }),
    /没有绑定聊天/,
  )
  await assert.rejects(
    () => ctx.__tools.get('companion_schedule_cancel').execute({ id: created.id }, { agent: stranger }),
    /不属于任何机器人/,
  )
  for (const dispose of ctx.__disposers.splice(0)) dispose()
})

function request(method, url, body) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  return { method, url, headers: {}, async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw) } }
}
function response() {
  return { status: 0, body: '', writeHead(code) { this.status = code }, end(value) { this.body = String(value ?? '') } }
}
async function call(ctx, method, url, body) {
  const route = ctx.__routes.find((item) => item.path === url.split('?')[0])
  assert.ok(route, `没有注册 ${url}`)
  const res = response()
  await route.handler(request(method, url, body), res)
  return { status: res.status, json: JSON.parse(res.body || '{}') }
}

test('设置页接口：列记录、页面新建、立即激活、删除；别的机器人的聊天拒绝', async () => {
  const ctx = createFakeCtx()
  const botId = 'bot-api'
  const record = conversation({ botId, sessionId: 'sid-api', title: '甲的好友' })
  const bridge = { ...makeBridge([record]), status: () => ({ conversations: [record] }) }
  const engine = engineFor(bridge, [{ id: botId }])
  installApi(ctx, {
    getConfig: () => configMod.loadConfig(),
    setConfig: () => {},
    patchConfig: () => configMod.loadConfig(),
    bridge,
    channels: { status: () => [] },
    botManager: {
      status: () => [{ id: botId, name: '甲' }],
      registry: {
        get: () => ({ id: botId, name: '甲' }),
        list: () => [{ id: botId, name: '甲' }],
        stateDir: () => join(tmpdir(), 'companion-schedule-state'),
      },
    },
    botProactive: { status: () => null },
    schedule: engine,
    logger: console,
    listModels: async () => [],
  })

  const empty = await call(ctx, 'GET', `/api/companion/schedule?botId=${botId}`)
  assert.equal(empty.status, 200)
  assert.equal(empty.json.jobs.length, 0)
  assert.equal(empty.json.conversations.length, 1)
  assert.equal(empty.json.conversations[0].key, record.key)
  assert.equal(empty.json.caps.minWaitMinutes, MIN_WAIT_MINUTES)

  const created = await call(ctx, 'POST', '/api/companion/schedule', {
    action: 'create', botId, conversation: record.key, text: '页面新建的任务', waitMinutes: 10,
  })
  assert.equal(created.status, 200)
  assert.equal(created.json.jobs.length, 1)
  assert.equal(created.json.jobs[0].text, '页面新建的任务')
  assert.equal(created.json.jobs[0].waitMinutes, 10)
  assert.ok(created.json.jobs[0].submittedAt)
  const id = created.json.jobs[0].id

  const foreign = await call(ctx, 'POST', '/api/companion/schedule', {
    action: 'create', botId, conversation: 'bot-other:qq:c2c:x', text: '插到别人聊天里',
  })
  assert.equal(foreign.status, 404)

  const fired = await call(ctx, 'POST', '/api/companion/schedule', { action: 'fire', botId, id })
  assert.equal(fired.status, 200)
  assert.equal(fired.json.result.ok, true)
  assert.equal(fired.json.jobs[0].status, 'done')

  const removed = await call(ctx, 'POST', '/api/companion/schedule', { action: 'remove', botId, id })
  assert.equal(removed.json.jobs.length, 0)

  // 设置页总状态只带摘要，不把整份记录塞进 /state。
  const state = await call(ctx, 'GET', '/api/companion/state')
  assert.equal(state.status, 200)
  assert.equal(Array.isArray(state.json.schedules), true)
  assert.equal(state.json.schedules.length, 1)
  assert.equal(state.json.schedules[0].botId, botId)
  assert.equal(state.json.schedules[0].schedule.pending, 0)

  for (const dispose of ctx.__disposers.splice(0)) dispose()
})