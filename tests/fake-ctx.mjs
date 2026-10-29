// 测试用的最小宿主替身：只实现灵犀真正调用到的接口。
export function createFakeCtx({ cwd = process.cwd(), llmText = '{}', onStream } = {}) {
  const disposers = []
  const routes = []
  const tools = new Map()
  const contexts = []
  const sections = []
  const listeners = new Map()
  const intervals = []
  const agents = new Map()
  const persisted = new Map()
  const created = []
  const resumes = []
  const followups = []
  const sent = []
  const workspaceAttachments = []
  const workspaceFailure = { error: null }
  const workspaces = []
  const sessionRenames = []
  const sessionTitles = new Map()

  function makeWorkspace(path, title = '测试工作区') {
    const workspace = {
      id: `ws-${workspaces.length + 1}`,
      title,
      path,
      sessionIds: [],
      async attachSession(sessionId) {
        if (workspaceFailure.error) throw workspaceFailure.error
        this.sessionIds = [sessionId, ...this.sessionIds.filter((id) => id !== sessionId)]
        workspaceAttachments.push({ sessionId, workspaceId: this.id, path: this.path })
      },
      async detachSession(sessionId) {
        this.sessionIds = this.sessionIds.filter((id) => id !== sessionId)
      },
    }
    workspaces.push(workspace)
    return workspace
  }
  makeWorkspace(cwd)

  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) {
      const dispose = typeof fn === 'function' ? fn() : undefined
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => { try { dispose?.() } catch { /* ignore */ } }
    },
    interval(fn, ms) {
      intervals.push({ fn, ms })
      return () => {}
    },
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      // 与宿主一致：返回退订函数（卸载时要能真的摘掉监听）。
      return () => {
        const index = list.indexOf(fn)
        if (index >= 0) list.splice(index, 1)
      }
    },
    emit(event, ...args) {
      for (const fn of listeners.get(event) ?? []) fn(...args)
    },
    systemPrompt: {
      context(definition) {
        contexts.push(definition)
        return () => {
          const index = contexts.indexOf(definition)
          if (index >= 0) contexts.splice(index, 1)
        }
      },
      section(definition) {
        sections.push(definition)
        return () => {
          const index = sections.indexOf(definition)
          if (index >= 0) sections.splice(index, 1)
        }
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      get(name) { return tools.get(name) },
      schemas() { return [...tools.values()] },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
      getOrigin() { return 'http://127.0.0.1:45999' },
    },
    agents: {
      get(id) { return agents.get(String(id)) },
      list() { return [...agents.values()] },
      async create(options) {
        const agent = makeAgent(options.sessionId, ctx)
        agent.session.header.cwd = options.meta?.cwd || process.cwd()
        if (options.meta?.agentPreset) agent.session.header.agentPreset = options.meta.agentPreset
        if (options.agentOptions) agent.options = { ...agent.options, ...options.agentOptions }
        agents.set(String(options.sessionId), agent)
        const handle = { agent, dispose: async () => agents.delete(String(options.sessionId)) }
        created.push({ options, handle })
        return handle
      },
      // 磁盘上的会话：把 header 放进 persisted、再把 agent 从内存删掉，就等价于「重启过了」。
      async resume(options) {
        resumes.push(options)
        const id = String(options.resumeSessionId ?? '')
        const agent = agents.get(id)
        if (agent) return { agent, dispose: async () => {} }
        const saved = persisted.get(id)
        if (saved) {
          const restored = makeAgent(id, ctx)
          restored.session.header = { ...saved.header }
          agents.set(id, restored)
          return { agent: restored, dispose: async () => { agents.delete(id) } }
        }
        throw new Error('no session')
      },
    },
    sessions: {
      list() { return [...agents.values()].map((agent) => agent.session) },
      get(id) { return agents.get(String(id))?.session },
      async flush() {},
    },
    workspaceRegistry: {
      list() { return workspaces.slice() },
      get(id) { return workspaces.find((workspace) => workspace.id === id) },
      async resolveByPath(path) { return workspaces.find((workspace) => workspace.path === path) },
      async create(path, title) {
        return workspaces.find((workspace) => workspace.path === path) || makeWorkspace(path, title)
      },
    },
    sessionQuery: {
      async listSessions() {
        return [...agents.values()].map((agent) => ({ header: agent.session.header, live: true, persisted: true }))
      },
      async readTitleSnapshots(ids) {
        return ids.map((id) => ({
          status: 'fulfilled',
          value: {
            session: { id },
            ...(sessionTitles.has(id) ? { title: { title: sessionTitles.get(id) } } : {}),
          },
        }))
      },
    },
    attachments: {
      async saveImage(input) {
        return { attachmentId: 'att_' + input.name, mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 }
      },
    },
    llm: {
      listProviders() { return [{ id: 'fake', name: 'Fake' }] },
      async listModels() { return [{ id: 'fake-model', name: 'Fake Model' }] },
      async *stream(request) {
        if (onStream) {
          yield* onStream(request)
          return
        }
        yield { type: 'text-delta', text: llmText }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) }
      if (name === 'sessionTitle') {
        return {
          rename(session, title) {
            sessionRenames.push({ id: session.id, title })
            sessionTitles.set(session.id, title)
          },
        }
      }
      return undefined
    },
    // 测试辅助
    __disposers: disposers,
    __routes: routes,
    __tools: tools,
    __contexts: contexts,
    __sections: sections,
    __listeners: listeners,
    __intervals: intervals,
    __agents: agents,
    __persisted: persisted,
    __created: created,
    __resumes: resumes,
    __followups: followups,
    __sent: sent,
    __workspaces: workspaces,
    __workspaceAttachments: workspaceAttachments,
    __workspaceFailure: workspaceFailure,
    __sessionRenames: sessionRenames,
    __sessionTitles: sessionTitles,
  }
  return ctx
}

export function makeAgent(id, ctx) {
  const session = {
    id,
    header: { id, cwd: process.cwd() },
    events: [],
    append(type, data) { this.events.push({ type, data, time: Date.now() }) },
    requestHeader() { return { config: { provider: 'fake', model: 'fake-model' } } },
    snapshotEvents() { return this.events.slice() },
  }
  return {
    id,
    status: 'idle',
    session,
    options: { provider: 'fake', model: 'fake-model' },
    ctx,
    async followup(message) {
      ctx.__followups.push({ agentId: id, message })
    },
  }
}

export function makeRecord(overrides = {}) {
  return {
    key: 'webhook:c2c:wxid_1',
    channel: 'webhook',
    scope: 'c2c',
    peerId: 'wxid_1',
    title: '微信 wxid_1',
    renamed: false,
    sessionId: '11111111-1111-1111-1111-111111111111',
    target: { conversation: 'wxid_1' },
    proactive: { enabled: true, cooldownMinutes: 0, lastSpokeAt: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastHumanAt: Date.now(),
    lastAssistantAt: 0,
    lastProactiveAt: 0,
    senderName: '测试者',
    ...overrides,
  }
}

/** 一台机器人：两段新会话默认配置默认都指向当前工作区。 */
export function makeBot(overrides = {}) {
  const { sessionDefaults, ...rest } = overrides
  const scope = (extra) => ({
    workspace: process.cwd(),
    preset: '',
    provider: '',
    model: '',
    defaultPermission: 'workspace-write',
    ...(extra || {}),
  })
  return {
    id: 'bot-a',
    channel: 'qq',
    name: '机器人甲',
    enabled: true,
    groupEnabled: true,
    credentials: {},
    contextEnhancement: { enabled: false },
    access: { mode: 'all', users: [], groups: [] },
    ...rest,
    sessionDefaults: {
      c2c: scope(sessionDefaults?.c2c),
      group: scope(sessionDefaults?.group),
    },
  }
}
