// 浏览器半侧的装配测试：不启动真浏览器，只验证 bundle 能被 ModuleLoader 认领并注册设置页。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const root = join(import.meta.dirname, '..')

function fakeReact(overrides = []) {
  const h = (type, props, ...children) => ({ type, props: props || {}, children })
  let stateIndex = 0
  return {
    createElement: h,
    Component: class { constructor(props) { this.props = props } setState(next) { this.state = { ...(this.state || {}), ...next } } },
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useState: (initial) => {
      const index = stateIndex++
      const value = index < overrides.length ? overrides[index] : initial
      return [typeof value === 'function' ? value() : value, () => {}]
    },
  }
}

function loadClient(react) {
  const captured = []
  const document = {
    getElementById: () => null,
    createElement: () => ({ set textContent(value) {}, id: '', parentNode: null }),
    head: { appendChild() {} },
  }
  const events = []
  const window = {
    __ModuleLoader__: { load(definition) { captured.push(definition) } },
    listeners: [],
    addEventListener(type, fn) { window.listeners.push({ type, fn }) },
    dispatchEvent(event) {
      events.push(event)
      for (const row of window.listeners) if (row.type === event.type) row.fn(event)
      return true
    },
  }
  class CustomEvent {
    constructor(type, init) {
      this.type = type
      this.detail = init?.detail
    }
  }
  const code = readFileSync(join(root, 'client.js'), 'utf8')
  const run = new Function('window', 'document', 'fetch', 'setTimeout', 'CustomEvent', code)
  run(window, document, async () => ({ ok: true, json: async () => ({ ok: true }) }), () => 0, CustomEvent)
  const definition = captured[0]
  const module = definition.factory((name) => {
    if (name !== 'react') throw new Error(`unexpected module ${name}`)
    return react
  })
  return { captured, definition, module, window, events, CustomEvent }
}

function textOf(tree) {
  if (tree == null || typeof tree === 'boolean') return ''
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(textOf).join(' ')
  if (typeof tree === 'object') return textOf(tree.children ?? tree.props?.children)
  return ''
}

function countDetails(tree) {
  if (tree == null || typeof tree === 'boolean') return 0
  if (typeof tree === 'string' || typeof tree === 'number') return 0
  if (Array.isArray(tree)) return tree.reduce((sum, node) => sum + countDetails(node), 0)
  if (typeof tree !== 'object') return 0
  const self = tree.type === 'details' ? 1 : 0
  return self + countDetails(tree.children ?? tree.props?.children)
}

/** 数组件用法（渲染前树里只有 <Disclosure> 这种函数引用，不会出现 <details>）。 */
function countType(tree, type) {
  if (tree == null || typeof tree === 'boolean') return 0
  if (typeof tree === 'string' || typeof tree === 'number') return 0
  if (Array.isArray(tree)) return tree.reduce((sum, node) => sum + countType(node, type), 0)
  if (typeof tree !== 'object') return 0
  const self = tree.type === type ? 1 : 0
  return self + countType(tree.children ?? tree.props?.children, type)
}

/** 某个元素类型的 value（textarea 的正文不在 children 里，textOf 看不到）。 */
function valuesOfType(tree, type, out = []) {
  if (tree == null || typeof tree === 'boolean') return out
  if (typeof tree === 'string' || typeof tree === 'number') return out
  if (Array.isArray(tree)) {
    for (const node of tree) valuesOfType(node, type, out)
    return out
  }
  if (typeof tree !== 'object') return out
  if (tree.type === type && tree.props && 'value' in tree.props) out.push(tree.props.value)
  const children = tree.children ?? tree.props?.children
  for (const node of (Array.isArray(children) ? children : [children])) valuesOfType(node, type, out)
  return out
}

/** 组件 prop 里的 label（Field/Toggle 的标题不在 children 里，textOf 看不到）。 */
function labelsOf(tree, out = []) {
  if (tree == null || typeof tree !== 'object') return out
  if (Array.isArray(tree)) {
    for (const node of tree) labelsOf(node, out)
    return out
  }
  if (typeof tree.props?.label === 'string') out.push(tree.props.label)
  const children = tree.children ?? tree.props?.children
  for (const node of (Array.isArray(children) ? children : [children])) labelsOf(node, out)
  return out
}

/** 任意 prop 上的字符串（Disclosure 的 summary 之类，同样不在 children 里）。 */
function propStringsOf(tree, key, out = []) {
  if (tree == null || typeof tree !== 'object') return out
  if (Array.isArray(tree)) {
    for (const node of tree) propStringsOf(node, key, out)
    return out
  }
  if (typeof tree.props?.[key] === 'string') out.push(tree.props[key])
  const children = tree.children ?? tree.props?.children
  for (const node of (Array.isArray(children) ? children : [children])) propStringsOf(node, key, out)
  return out
}

/** 在渲染树里按可见文字找一个带 onClick 的节点（Button 组件与原生 button 都认）。 */
function findClickable(tree, label) {
  if (tree == null || typeof tree !== 'object') return null
  if (Array.isArray(tree)) {
    for (const node of tree) {
      const hit = findClickable(node, label)
      if (hit) return hit
    }
    return null
  }
  const children = tree.children ?? tree.props?.children
  if (typeof tree.props?.onClick === 'function' && textOf(children) === label) return tree
  for (const node of (Array.isArray(children) ? children : [children])) {
    const hit = findClickable(node, label)
    if (hit) return hit
  }
  return null
}

test('client bundle：注册 settings.section 且能渲染', async () => {
  const { captured, definition, module } = loadClient(fakeReact())

  assert.equal(captured.length, 1)
  assert.equal(definition.id, 'dsh-lingxi-agent-bot')
  assert.equal(module.name, 'companion')
  assert.deepEqual(module.inject, ['slots'])

  const slots = []
  const ctx = {
    effect(fn) { return fn() },
    slots: {
      inject(name, factory) { slots.push({ name, factory }) },
      register(options, component) { return { options, component } },
    },
  }
  module.apply(ctx)
  assert.equal(slots.length, 2)
  assert.equal(slots[0].name, 'settings.section')
  assert.equal(slots[1].name, 'shell.overlay')
  const registered = slots[0].factory()
  assert.equal(registered.options.id, 'companion')
  assert.equal(registered.options.order, 47)
  assert.equal(registered.options.label(), '灵犀')

  // 第二个注册项只广播会话，不画东西；挂饰脚本据此决定显不显示。
  const bridge = slots[1].factory()
  assert.equal(bridge.options.id, 'companion-widget-session')
  assert.equal(typeof bridge.component({}).type, 'function')

  const rendered = registered.component({ sessionId: 's1' })
  assert.equal(typeof rendered.type, 'function')
  const app = rendered.children[0]
  const appRendered = app.type(app.props)
  assert.equal(appRendered.type, 'div')
  assert.match(appRendered.props.className, /cp-root/)

  // 用一份和宿主 /state 一致的形状，逐个渲染面板，抓未定义字段这类错误。
  const state = {
    ok: true,
    origin: 'http://127.0.0.1:45999',
    cwd: 'D:\\demo',
    configPath: 'C:\\Users\\demo\\.dsh\\dsh-lingxi-agent-bot\\config.json',
    config: {
      configVersion: 1,
      identity: { selfName: '测试机器人', ownerName: '饲养员', aliases: '小鱼', pronoun: 'ta' },
      persona: { enabled: true, includeGlobal: true, projectPersona: true, localNames: ['AGENT.md'], maxChars: 30000, order: 800 },
      memory: { enabled: true, order: 880 },
      mood: { enabled: true, order: 890 },
      proactive: { enabled: true, intervalMinutes: 30, hitLine: 30, missBonus: 10, bonusCap: 40, quietStart: 23, quietEnd: 7, minIdleMinutes: 60, cooldownMinutes: 20, maxPerDay: 6, prompt: '想找你说话。' },
      channels: {
        feishu: { enabled: false, appId: '', appSecret: '', verificationToken: '', encryptKey: '', requireMention: true, maxChars: 1500 },
        webhook: { enabled: false, label: '微信', secret: '', outboundUrl: '', requireMention: false, maxChars: 1500 },
      },
      voice: { enabled: true, provider: 'auto', endpoint: '', apiKey: '', model: 'tts-1', voice: 'alloy', format: 'mp3', promptEnabled: true, prompt: '' },
      sessions: { cwd: '', workspace: '', idleMinutes: 0, autoCreate: true, titlePrefix: '伴侣' },
      tools: { enabled: true },
    },
    channels: [
      { name: 'feishu', channel: 'feishu', enabled: false, configured: false, lastError: '', callback: '/api/companion/channels/feishu/event' },
      { name: 'webhook', channel: 'webhook', enabled: false, inbound: '/api/companion/channels/webhook/inbound', lastError: '' },
    ],
    bots: [{
      id: 'qq-demo', channel: 'qq', name: '测试机器人', enabled: true,
      credentials: { appId: 'demo', appSecret: '••••••••' },
      sessionDefaults: {
        c2c: { workspace: 'D:\\demo', preset: '', provider: '', model: '', defaultPermission: 'workspace-write' },
        group: { workspace: '', preset: '', provider: '', model: '', defaultPermission: 'read-only' },
      },
      createdAt: Date.now(), updatedAt: Date.now(),
      online: true,
      chats: [
        {
          key: 'qq-demo:webhook:c2c:wxid_1', channel: 'webhook', botId: 'qq-demo', scope: 'c2c', peerId: 'wxid_1',
          title: '微信 饲养员', sessionId: 'sid-1', senderName: '饲养员', lastHumanAt: Date.now(), lastAssistantAt: Date.now(),
          lastProactiveAt: 0, messageCount: 3, live: true,
          proactive: { enabled: true, cooldownMinutes: 0, lastSpokeAt: 0 },
          voicePrompt: { enabled: true },
        },
        {
          key: 'qq-demo:qq:group:g1', channel: 'qq', botId: 'qq-demo', scope: 'group', peerId: 'g1',
          title: 'QQ群 g1', sessionId: 'sid-2', senderName: '群友', lastHumanAt: Date.now() - 3600_000, lastAssistantAt: 0,
          lastProactiveAt: 0, messageCount: 7, live: false,
          proactive: { enabled: false, cooldownMinutes: 30, lastSpokeAt: 0 },
          voicePrompt: { enabled: false },
        },
      ],
      status: { state: 'connected', connected: true, connecting: false, bound: true, lastError: '', health: { state: 'connected', summary: '运行正常' }, qr: null },
    }],
    sessions: { conversations: [{ key: 'webhook:c2c:wxid_1', title: '微信 饲养员', channel: 'webhook', scope: 'c2c', peerId: 'wxid_1', sessionId: 'sid-1', senderName: '饲养员', lastHumanAt: Date.now(), lastAssistantAt: Date.now(), lastProactiveAt: 0, messageCount: 3, live: true }] },
    mood: {
      mood: 72, label: '开心', emoji: '🙂', lastReason: '饲养员夸我', lastConfidence: 90, minor: false, kind: '',
      updatedAt: Date.now(), injectMode: 'event', injectable: true, saidToday: 1, injectPerDay: 6, lastInjectedText: '', preview: '（这会儿）心里是松的',
      dims: [{ key: 'happy', label: '开心', value: 40 }], timeline: [{ at: Date.now(), mood: 72, delta: 1, reason: '夸我', conf: 90 }],
    },
    proactive: { enabled: true, line: 40, baseLine: 30, bonus: 10, misses: 1, lastSpokeAt: 0, lastRoll: { roll: 20, line: 40, hit: true }, saidToday: 1, maxPerDay: 6, minIdleMinutes: 60, cooldownMinutes: 20, quiet: '23:00 - 7:00', conversations: [], logs: [{ at: Date.now(), text: '测试' }] },
    memory: { sessionId: 'sid-1', enabled: true, count: 1, longTerm: 0, superseded: 0, dailyUsed: 1, dailyQuota: 8, memories: [{ id: 'm1', text: '主人喜欢下雨天', at: Date.now(), importance: 80, emotion: 50, factKey: '', longTerm: true, recallCount: 1 }], lastRecall: { at: Date.now(), query: '下雨', items: [{ id: 'm1', text: '主人喜欢下雨天' }], skipped: [] } },
    persona: { effective: { chars: 120, sources: [{ kind: 'builtin', chars: 120 }], preview: '你是测试机器人。' } },
    voice: { enabled: true, provider: 'auto', endpoint: '', format: 'mp3' },
  }
  const panels = module.__test
  const checks = [
    [panels.OverviewPanel, { state, refresh: () => {}, busy: false, action: () => {} }],
    [panels.PersonaPanel, { state, sessionId: 'sid-1', busy: false, setBusy: () => {}, toast: () => {} }],
    [panels.MemoryPanel, { state, sessionId: 'sid-1', busy: false, setBusy: () => {}, toast: () => {} }],
    [panels.MoodPanel, { state, busy: false, setBusy: () => {}, toast: () => {} }],
    [panels.ProactivePanel, { state, busy: false, setBusy: () => {}, toast: () => {}, refresh: () => {} }],
    [panels.SchedulePanel, { state, botId: 'qq-demo', tick: 0, busy: false, setBusy: () => {}, toast: () => {} }],
    [panels.BotsPanel, { state, busy: false, setBusy: () => {}, toast: () => {}, refresh: () => {} }],
    [panels.AddBotPanel, { busy: false, toast: () => {}, refresh: () => {}, onBack: () => {}, onDone: () => {} }],
    [panels.LogsPanel, { busy: false, setBusy: () => {}, toast: () => {} }],
  ]
  for (const [component, props] of checks) {
    const tree = component(props)
    assert.ok(tree, '面板应该渲染出内容')
  }

  state.bots[0].sessionDefaults.c2c.workspace = process.cwd()
  state.workspaceDetails = [
    { id: 'ws-demo', title: '当前工作区', path: process.cwd(), sessionIds: ['in-ws'] },
    { id: 'ws-other', title: '另一个工作区', path: 'D:\\other', sessionIds: ['out-ws'] },
  ]
  // 宿主会话目录现在由 /api/companion/sessions 按需给，不进 /state。
  const sessionList = [
    { id: 'in-ws', title: '同工作区会话', cwd: process.cwd(), workspaceId: 'ws-demo', grouped: true, boundKey: '' },
    { id: 'ungrouped-ws', title: '历史未分组会话', cwd: process.cwd(), workspaceId: 'ws-demo', grouped: false, boundKey: '' },
    { id: 'out-ws', title: '其他工作区会话', cwd: 'D:\\other', workspaceId: 'ws-other', grouped: true, boundKey: '' },
    { id: 'subagent', title: '子代理会话', cwd: process.cwd(), workspaceId: 'ws-demo', origin: 'subagent', boundKey: '' },
    { id: 'sid-2', title: '群聊用的会话', cwd: 'D:\\group-ws', workspaceId: 'ws-group', grouped: true, boundKey: 'qq-demo:qq:group:g1' },
  ]
  state.personas = [{ botId: 'qq-demo', name: '测试机器人', effective: state.persona.effective }]
  state.memories = [{ botId: 'qq-demo', name: '测试机器人', memory: state.memory }]
  state.moods = [{ botId: 'qq-demo', name: '测试机器人', mood: state.mood }]
  state.proactives = [{ botId: 'qq-demo', name: '测试机器人', proactive: state.proactive }]

  const memoryText = textOf(panels.MemoryPanel({ state, botId: 'qq-demo', busy: false, setBusy: () => {}, toast: () => {} }))
  assert.match(memoryText, /共享记忆/)
  assert.match(memoryText, /一直生效/)
  assert.doesNotMatch(memoryText, /打开|关掉/)
  assert.doesNotMatch(memoryText, /选择聊天/)

  const appModule = loadClient(fakeReact([state, 'overview', 'qq-demo'])).module
  const appText = textOf(appModule.__test.App({ sessionId: 's1' }))
  assert.match(appText, /当前机器人/)
  // 导航分组：全局设置（机器人 → 语音 → 日志）→ 当前机器人（选择器 + 它的页面 + 仅 QQ 的语音条）。
  assert.ok(appText.indexOf('全局设置') >= 0)
  assert.ok(appText.indexOf('全局设置') < appText.indexOf('连接、凭据、新会话默认'))
  assert.ok(appText.indexOf('连接、凭据、新会话默认') < appText.indexOf('合成来源与状态'))
  assert.ok(appText.indexOf('合成来源与状态') < appText.indexOf('运行记录'))
  assert.ok(appText.indexOf('运行记录') < appText.indexOf('当前机器人'))
  assert.ok(appText.indexOf('当前机器人') < appText.indexOf('请选择机器人'))
  assert.ok(appText.indexOf('请选择机器人') < appText.indexOf('总览'))
  assert.ok(appText.indexOf('总览') < appText.indexOf('会话管理'))
  // 选中的是 QQ 机器人 → 「语音条」出现，排在会话管理后面。
  assert.ok(appText.indexOf('会话管理') < appText.indexOf('仅 QQ · 发送与目标'))
  assert.ok(appText.indexOf('仅 QQ · 发送与目标') < appText.indexOf('私聊 '))
  assert.doesNotMatch(appText, /诊断/)
  assert.doesNotMatch(appText, /标签|Status/)
  // 选中的不是 QQ 机器人 → 这个 tab 不出现。
  const wxState = Object.assign({}, state, {
    bots: [Object.assign({}, state.bots[0], { id: 'wx-demo', channel: 'webhook', name: '微信机器人' })],
  })
  const wxAppText = textOf(loadClient(fakeReact([wxState, 'overview', 'wx-demo'])).module.__test.App({ sessionId: 's1' }))
  assert.match(wxAppText, /微信机器人/)
  assert.doesNotMatch(wxAppText, /仅 QQ · 发送与目标/)

  const form = {
    name: '测试机器人',
    sessionDefaults: {
      c2c: { workspace: process.cwd(), preset: '', provider: '', model: '', defaultPermission: 'workspace-write' },
      group: { workspace: 'D:\\group-ws', preset: '', provider: '', model: '', defaultPermission: 'read-only' },
    },
    groupEnabled: false, busyMessageMode: 'queue',
    contextEnabled: false, contextGuidance: '', contextSender: true, contextChat: true, contextTime: true,
    accessMode: 'all', accessUsers: '', accessGroups: '',
  }
  const providers = [{ id: 'p1', name: '测试 Provider', models: [{ id: 'm1', name: '测试模型' }] }]
  const presets = [{ id: 'preset1', name: '测试 Preset' }]
  const detailModule = loadClient(fakeReact([form, null, 'qq', {}, providers, presets])).module
  const detailTree = detailModule.__test.BotsPanel({
    state, activeBotId: 'qq-demo', view: 'detail', busy: false, setBusy: () => {}, toast: () => {}, refresh: () => {},
  })
  const detailText = textOf(detailTree)
  assert.match(detailText, /私聊工作区/)
  assert.match(detailText, /群聊工作区/)
  assert.ok(detailText.indexOf('私聊工作区') < detailText.indexOf('私聊默认权限'))
  assert.ok(detailText.indexOf('私聊默认权限') < detailText.indexOf('私聊 Agent Preset'))
  assert.ok(detailText.indexOf('私聊 Agent Preset') < detailText.indexOf('私聊模型'))
  assert.match(detailText, /群聊默认权限/)
  assert.match(detailText, /选择|更换/)
  assert.match(detailText, /允许群聊/)
  assert.match(detailText, /测试 Preset/)
  assert.match(detailText, /测试模型/)
  assert.match(detailText, /消息处理方式/)
  // 会话模块已经搬到最外层导航，详情页只留新会话默认。
  assert.match(detailText, /会话管理/)
  assert.doesNotMatch(detailText, /私聊（1）/)
  assert.doesNotMatch(detailText, /微信 饲养员/)
  assert.doesNotMatch(detailText, /换绑会话/)
  // 旧的 bot 级会话绑定 / 单段工作区字段不该再出现在详情页。
  assert.doesNotMatch(detailText, /会话模式/)
  assert.doesNotMatch(detailText, /新会话工作区/)
  assert.doesNotMatch(detailText, /新会话 Agent Preset/)
  assert.doesNotMatch(detailText, /新会话模型/)

  const noSelectionModule = loadClient(fakeReact([form])).module
  const noSelectionText = textOf(noSelectionModule.__test.BotsPanel({
    state, activeBotId: '', view: 'detail', busy: false, setBusy: () => {}, toast: () => {}, refresh: () => {},
  }))
  assert.match(noSelectionText, /选一个机器人/)
  assert.doesNotMatch(noSelectionText, /运行正常/)

  // 会话管理页：私聊 / 群聊分组，带总闸、每会话开关和换绑（冷却与重命名都不在这一页）。
  const chatProps = { state, botId: 'qq-demo', sessions: sessionList, sessionsLoading: false, reloadSessions: () => {}, busy: false, setBusy: () => {}, toast: () => {}, refresh: () => {} }
  const chatsTree = panels.ChatsPanel(chatProps)
  const chatsText = textOf(chatsTree)
  assert.match(chatsText, /私聊（1）/)
  assert.match(chatsText, /群聊（1）/)
  assert.match(chatsText, /微信 饲养员/)
  assert.match(chatsText, /QQ群 g1/)
  assert.match(chatsText, /wxid_1/)
  assert.match(chatsText, /主动搭话/)
  // 主动语音：总闸（全插件）+ 每个聊天的开关；非 QQ 机器人只给说明。
  assert.match(chatsText, /主动语音总闸/)
  assert.ok(labelsOf(chatsTree).includes('气氛到了会主动发语音'), '总闸要有开关')
  assert.match(chatsText, /1 个会主动发语音/, '面板栏要数出有几个会话开着主动语音')
  assert.equal((chatsText.match(/主动语音/g) || []).length >= 3, true, '每个聊天一个「主动语音」勾 + 卡片标题 + 统计')
  assert.doesNotMatch(chatsText, /重命名/)
  assert.doesNotMatch(chatsText, /冷却/)
  assert.match(chatsText, /换绑会话/)
  assert.match(chatsText, /同工作区会话/)
  assert.match(chatsText, /历史未分组会话/)
  assert.match(chatsText, /历史未分组会话 · 未分组/)
  assert.doesNotMatch(chatsText, /其他工作区会话/)
  assert.doesNotMatch(chatsText, /子代理会话/)
  // 已经被这台机器人某个聊天绑走的会话不再作为候选，但当前绑定的那个能显示名字。
  assert.match(chatsText, /群聊用的会话/)
  const noBotChatsText = textOf(panels.ChatsPanel({ state, botId: '', sessions: [], busy: false, setBusy: () => {}, toast: () => {}, refresh: () => {} }))
  assert.match(noBotChatsText, /只属于一台机器人/)

  // 全局「语音」页：只有合成状态与来源设置（发给谁不在这里）。
  const voiceInfo = {
    ok: true,
    voice: {
      enabled: true, provider: 'auto', effective: 'xiaomi', fallback: 'openai',
      format: 'mp3', model: 'tts-1', voice: 'alloy', timeoutMs: 120000,
      endpoint: 'https://tts.test/v1', apiKeySet: true,
      custom: { configured: true, endpoint: 'https://tts.test/v1' },
      dir: 'C:\\Users\\demo\\.dsh\\dsh-lingxi-agent-bot\\voice',
      temp: { count: 2, bytes: 4096 },
      xiaomi: { available: true, error: '', checked: true, route: '/plugins/xiaomi-mimo-tts/synthesize' },
      // 主动语音（提示词注入）的状态：设置页靠它显示开关、自定义与否、上次语音与内置默认规则。
      prompt: {
        enabled: true, promptEnabled: true, custom: false, pacingMinutes: 10,
        lastSentAt: Date.now() - 3 * 60_000, sentToday: 1,
        defaultText: '语音规则：主动用声音说话，不要等对方开口：',
      },
      checkedAt: Date.now(),
    },
    qq: { name: 'qq', channel: 'qq', enabled: true, connected: true, configured: true, bound: true, lastError: '' },
    bot: null,
    targets: [],
  }
  const voiceProps = {
    state, voice: voiceInfo, voiceLoading: false, reloadVoice: () => {},
    busy: false, setBusy: () => {}, toast: () => {}, refresh: () => {},
  }
  const voiceText = textOf(panels.VoicePanel(voiceProps))
  const voiceTree = panels.VoicePanel(voiceProps)
  assert.match(voiceText, /实际会用的来源：宿主语音朗读/)
  assert.match(voiceText, /宿主朗读路由：可用/)
  assert.match(voiceText, /宿主朗读失败时会自动改用自定义 TTS/)
  assert.match(voiceText, /残留文件 2 个 \/ 4 KB/)
  assert.match(voiceText, /合成试听/)
  assert.match(voiceText, /全插件共用/)
  // 「该折叠的折叠」：来源设置与提示词各是一个 details，页面上只留一行摘要；
  // 「开不开」不在这页——开关在会话管理里。
  const voiceTitles = propStringsOf(voiceTree, 'title')
  assert.ok(voiceTitles.includes('合成来源设置'), '来源设置要能折起来')
  assert.ok(voiceTitles.includes('主动语音提示词'), '提示词要能折起来')
  assert.ok(propStringsOf(voiceTree, 'summary').includes('宿主语音朗读（自动） · tts-1 / alloy · mp3'), '折起来也要看得到当前来源与音色')
  assert.ok(propStringsOf(voiceTree, 'summary').includes('使用默认规则'))
  assert.equal(countType(voiceTree, panels.Disclosure) >= 2, true, '至少两个可折叠区块（来源设置 / 提示词）')
  assert.doesNotMatch(voiceText, /注入语音规则/, '总闸不在这页')
  assert.doesNotMatch(voiceText, /主动语音开着的/, '开关说明不该再出现在语音页')
  assert.match(voiceText, /上次发语音：3 分钟前/)
  // 提示词框默认就把内置规则填进去（框里能直接看到默认文本），不是空框 + 占位符。
  const voiceTextareas = valuesOfType(voiceTree, 'textarea')
  assert.equal(voiceTextareas[0], '语音规则：主动用声音说话，不要等对方开口：', '提示词框要预填默认规则')
  // 用的是默认规则时，「恢复默认规则」在但按不动；点它只是把框恢复成默认文本。
  const restoreButton = findClickable(voiceTree, '恢复默认规则')
  assert.ok(restoreButton, '恢复默认规则按钮要一直在')
  assert.equal(restoreButton.props.disabled, true, '没有自定义时按不动')
  assert.doesNotMatch(voiceText, /可发语音的聊天/)
  assert.doesNotMatch(voiceText, /合成并发送语音条/)
  assert.match(voiceText, /开关在「会话管理 → 主动语音」/)
  // 关掉主动语音总闸不影响这一页（开关在会话管理）；合成关掉时状态仍然如实反映。
  const voiceDisabledTree = panels.VoicePanel(Object.assign({}, voiceProps, {
    state: Object.assign({}, state, { config: Object.assign({}, state.config, { voice: Object.assign({}, state.config.voice, { enabled: false }) }) }),
  }))
  assert.ok(labelsOf(voiceDisabledTree).includes('启用语音合成'), '合成开关还在语音页（它是设置）')
  const voiceEmptyText = textOf(panels.VoicePanel(Object.assign({}, voiceProps, { voice: null, voiceLoading: true })))
  assert.match(voiceEmptyText, /正在检测宿主朗读路由/)
  const voiceCustomText = textOf(panels.VoicePanel(Object.assign({}, voiceProps, {
    voice: Object.assign({}, voiceInfo, {
      voice: Object.assign({}, voiceInfo.voice, {
        effective: 'openai', custom: { configured: true, endpoint: 'https://tts.test/v1' }, apiKeySet: true,
      }),
    }),
  })))
  assert.match(voiceCustomText, /实际会用的来源：自定义 OpenAI 兼容 TTS/)
  assert.match(voiceCustomText, /API Key 已设置/)
  // 自定义过语音提示词：按钮变成「恢复默认规则」，状态行也要跟着变。
  const voiceOwnPromptText = textOf(panels.VoicePanel(Object.assign({}, voiceProps, {
    state: Object.assign({}, state, { config: Object.assign({}, state.config, { voice: Object.assign({}, state.config.voice, { prompt: '只在道晚安时用声音。' }) }) }),
  })))
  assert.match(voiceOwnPromptText, /恢复默认规则/)
  const voiceOwnTree = panels.VoicePanel(Object.assign({}, voiceProps, {
    state: Object.assign({}, state, { config: Object.assign({}, state.config, { voice: Object.assign({}, state.config.voice, { prompt: '只在道晚安时用声音。' }) }) }),
  }))
  assert.ok(propStringsOf(voiceOwnTree, 'summary').includes('已自定义 · 10 字'), '自定义过提示词时，折叠摘要要标出字数')
  assert.equal(valuesOfType(voiceOwnTree, 'textarea')[0], '只在道晚安时用声音。', '有自定义时框里显示自定义文本')
  assert.equal(findClickable(voiceOwnTree, '恢复默认规则').props.disabled, false, '有自定义时可以恢复默认')
  // 非 QQ 机器人：会话管理页只给说明，没有总闸也没有每会话开关。
  const wxChannelState = Object.assign({}, state, {
    bots: [Object.assign({}, state.bots[0], { channel: 'webhook', name: '微信机器人' })],
  })
  const wxChatsTree = panels.ChatsPanel({ state: wxChannelState, botId: 'qq-demo', sessions: sessionList, sessionsLoading: false, reloadSessions: () => {}, busy: false, setBusy: () => {}, toast: () => {}, refresh: () => {} })
  const wxChatsText = textOf(wxChatsTree)
  assert.match(wxChatsText, /只有 QQ 官方 Bot 有语音条/)
  assert.doesNotMatch(wxChatsText, /主动语音总闸\s*气氛/, '非 QQ 机器人不该给总闸开关')
  assert.equal((wxChatsText.match(/主动语音/g) || []).length <= 2, true, '非 QQ 机器人没有每个会话的「主动语音」勾')

  // 机器人级「语音条」页：只有 QQ 机器人有；列出这台机器人的 QQ 聊天与可发送状态。
  const voiceSendInfo = {
    ok: true,
    voice: voiceInfo.voice,
    qq: voiceInfo.qq,
    bot: { id: 'qq-demo', channel: 'qq', name: '测试机器人', status: { connected: true, bound: true, appId: 'demo', lastError: '' } },
    targets: [
      { key: 'qq-demo:qq:c2c:u1', title: 'QQ 主人', peerId: 'u1', botId: 'qq-demo', scope: 'c2c', ready: true, lastHumanAt: Date.now() },
      { key: 'qq-demo:qq:group:g1', title: 'QQ群 g1', peerId: 'g1', botId: 'qq-demo', scope: 'group', ready: false, lastHumanAt: Date.now() - 3600_000 },
    ],
  }
  const voiceSendProps = {
    state, botId: 'qq-demo', voice: voiceSendInfo, voiceLoading: false, reloadVoice: () => {},
    busy: false, setBusy: () => {}, toast: () => {},
  }
  const sendText = textOf(panels.VoiceSendPanel(voiceSendProps))
  assert.match(sendText, /QQ 官方 Bot：已连接/)
  assert.match(sendText, /合成：可用（宿主朗读）/)
  assert.match(sendText, /可发语音的聊天 1 \/ 2/)
  assert.match(sendText, /主动语音：已开启（默认规则）/)
  assert.match(sendText, /上次发语音 3 分钟前/)
  assert.match(sendText, /QQ 主人/)
  assert.match(sendText, /私聊 · u1 · 可发送/)
  assert.match(sendText, /QQ群 g1/)
  assert.match(sendText, /群聊 · g1 · 没有回复目标/)
  assert.match(sendText, /QQ群 g1（没有回复目标）/)
  assert.match(sendText, /合成并发送语音条/)
  const noTargetText = textOf(panels.VoiceSendPanel(Object.assign({}, voiceSendProps, {
    voice: Object.assign({}, voiceSendInfo, { targets: [], bot: Object.assign({}, voiceSendInfo.bot, { status: { connected: false, bound: true, appId: 'demo', lastError: '' } }) }),
  })))
  assert.match(noTargetText, /已绑定、未连接/)
  assert.match(noTargetText, /还没有 QQ 聊天/)
  assert.match(noTargetText, /还没有可发送的 QQ 聊天/)
  const offSynthText = textOf(panels.VoiceSendPanel(Object.assign({}, voiceSendProps, {
    voice: Object.assign({}, voiceSendInfo, { voice: Object.assign({}, voiceInfo.voice, { enabled: false }) }),
  })))
  assert.match(offSynthText, /合成：不可用/)
  assert.match(offSynthText, /把合成弄通/)
  // 非 QQ 机器人：给出明确说明，不给发送入口。
  const wxBotState = Object.assign({}, state, {
    bots: state.bots.concat([{ id: 'wx-demo', channel: 'webhook', name: '微信机器人', credentials: {}, sessionDefaults: state.bots[0].sessionDefaults, status: { connected: true } }]),
  })
  const wxVoiceText = textOf(panels.VoiceSendPanel(Object.assign({}, voiceSendProps, { state: wxBotState, botId: 'wx-demo', voice: null })))
  assert.match(wxVoiceText, /只有 QQ 官方 Bot 能发语音条/)
  assert.doesNotMatch(wxVoiceText, /合成并发送语音条/)
  const loadingText = textOf(panels.ChatsPanel(Object.assign({}, chatProps, { sessionsLoading: true })))
  assert.match(loadingText, /正在读宿主会话/)
  assert.match(loadingText, /刷新候选会话/)

  // 总览与主动搭话都留了去会话管理的入口。
  const navCalls = []
  const overviewTree = panels.OverviewPanel({
    state, botId: 'qq-demo', refresh: () => {}, busy: false, action: () => {},
    onNavigate: function (target) { navCalls.push(target) },
  })
  const openChats = findClickable(overviewTree, '打开会话管理')
  assert.ok(openChats, '总览应该有「打开会话管理」入口')
  openChats.props.onClick()
  // 注入被预设拿掉时，总览要能看见（只提示这台机器人的会话）。
  const warnedState = Object.assign({}, state, {
    injectionWarnings: [
      { sessionId: 's-a', botId: 'qq-demo', title: '微信 饲养员', missing: ['companion:memory', 'companion:mood'], got: ['companion:persona', 'companion:guide'], at: Date.now() },
      { sessionId: 's-other', botId: 'other-bot', title: '别人家的会话', missing: ['companion:persona'], got: [], at: Date.now() },
    ],
  })
  const warnedText = textOf(panels.OverviewPanel({
    state: warnedState, botId: 'qq-demo', refresh: () => {}, busy: false, action: () => {}, onNavigate: () => {},
  }))
  assert.match(warnedText, /注入被预设拿掉了/)
  assert.match(warnedText, /微信 饲养员 缺 companion:memory\/companion:mood/)
  assert.doesNotMatch(warnedText, /别人家的会话/)
  assert.doesNotMatch(textOf(overviewTree), /注入被预设拿掉了/)
  const proactiveForm = {
    intervalMinutes: 30, hitLine: 30, missBonus: 10, bonusCap: 40,
    quietStart: 23, quietEnd: 7, minIdleMinutes: 60, cooldownMinutes: 20, maxPerDay: 6, prompt: '在想你',
  }
  const proactiveTree = loadClient(fakeReact([proactiveForm])).module.__test.ProactivePanel({
    state, proactive: state.proactive, botId: 'qq-demo', busy: false, setBusy: () => {}, toast: () => {},
    refresh: () => {}, onNavigate: function (target) { navCalls.push(target) },
  })
  const gotoChats = findClickable(proactiveTree, '去会话管理')
  assert.ok(gotoChats, '主动搭话应该有「去会话管理」入口')
  gotoChats.props.onClick()
  assert.deepEqual(navCalls, ['chats', 'chats'])
  // 这一页只属于这台机器人的参数 / 统计 / 日志；开关与会话状态在会话管理里。
  const proactiveText = textOf(proactiveTree)
  const proactiveLabels = labelsOf(proactiveTree)
  for (const label of ['多久掷一次（分钟）', '基础命中线（0-100）', '没中加成 / 次', '安静起（点）', '对方多久没说话才主动（分钟）', '自己开口后的冷却（分钟）', '每天最多几次（0=不限）']) {
    assert.ok(proactiveLabels.includes(label), `主动搭话参数缺少「${label}」`)
  }
  assert.equal(proactiveLabels.includes('启用主动搭话'), false, '总闸不该留在这页')
  assert.match(proactiveText, /触发文案/)
  assert.match(proactiveText, /保存设置/)
  assert.match(proactiveText, /搭话统计/)
  assert.match(proactiveText, /今天已开口/)
  assert.match(proactiveText, /日志/)
  assert.doesNotMatch(proactiveText, /启用主动搭话/)
  assert.doesNotMatch(proactiveText, /会开口的会话/)
  assert.doesNotMatch(proactiveText, /会主动开口/)
  assert.doesNotMatch(proactiveText, /主动搭话总闸/)
  // 机器人自己的文案为空时，输入框里要有一段默认文案（取插件级默认，仅作起点）。
  const emptyPromptState = Object.assign({}, state, {
    config: Object.assign({}, state.config, { proactive: { prompt: '好久没人跟我说话了。' } }),
  })
  const emptyPromptTree = loadClient(fakeReact()).module.__test.ProactivePanel({
    state: emptyPromptState, proactive: Object.assign({}, state.proactive, { prompt: '' }), botId: 'qq-demo',
    busy: false, setBusy: () => {}, toast: () => {}, refresh: () => {}, onNavigate: () => {},
  })
  const promptValue = (function find(tree) {
    if (!tree || typeof tree !== 'object') return undefined
    if (Array.isArray(tree)) {
      for (const node of tree) { const hit = find(node); if (hit !== undefined) return hit }
      return undefined
    }
    if (tree.props?.className === 'cp-editor cp-editor-sm') return tree.props.value
    const children = tree.children ?? tree.props?.children
    for (const node of (Array.isArray(children) ? children : [children])) {
      const hit = find(node)
      if (hit !== undefined) return hit
    }
    return undefined
  })(emptyPromptTree)
  assert.equal(promptValue, '好久没人跟我说话了。', '触发文案输入框应该预填默认文案')
  // 总闸搬到了会话管理：机器人级开关 + 每会话开关都在那里。
  assert.match(chatsText, /主动搭话总闸/)
  assert.match(chatsText, /总闸关掉后/)
  assert.ok(labelsOf(chatsTree).includes('这台机器人会自己开口'), '会话管理要有机器人级总闸')

  // 机器人断开连接也不影响查看会话与开关。
  const offlineState = Object.assign({}, state, {
    bots: [Object.assign({}, state.bots[0], {
      status: { state: 'error', connected: false, configured: false, connecting: false, bound: true, lastError: '连接断了', health: { state: 'error', summary: '连接断了' }, qr: null },
    })],
  })
  const offlineText = textOf(panels.ChatsPanel(Object.assign({}, chatProps, { state: offlineState })))
  assert.match(offlineText, /私聊（1）/)
  assert.match(offlineText, /微信 饲养员/)
  assert.doesNotMatch(offlineText, /私聊工作区/)

  const feishuAddText = textOf(loadClient(fakeReact(['feishu'])).module.__test.AddBotPanel({ onBack: () => {}, onDone: () => {}, toast: () => {}, refresh: () => {} }))
  assert.match(feishuAddText, /扫码/)
  assert.doesNotMatch(feishuAddText, /创建机器人/)

  const emptyBotState = Object.assign({}, state, { bots: [], moods: [], proactives: [] })
  const emptyMoodText = textOf(panels.MoodPanel({ state: emptyBotState, botId: '', busy: false, setBusy: () => {}, toast: () => {} }))
  assert.match(emptyMoodText, /只属于机器人|先接入/)
  const emptyProactiveText = textOf(panels.ProactivePanel({ state: emptyBotState, botId: '', busy: false, setBusy: () => {}, toast: () => {}, refresh: () => {} }))
  assert.match(emptyProactiveText, /只属于机器人|先接入/)

  // 重复接入失败时，接入页必须报错并退回上一级，而不是一直转圈。
  assert.match(readFileSync(join(root, 'client.js'), 'utf8'), /接入失败，请重新尝试/)
})

test('client bundle：斗图页展示图库、状态与发送规则', () => {
  const meme = {
    ok: true,
    enabled: true,
    maxImages: 2,
    available: true,
    total: 24,
    packs: [{ id: 'test-pack-001', name: '测试表情包', count: 24, tags: ['happy', 'daily'] }],
    tags: ['happy', 'daily'],
    roots: [{ dir: 'C:/Users/x/.dsh/meme-packs', exists: false }],
    stats: {
      converted: 3,
      images: 4,
      missedTotal: 2,
      lastAt: Date.now(),
      lastCaption: '得意闭眼拳头，好耶',
      lastPath: 'C:/packs/memes/happy/deyi.jpg',
      lastMissAt: Date.now(),
      lastMissed: '一只完全不存在的小恐龙',
    },
  }
  const { module } = loadClient(fakeReact())
  const tree = module.__test.MemePanel({
    meme, memeLoading: false, reloadMeme: () => {}, busy: false, setBusy: () => {}, toast: () => {},
  })
  const text = textOf(tree)
  assert.match(text, /斗图状态/)
  assert.match(text, /测试表情包 · test-pack-001/)
  assert.match(text, /24 张/)
  assert.match(text, /deyi\.jpg/)
  assert.match(text, /一只完全不存在的小恐龙/)
  assert.match(text, /单轮最多发几张/)
  assert.match(text, /配上的表情包会作为原生图片消息发出/)
  // 开关标题在 Toggle 的 label 里，不在 children 上。
  assert.ok(labelsOf(tree).includes('把 [表情: 描述] 发成原生图片'))

  // 找不到图库时给出排查位置，而不是空白。
  const emptyTree = module.__test.MemePanel({
    meme: { ok: true, enabled: true, maxImages: 4, available: false, total: 0, packs: [], tags: [], roots: [{ dir: 'C:/nope', exists: false }], stats: {} },
    memeLoading: false, reloadMeme: () => {}, busy: false, setBusy: () => {}, toast: () => {},
  })
  const emptyText = textOf(emptyTree)
  assert.match(emptyText, /没找到 dsh-meme 的图库索引/)
  assert.match(emptyText, /C:\/nope/)
})

test('client bundle：定时激活页显示每条记录的提交时间、等待间隔和任务内容', () => {
  const submittedAt = '10-28 19:52'
  const dueText = '10-28 20:35'
  const jobs = [
    {
      id: 'sch_a', status: 'pending', statusText: '待激活', enabled: true,
      text: '提醒对方喝水，顺便问一句今天的饭吃了没',
      createdAt: Date.now() - 43 * 60_000, submittedAt,
      waitMinutes: 43, repeatMinutes: 0,
      dueAt: Date.now() + 30 * 60_000, dueText,
      nextFireAt: Date.now() + 30 * 60_000, nextText: dueText, remainingMinutes: 30,
      firedAt: 0, fireCount: 0, attempts: 0, lastError: '',
      conversation: 'bot-a:qq:c2c:u1', conversationTitle: '甲的好友', channel: 'qq', scope: 'c2c', sessionId: 'sid-a',
    },
    {
      id: 'sch_b', status: 'failed', statusText: '没激活成功', enabled: false,
      text: '循环提醒',
      createdAt: Date.now() - 3 * 3600_000, submittedAt,
      waitMinutes: 30, repeatMinutes: 30,
      dueAt: Date.now() - 3600_000, dueText,
      nextFireAt: 0, nextText: '', remainingMinutes: 0,
      firedAt: 0, fireCount: 0, attempts: 3, lastError: '找不到目标聊天了（可能已经删除）',
      conversation: 'bot-a:qq:c2c:gone', conversationTitle: '已删除的聊天', channel: 'qq', scope: 'c2c', sessionId: 'sid-b',
    },
  ]
  const chats = [{ key: 'bot-a:qq:c2c:u1', title: '甲的好友', live: true }]
  const caps = { minWaitMinutes: 1, maxWaitMinutes: 10080, maxPending: 20, maxText: 2000 }
  const form = { text: '', waitMinutes: 30, repeatMinutes: 0, conversation: 'bot-a:qq:c2c:u1' }
  const tree = loadClient(fakeReact([jobs, chats, caps, false, form])).module.__test.SchedulePanel({
    botId: 'bot-a', tick: 0, busy: false, setBusy: () => {}, toast: () => {},
  })
  const text = textOf(tree)

  // 用户要求能看到的三样：提交时间、等待间隔、任务内容。
  assert.match(text, new RegExp('提交 ' + submittedAt))
  assert.match(text, /等待 43 分钟/)
  assert.match(text, /提醒对方喝水，顺便问一句今天的饭吃了没/)
  assert.match(text, /记录（2 条，1 条待激活）/)
  assert.match(text, /待激活/)
  assert.match(text, /下次 .*（30 分钟后）/)
  assert.match(text, /每 30 分钟/)
  assert.match(text, /找不到目标聊天了/)
  assert.match(text, /没激活成功/)

  // 待激活的才给「立即激活 / 取消」，失败记录只留删除。
  assert.ok(findClickable(tree, '立即激活'))
  assert.ok(findClickable(tree, '取消'))
  assert.ok(labelsOf(tree).includes('等待间隔（分钟）'))
  assert.ok(labelsOf(tree).includes('重复间隔（分钟，0 = 只激活一次）'))
  // 「任务内容」是 textarea 的普通 label 文本，不在组件 prop 上。
  assert.match(text, /任务内容/)

  // 没选机器人时给说明，不渲染表单。
  const emptyTree = loadClient(fakeReact()).module.__test.SchedulePanel({
    botId: '', tick: 0, busy: false, setBusy: () => {}, toast: () => {},
  })
  assert.match(textOf(emptyTree), /只属于机器人/)
})

test('client bundle：导航里有「定时激活」，切到那一页显示记录区', () => {
  const state = {
    ok: true,
    bots: [{
      id: 'qq-demo', channel: 'qq', name: '测试机器人', enabled: true,
      credentials: { appId: 'demo', appSecret: '••••••••' },
      sessionDefaults: {
        c2c: { workspace: 'D:\\demo', preset: '', provider: '', model: '', defaultPermission: 'workspace-write' },
        group: { workspace: '', preset: '', provider: '', model: '', defaultPermission: 'read-only' },
      },
      status: { state: 'connected', connected: true },
    }],
    channels: [], moods: [], proactives: [], memories: [], personas: [],
    sessions: { conversations: [] }, config: {},
  }
  const text = textOf(loadClient(fakeReact([state, 'schedule', 'qq-demo'])).module.__test.App({ sessionId: 's1' }))
  assert.match(text, /定时激活/)
  assert.match(text, /到点自动唤醒/)
  // 页面说明来自 tabMeta；面板本身是函数组件，容器只放到这一层。
  assert.match(text, /当前机器人排着的定时任务/)
})

test('client bundle：机器人详情里有「她怎么叫你」，留空提示回落到全局称呼', () => {
  const state = {
    ok: true,
    identity: { selfName: '测试机器人', ownerName: '饲养员', aliases: '', pronoun: 'ta' },
    bots: [{
      id: 'qq-demo', channel: 'qq', name: '测试机器人', ownerName: '小明', enabled: true,
      credentials: { appId: 'demo', appSecret: '••••••••' },
      sessionDefaults: {
        c2c: { workspace: 'D:\\demo', preset: '', provider: '', model: '', defaultPermission: 'workspace-write' },
        group: { workspace: 'D:\\demo-group', preset: '', provider: '', model: '', defaultPermission: 'read-only' },
      },
      contextEnhancement: { enabled: false, includeSender: true, includeChat: true, guidance: '' },
      access: { mode: 'all', users: [], groups: [] },
      status: { state: 'connected', connected: true },
    }],
    channels: [], moods: [], proactives: [], memories: [], personas: [],
    sessions: { conversations: [] }, config: {},
  }
  /** form 由 useEffect 灌进来，测试里直接把首帧值喂给 BotsPanel 的第一个 useState。 */
  function renderDetail(groupWorkspace) {
    const form = {
      name: '测试机器人',
      ownerName: '小明',
      sessionDefaults: {
        c2c: { workspace: 'D:\\demo', preset: '', provider: '', model: '', defaultPermission: 'workspace-write' },
        group: { workspace: groupWorkspace, preset: '', provider: '', model: '', defaultPermission: 'read-only' },
      },
      groupEnabled: false,
      busyMessageMode: 'queue',
      contextEnabled: false,
      accessMode: 'all',
    }
    const { module } = loadClient(fakeReact([form]))
    return module.__test.BotsPanel({
      state, activeBotId: 'qq-demo', view: 'detail', busy: false,
      setBusy: () => {}, toast: () => {}, refresh: () => {}, onOpen: () => {}, onSelect: () => {},
    })
  }

  // 工作区齐全：一块表单一个保存按钮，称呼就跟名称挨在一起。
  const tree = renderDetail('D:\\demo-group')
  const text = textOf(tree)
  assert.ok(labelsOf(tree).includes('她怎么叫你'), '详情页应该有称呼输入框')
  assert.match(text, /保存设置/)
  assert.doesNotMatch(text, /保存称呼/, '称呼不该再有独立的保存按钮')
  assert.doesNotMatch(text, /新会话默认配置还缺/, '都配好了就不该提示缺项')
  // 输入框的 placeholder 要写出「留空会用哪个名字」，否则用户不知道空着是什么效果。
  assert.ok(
    propStringsOf(tree, 'placeholder').some((value) => value.includes('饲养员')),
    'placeholder 应该回落到全局 identity.ownerName',
  )

  // 缺群聊工作区：不再整份拒绝，而是在按钮上方说清楚这一段不提交。
  const partial = textOf(renderDetail(''))
  assert.match(partial, /新会话默认配置还缺：群聊/)
  assert.match(partial, /只存名字、称呼、消息处理这些个体设置/)
})

test('client bundle：挂饰会话广播用主视图保留的会话', () => {
  const { module, window, events } = loadClient(fakeReact())
  const Bridge = module.__test.WidgetSessionBridge

  // 与宿主标题栏同一口径：谁被主视图保留，谁就是页面正在看的会话。
  const state = {
    byId: {
      s1: { id: 's1', retainedBy: { sidebar: 1 } },
      s2: { id: 's2', retainedBy: { mainView: 1 } },
    },
  }
  const useSessions = (selector) => selector(state)
  Bridge({ useSessions })
  assert.equal(window.__dshCompanionSessionId, 's2', '应该广播主视图会话')
  const last = events[events.length - 1]
  assert.equal(last.type, 'dsh-companion:session')
  assert.equal(last.detail.sessionId, 's2')

  // 没有会话（空面板/未选会话）时广播空串：挂饰据此把自己收起来。
  Bridge({ useSessions: (selector) => selector({ byId: {} }) })
  assert.equal(window.__dshCompanionSessionId, '')
  assert.equal(events[events.length - 1].detail.sessionId, '')

  // 老宿主没有 useSessions 这个 prop 时不能抛错。
  assert.equal(Bridge({}), null)
  assert.equal(window.__dshCompanionSessionId, '')
})
