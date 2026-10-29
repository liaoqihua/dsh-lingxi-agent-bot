/**
 * 灵犀 · 浏览器半侧（手写 __ModuleLoader__ bundle，无需构建）
 * 设置 → 灵犀：总览 / 人格 / 记忆 / 心情 / 主动搭话 / 通信 / 日志。
 * 只走同源 fetch（/api/companion/*），不碰 RPC。
 *
 * 界面文案约定：只写「说明性文本」——这个开关/字段是什么、改了会发生什么、数据在哪。
 * 不写解释性文本（为什么这样设计、以前怎样、和别的插件对比、内部实现名）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-lingxi-agent-bot',
  factory: function (require) {
    var module = { exports: {} }
    var React = require('react')
    var h = React.createElement
    var Component = React.Component
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useMemo = React.useMemo
    var useState = React.useState

    var API = '/api/companion'
    var NS = 'dsh-lingxi-agent-bot'

    async function getJson(path) {
      var response = await fetch(path, { headers: { accept: 'application/json' } })
      var body = await response.json().catch(function () { return null })
      if (!response.ok || !body || body.ok === false) {
        throw new Error((body && (body.error || body.message)) || ('HTTP ' + response.status))
      }
      return body
    }

    async function postJson(path, body) {
      var response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body || {}),
      })
      var data = await response.json().catch(function () { return null })
      if (!response.ok || !data || data.ok === false) {
        throw new Error((data && (data.error || data.message)) || ('HTTP ' + response.status))
      }
      return data
    }

    function fmtTime(ms) {
      if (!ms) return '还没'
      var d = new Date(ms)
      var p = function (n) { return String(n).padStart(2, '0') }
      return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }

    function ago(ms) {
      if (!ms) return '—'
      var m = Math.max(0, (Date.now() - ms) / 60000)
      if (m < 1) return '刚刚'
      if (m < 60) return Math.round(m) + ' 分钟前'
      if (m < 1440) return Math.round(m / 60) + ' 小时前'
      return Math.round(m / 1440) + ' 天前'
    }

    var CHANNEL_LABEL = { qq: 'QQ', feishu: '飞书', webhook: '微信' }

    // 新会话默认配置按私聊 / 群聊分叉：两段各五项，工作区与默认权限必填。
    var SCOPES = [
      { key: 'c2c', label: '私聊', hint: '一对一的聊天' },
      { key: 'group', label: '群聊', hint: '群里被叫到时' },
    ]
    var PERMISSIONS = [
      { value: 'workspace-write', label: '工作区内可修改' },
      { value: 'read-only', label: '只读' },
      { value: 'danger-full-access', label: '完全访问' },
    ]

    function blankScopeDefault() {
      return { workspace: '', preset: '', provider: '', model: '', defaultPermission: 'workspace-write' }
    }

    function sessionDefaultsOf(bot) {
      var source = (bot && bot.sessionDefaults) || {}
      var out = {}
      for (var i = 0; i < SCOPES.length; i++) {
        var key = SCOPES[i].key
        out[key] = Object.assign(blankScopeDefault(), source[key] || {})
      }
      return out
    }

    function scopeOf(record) {
      return record && record.scope === 'group' ? 'group' : 'c2c'
    }

    function sessionIdShort(id) {
      var value = String(id || '')
      return value ? value.slice(-8) : '未绑定'
    }

    // ---- 基础组件 ---------------------------------------------------------

    function Card(props) {
      return h('div', { className: 'cp-card' + (props.tone ? ' cp-card-' + props.tone : '') }, props.children)
    }

    function Section(props) {
      return h('div', { className: 'cp-section' },
        h('div', { className: 'cp-section-head' },
          h('div', { className: 'cp-section-title' }, props.title),
          props.desc ? h('div', { className: 'cp-section-desc' }, props.desc) : null,
          props.right ? h('div', { className: 'cp-section-right' }, props.right) : null,
        ),
        props.children,
      )
    }

    function Dot(props) {
      var tone = props.tone || (props.on ? 'ok' : 'off')
      return h('span', { className: 'cp-dot cp-dot-' + tone })
    }

    function Stat(props) {
      return h('div', { className: 'cp-stat' },
        h('div', { className: 'cp-stat-label' }, props.label),
        h('div', { className: 'cp-stat-value' }, props.value),
        props.sub ? h('div', { className: 'cp-stat-sub' }, props.sub) : null,
      )
    }

    function Button(props) {
      return h('button', {
        type: 'button',
        className: 'cp-btn' + (props.primary ? ' cp-btn-primary' : '') + (props.danger ? ' cp-btn-danger' : ''),
        disabled: props.disabled,
        onClick: props.onClick,
      }, props.children)
    }

    function Field(props) {
      return h('label', { className: 'cp-field' + (props.wide ? ' cp-field-wide' : '') },
        h('span', { className: 'cp-field-label' }, props.label),
        props.hint ? h('span', { className: 'cp-field-hint' }, props.hint) : null,
        h('input', {
          className: 'cp-input',
          type: props.type || 'text',
          value: props.value == null ? '' : props.value,
          placeholder: props.placeholder || '',
          disabled: Boolean(props.disabled),
          onChange: function (event) { props.onChange && props.onChange(event.target.value) },
        }),
      )
    }

    function Toggle(props) {
      return h('label', { className: 'cp-toggle' },
        h('input', {
          type: 'checkbox',
          checked: !!props.value,
          onChange: function (event) { props.onChange && props.onChange(event.target.checked) },
        }),
        h('span', { className: 'cp-toggle-title' }, props.label),
        props.hint ? h('span', { className: 'cp-toggle-hint' }, props.hint) : null,
      )
    }

    function Toolbar(props) {
      return h('div', { className: 'cp-toolbar' }, props.children)
    }

    function Notice(props) {
      return h('div', { className: 'cp-notice cp-notice-' + (props.tone || 'info') }, props.children)
    }

    function Disclosure(props) {
      return h('details', {
        className: 'cp-disclosure'
          + (props.open ? ' cp-disclosure-open' : '')
          // flat：整张卡片就只有这一块折叠区时去掉顶部分隔线，别在卡片内再切一刀。
          + (props.flat ? ' cp-disclosure-flat' : ''),
        open: props.open === true,
      },
        h('summary', { className: 'cp-disclosure-summary' },
          h('span', { className: 'cp-disclosure-title' }, props.title),
          props.summary ? h('span', { className: 'cp-disclosure-summary-text' }, props.summary) : null,
          h('span', { className: 'cp-disclosure-arrow' }, '▾'),
        ),
        h('div', { className: 'cp-disclosure-body' }, props.children),
      )
    }

    function ErrorBoundary(props) {
      Component.call(this, props)
      this.state = { error: null }
    }
    ErrorBoundary.prototype = Object.create(Component.prototype)
    ErrorBoundary.prototype.constructor = ErrorBoundary
    ErrorBoundary.prototype.componentDidCatch = function (error) { this.setState({ error: error }) }
    ErrorBoundary.prototype.render = function () {
      if (this.state.error) {
        return h(Notice, { tone: 'error' }, '灵犀设置页渲染失败：' + (this.state.error.message || String(this.state.error)))
      }
      return this.props.children
    }

    // ---- 总览 -------------------------------------------------------------

    function OverviewPanel({ state, botId, refresh, busy, action, onNavigate }) {
      if (!state) return h('div', { className: 'cp-empty' }, '正在连接宿主…')
      var bots = state.bots || []
      var bot = bots.find(function (row) { return row.id === botId }) || null
      if (!bot) return h('div', null, h(Notice, { tone: 'info' }, '请先选择一台机器人。'))
      var currentId = bot ? bot.id : ''
      var mood = ((state.moods || []).find(function (row) { return row.botId === currentId }) || {}).mood || null
      var pro = ((state.proactives || []).find(function (row) { return row.botId === currentId }) || {}).proactive || null
      var memory = ((state.memories || []).find(function (row) { return row.botId === currentId }) || {}).memory || null
      var persona = ((state.personas || []).find(function (row) { return row.botId === currentId }) || null)
      var allConversations = (state.sessions && state.sessions.conversations) || []
      var conversations = bot ? allConversations.filter(function (row) { return row.botId === currentId }) : allConversations
      var enabledChannels = (state.channels || []).filter(function (c) { return c.enabled })
      var connected = bot
        ? Boolean(bot.status && (bot.status.connected || bot.status.configured))
        : (state.channels || []).some(function (c) { return c.connected })
      var setupSteps = [
        { ok: connected, label: '连接当前机器人', hint: connected ? ((bot && bot.name) || '已经连上') : 'QQ 扫码 / 微信桥接 / 飞书', tab: 'channels', action: connected ? '查看' : '去连接' },
        { ok: Boolean(bot && bot.sessionDefaults && bot.sessionDefaults.c2c && bot.sessionDefaults.c2c.workspace
          && bot.sessionDefaults.group && bot.sessionDefaults.group.workspace), label: '定下新会话默认配置', hint: bot ? (bot.sessionDefaults && bot.sessionDefaults.c2c && bot.sessionDefaults.c2c.workspace ? ('私聊 ' + bot.sessionDefaults.c2c.workspace + '；群聊 ' + ((bot.sessionDefaults.group && bot.sessionDefaults.group.workspace) || '还没选')) : '私聊和群聊各要一个工作区') : '先接入机器人', tab: 'channels', action: '去设置' },
        { ok: Boolean(persona && persona.effective && persona.effective.chars > 200), label: '写下她是谁', hint: '当前机器人的人格、称呼、说话方式', tab: 'persona', action: '去写' },
        { ok: conversations.length > 0, label: '发第一条消息', hint: conversations.length ? ('已注册 ' + conversations.length + ' 个会话') : '在通道里跟她说句话', tab: 'chats', action: conversations.length ? '看会话' : '去测试' },
      ]
      var doneSteps = setupSteps.filter(function (step) { return step.ok }).length
      // 注入被预设抑制时这一轮会缺人格/记忆/心情；只在这台机器人的会话里提示，别拿别的机器人的告警串台。
      var injectionWarnings = (state.injectionWarnings || []).filter(function (row) {
        return !row.botId || row.botId === currentId
      })
      return h('div', null,
        injectionWarnings.length
          ? h(Notice, { tone: 'error' }, '有 ' + injectionWarnings.length + ' 个会话的提示词注入被预设拿掉了：'
            + injectionWarnings.slice(0, 3).map(function (row) {
              return (row.title || row.sessionId.slice(0, 8)) + ' 缺 ' + (row.missing || []).join('/')
            }).join('；')
            + (injectionWarnings.length > 3 ? '…' : '')
            + '。检查这两处：Agent Preset 关掉了运行上下文，或人设用了 complete。')
          : null,
        h('div', { className: 'cp-setup' },
          h('div', { className: 'cp-setup-head' },
            h('div', null,
              h('div', { className: 'cp-setup-title' }, doneSteps === setupSteps.length ? '设置已经齐全' : '把灵犀接起来'),
              h('div', { className: 'cp-muted' }, doneSteps === setupSteps.length ? '四步已完成，之后可以按需调整。' : '按顺序完成这四步，就能在聊天里用起来。'),
            ),
            h('span', { className: 'cp-badge' + (doneSteps === setupSteps.length ? ' cp-badge-on' : '') }, doneSteps + ' / ' + setupSteps.length),
          ),
          h('div', { className: 'cp-setup-list' }, setupSteps.map(function (step, index) {
            return h('button', {
              key: step.label,
              className: 'cp-setup-step' + (step.ok ? ' cp-setup-step-done' : ''),
              onClick: function () { onNavigate && onNavigate(step.tab) },
            },
            h('span', { className: 'cp-setup-index' }, step.ok ? '✓' : String(index + 1)),
            h('span', { className: 'cp-setup-text' },
              h('span', { className: 'cp-setup-label' }, step.label),
              h('span', { className: 'cp-setup-hint' }, step.hint),
            ),
            h('span', { className: 'cp-setup-action' }, step.action),
            )
          })),
        ),
        h('div', { className: 'cp-stats' },
          h(Stat, {
            label: '通信',
            value: enabledChannels.length ? enabledChannels.map(function (c) { return CHANNEL_LABEL[c.name] || c.name }).join(' / ') : '全关',
            sub: '已绑定聊天 ' + conversations.length + ' 个',
          }),
          h(Stat, { label: '心情', value: (mood.emoji || '') + ' ' + (mood.label || '—'), sub: '数值 ' + (mood.mood == null ? '—' : mood.mood) + ' / 100' }),
          h(Stat, { label: '主动搭话', value: pro.enabled ? '开' : '关', sub: pro.enabled ? ('命中线 ' + pro.line + '，今天已说 ' + pro.saidToday + ' 次') : '关掉后不会自己开口' }),
          h(Stat, { label: '共享记忆', value: memory ? memory.count + ' 条' : '—', sub: memory ? ('长期 ' + memory.longTerm + ' 条，今天已记 ' + memory.dailyUsed + '/' + memory.dailyQuota) : '当前机器人还没有记忆' }),
        ),
        h('div', { className: 'cp-grid2' },
          h(Card, null,
            h('div', { className: 'cp-card-title' }, '通道'),
            (state.channels || []).map(function (channel) {
              var online = channel.connected === true
                || channel.configured === true
                || (channel.mode === 'group-bot' && channel.groupBotConfigured)
              return h('div', { className: 'cp-row', key: channel.name },
                h(Dot, { on: channel.enabled && online, tone: channel.enabled ? (online ? 'ok' : 'warn') : 'off' }),
                h('span', { className: 'cp-row-name' }, CHANNEL_LABEL[channel.name] || channel.name),
                h('span', { className: 'cp-row-meta' }, channel.enabled ? (online ? '已配置' : '待配置') : '未启用'),
                channel.lastError ? h('span', { className: 'cp-row-error', title: channel.lastError }, '有错误') : null,
              )
            }),
            h(Toolbar, null,
              h(Button, { onClick: function () { action('restart') }, disabled: busy }, '重启通道'),
              h(Button, { onClick: function () { action('proactive') }, disabled: busy }, '主动说一句'),
            ),
          ),
          h(Card, null,
            h('div', { className: 'cp-card-title' }, '最近绑定的聊天'),
            conversations.length === 0
              ? h('div', { className: 'cp-muted' }, '还没有。去 QQ / 微信 / 飞书里说一句话，聊天会自动出现在这里。')
              : conversations.slice(0, 6).map(function (row) {
                return h('div', { className: 'cp-row', key: row.key },
                  h(Dot, { on: row.live, tone: row.live ? 'ok' : 'warn' }),
                  h('span', { className: 'cp-row-name' }, row.title || row.key),
                  h('span', { className: 'cp-row-meta' }, '对方 ' + ago(row.lastHumanAt) + ' · 我 ' + ago(row.lastAssistantAt)),
                )
              }),
            h(Toolbar, null,
              h(Button, { onClick: function () { onNavigate && onNavigate('chats') } }, '打开会话管理'),
              h(Button, { onClick: refresh, disabled: busy }, '刷新状态'),
            ),
          ),
        ),
        persona
          ? h(Card, null,
            h('div', { className: 'cp-card-title' }, '当前机器人的人格'),
            h('div', { className: 'cp-muted' }, '共 ' + persona.effective.chars + ' 字 · ' + (persona.effective.sources || []).map(function (s) { return s.path || s.kind }).join(' + ')),
            h('pre', { className: 'cp-preview' }, (persona.effective.preview || '').slice(0, 1200)),
          )
          : null,
        h(Notice, { tone: 'info' },
          '所有设置保存在 ',
          h('span', { className: 'cp-code' }, state.configPath || ''),
          '。保存后立即生效，网页端不需要重启 DSH。',
        ),
      )
    }

    // ---- 人格 -------------------------------------------------------------

    function PersonaPanel({ state, botId, busy, setBusy, toast }) {
      var bots = (state && state.bots) || []
      var bot = bots.find(function (row) { return row.id === botId }) || null
      var [text, setText] = useState('')
      var [dirty, setDirty] = useState(false)
      var [error, setError] = useState('')
      var [file, setFile] = useState('')
      var currentId = bot ? bot.id : ''

      var load = useCallback(async function () {
        if (!currentId) { setText(''); setFile(''); return }
        setBusy(true)
        try {
          var body = await getJson(API + '/persona?botId=' + encodeURIComponent(currentId))
          setText(body.text || '')
          setFile(body.path || '')
          setDirty(false)
          setError('')
        } catch (err) { setError(err.message) } finally { setBusy(false) }
      }, [currentId, setBusy])

      useEffect(function () { load() }, [load])

      async function save() {
        if (!currentId) return
        setBusy(true)
        try {
          await postJson(API + '/persona', { botId: currentId, text: text })
          toast('机器人人格已保存')
          setDirty(false)
          await load()
        } catch (err) { setError(err.message) } finally { setBusy(false) }
      }

      if (!bot) {
        return h('div', null,
          h(Notice, { tone: 'info' }, '人格只属于机器人。先到「机器人」页接入一台机器人，再回来写它的人格。'),
        )
      }

      return h('div', null,
        h('div', { className: 'cp-panel-bar' },
          h('span', { className: 'cp-mini' }, '当前机器人：' + (bot.name || bot.id)),
          h('span', { className: 'cp-flex' }),
          h('span', { className: 'cp-mini' }, '只对这台机器人生效'),
        ),
        error ? h(Notice, { tone: 'error' }, error) : null,
        h(Card, null,
          h('div', { className: 'cp-filebar' },
            h('span', { className: 'cp-filepath' }, file || ('bots/' + currentId + '/persona.md')),
            h('span', { className: 'cp-mini' }, dirty ? '未保存' : '已保存'),
          ),
          h('textarea', {
            className: 'cp-editor',
            value: text,
            spellCheck: false,
            placeholder: '写这台机器人是谁、怎么说话、在意什么……只影响它自己的会话。',
            onChange: function (event) { setText(event.target.value); setDirty(true) },
          }),
          h(Toolbar, null,
            h(Button, { primary: true, onClick: save, disabled: busy || !dirty }, '保存人格'),
            h(Button, { onClick: load, disabled: busy }, '重新读取'),
            h('span', { className: 'cp-flex' }),
            h('span', { className: 'cp-mini' }, text.length + ' 字'),
          ),
        ),
      )
    }

    function MemoryPanel({ state, botId, busy, setBusy, toast }) {
      var bots = (state && state.bots) || []
      var bot = bots.find(function (row) { return row.id === botId }) || null
      var currentId = bot ? bot.id : ''
      var summary = ((state && state.memories) || []).find(function (row) { return row.botId === currentId })
      var [data, setData] = useState(summary ? summary.memory : null)
      var [error, setError] = useState('')
      var [draft, setDraft] = useState('')

      var load = useCallback(async function () {
        if (!currentId) { setData(null); return }
        setBusy(true)
        try {
          var body = await getJson(API + '/memory?botId=' + encodeURIComponent(currentId))
          setData(body)
          setError('')
        } catch (err) { setError(err.message) } finally { setBusy(false) }
      }, [currentId, setBusy])

      useEffect(function () { setData(summary ? summary.memory : null); load() }, [load])

      async function forget(id) {
        setBusy(true)
        try {
          await postJson(API + '/memory', { action: 'forget', botId: currentId, id: id })
          toast('已忘掉这一条')
          await load()
        } catch (err) { setError(err.message) } finally { setBusy(false) }
      }

      async function remember() {
        if (!draft.trim()) return
        setBusy(true)
        try {
          await postJson(API + '/memory', { action: 'remember', botId: currentId, text: draft.trim() })
          setDraft('')
          toast('已记下')
          await load()
        } catch (err) { setError(err.message) } finally { setBusy(false) }
      }

      if (!bot) {
        return h('div', null, h(Notice, { tone: 'info' }, '记忆只属于机器人。请先在「机器人」页接入并选择一台机器人。'))
      }

      var rows = (data && data.memories) || []
      var last = data && data.lastRecall
      return h('div', null,
        h('div', { className: 'cp-panel-bar' },
          h('span', { className: 'cp-mini' }, '共享记忆：' + (bot ? (bot.name || bot.id) : '未选择机器人') + ' 的所有聊天共用一份长期记忆。'),
          h('span', { className: 'cp-flex' }),
          h('span', { className: 'cp-mini' }, '只影响当前机器人'),
        ),
        error ? h(Notice, { tone: 'error' }, error) : null,
        data
          ? h(Card, null,
            h('div', { className: 'cp-row' },
              h(Dot, { on: true }),
              h('span', { className: 'cp-row-name' }, '共享记忆一直生效'),
              h('span', { className: 'cp-row-meta' }, data.count + ' 条 · 长期 ' + data.longTerm + ' 条 · 今天已记 ' + data.dailyUsed + '/' + data.dailyQuota),
            ),
            h('div', { className: 'cp-addrow' },
              h('input', {
                className: 'cp-input',
                value: draft,
                placeholder: '手动记一条（例如：主人喜欢下雨天）',
                onChange: function (event) { setDraft(event.target.value) },
                onKeyDown: function (event) { if (event.key === 'Enter') remember() },
              }),
              h(Button, { primary: true, onClick: remember, disabled: busy || !draft.trim() }, '记下'),
            ),
            rows.length === 0
              ? h('div', { className: 'cp-empty' }, '还没有记忆。正常聊天时会自动记录。')
              : h('div', { className: 'cp-list' }, rows.map(function (row) {
                return h('div', { className: 'cp-memory', key: row.id },
                  h('div', { className: 'cp-memory-main' },
                    h('div', { className: 'cp-memory-text' }, row.text),
                    h('div', { className: 'cp-memory-meta' },
                      fmtTime(row.at),
                      row.longTerm ? ' · 长期' : '',
                      ' · 重要 ' + row.importance,
                      ' · 情绪 ' + row.emotion,
                      ' · 想起 ' + row.recallCount + ' 次',
                      row.factKey ? ' · ' + row.factKey : '',
                    ),
                  ),
                  h('button', { className: 'cp-x', title: '忘掉', onClick: function () { forget(row.id) } }, '×'),
                )
              })),
          )
          : h(Card, null, h('div', { className: 'cp-empty' }, '这台机器人还没有共享记忆。正常聊天时会自动记录。')),
        last
          ? h(Card, null,
            h('div', { className: 'cp-card-title' }, '最近一次召回'),
            h('div', { className: 'cp-muted' }, fmtTime(last.at) + ' · 问的是「' + (last.query || '') + '」'),
            (last.items || []).map(function (item) { return h('div', { className: 'cp-memory-mini', key: item.id }, '✓ ' + item.text) }),
            (last.skipped || []).slice(0, 6).map(function (item, index) { return h('div', { className: 'cp-memory-mini cp-muted', key: 's' + index }, '— ' + item.text + '（' + item.reason + '）') }),
          )
          : null,
      )
    }

    // ---- 心情 -------------------------------------------------------------

    function MoodPanel({ state, mood: moodProp, botId, busy, setBusy, toast }) {
      if (!botId) {
        return h('div', null, h(Notice, { tone: 'info' }, '心情只属于机器人。请先接入并选择一台机器人。'))
      }
      var mood = moodProp || null
      if (!mood) return h('div', { className: 'cp-empty' }, '正在读取这台机器人的心情…')
      async function reset() {
        setBusy(true)
        try { await postJson(API + '/mood', { action: 'reset', botId: botId || '' }); toast('心情已重置到基线'); } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }
      return h('div', null,
        h('div', { className: 'cp-panel-bar' },
          h('span', { className: 'cp-mini' }, '每台机器人一份心情；随时间回落到基线。'),
          h('span', { className: 'cp-flex' }),
          h(Button, { onClick: reset, disabled: busy }, '重置心情'),
        ),
        h(Card, null,
          h('div', { className: 'cp-mood-head' },
            h('div', { className: 'cp-mood-emoji' }, mood.emoji),
            h('div', null,
              h('div', { className: 'cp-mood-num' }, mood.mood + ' / 100'),
              h('div', { className: 'cp-muted' }, mood.label + ' · ' + (mood.lastReason || '还没什么变化')),
            ),
          ),
          h('div', { className: 'cp-dims' }, (mood.dims || []).map(function (dim) {
            return h('div', { className: 'cp-dim', key: dim.key },
              h('span', { className: 'cp-dim-label' }, dim.label),
              h('div', { className: 'cp-dim-track' }, h('div', { className: 'cp-dim-fill', style: { width: Math.min(100, dim.value) + '%' } })),
              h('span', { className: 'cp-dim-value' }, dim.value),
            )
          })),
          h('div', { className: 'cp-muted' }, '今天已注入 ' + mood.saidToday + '/' + mood.injectPerDay + ' 次'
            + (mood.injectPerDay > 0 && mood.saidToday >= mood.injectPerDay ? '（已满额，之后由最新心情顶掉当天最早那次）' : '')
            + '；上次注入：' + ago(mood.lastInjectedAt)),
          h('div', { className: 'cp-mini' }, '注入＝把此刻的心情写成一小段背景搁进她的系统提示。她不会把这段念出来，只是接下来说话时带着那个底子。'),
          mood.preview ? h('pre', { className: 'cp-preview' }, mood.preview) : null,
        ),
        h(Card, null,
          h('div', { className: 'cp-card-title' }, '时间线'),
          (mood.timeline || []).slice().reverse().slice(0, 30).map(function (row, index) {
            return h('div', { className: 'cp-row', key: index },
              h('span', { className: 'cp-row-meta' }, fmtTime(row.at)),
              h('span', { className: 'cp-row-name' }, row.mood + '（' + (row.delta > 0 ? '+' : '') + row.delta + '）'),
              h('span', { className: 'cp-row-meta cp-ellipsis' }, row.reason || (row.kind === 'decay' ? '自然平复' : '')),
            )
          }),
        ),
      )
    }

    // ---- 主动搭话 ---------------------------------------------------------

    function ProactivePanel({ state, proactive, botId, busy, setBusy, toast, refresh, onNavigate }) {
      var pro = proactive || null
      var config = (state && state.config) || {}
      var source = pro || {}
      // 输入框里给一段默认文案：机器人自己的文案为空时，把插件级默认填进来让用户看见并可直接改。
      // 这只是「新建/为空时的起点」，运行时不回落到它（发了什么只认这台机器人的 proactive.json）。
      var defaultPrompt = String((config.proactive && config.proactive.prompt) || '')
      function buildForm() {
        return {
          intervalMinutes: source.intervalMinutes || 30,
          hitLine: source.hitLine == null ? 30 : source.hitLine,
          missBonus: source.missBonus == null ? 10 : source.missBonus,
          bonusCap: source.bonusCap == null ? 40 : source.bonusCap,
          quietStart: source.quietStart == null ? 23 : source.quietStart,
          quietEnd: source.quietEnd == null ? 7 : source.quietEnd,
          minIdleMinutes: source.minIdleMinutes == null ? 60 : source.minIdleMinutes,
          cooldownMinutes: source.cooldownMinutes == null ? 20 : source.cooldownMinutes,
          maxPerDay: source.maxPerDay == null ? 6 : source.maxPerDay,
          prompt: source.prompt || defaultPrompt,
        }
      }
      // 首帧就按当前数据建表（不用等 effect，避免闪一下「读取中」）。
      var [form, setForm] = useState(buildForm)
      // 表单只跟「已保存的参数」同步：统计（今天开口几次、上次骰子…）变了不重置表单，
      // 否则点一次「现在说一句」或刷新一下，没保存的编辑就没了。
      var savedSignature = JSON.stringify([
        source.intervalMinutes, source.hitLine, source.missBonus, source.bonusCap,
        source.quietStart, source.quietEnd, source.minIdleMinutes, source.cooldownMinutes,
        source.maxPerDay, source.prompt,
      ])
      useEffect(function () {
        setForm(buildForm())
      }, [botId, savedSignature])
      if (!botId) {
        return h('div', null, h(Notice, { tone: 'info' }, '主动搭话只属于机器人。请先接入并选择一台机器人。'))
      }
      function set(key, value) { setForm(function (old) { return Object.assign({}, old, { [key]: value }) }) }
      async function save() {
        setBusy(true)
        try {
          await postJson(API + '/proactive', { action: 'update', botId: botId || pro.botId, patch: form })
          toast('主动搭话设置已保存')
          refresh()
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }
      async function trigger() {
        setBusy(true)
        try {
          var result = await postJson(API + '/proactive', { botId: botId || pro.botId || '' })
          toast(result.result && result.result.spoke ? '已主动说一句' : ('没开口：' + ((result.result && result.result.reason) || '未知')))
          refresh()
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }
      return h('div', null,
        h('div', { className: 'cp-panel-bar' },
          h('span', { className: 'cp-mini' }, '这台机器人的主动搭话节奏与文案；总闸和每个会话的开关在「会话管理」里。'),
          h('span', { className: 'cp-flex' }),
          h(Button, { onClick: function () { onNavigate && onNavigate('chats') } }, '去会话管理'),
          h(Button, { onClick: trigger, disabled: busy }, '现在说一句'),
        ),
        h(Card, null,
          h('div', { className: 'cp-form-grid' },
            h(Field, { label: '多久掷一次（分钟）', type: 'number', value: form.intervalMinutes, onChange: function (v) { set('intervalMinutes', Number(v)) } }),
            h(Field, { label: '基础命中线（0-100）', type: 'number', value: form.hitLine, onChange: function (v) { set('hitLine', Number(v)) } }),
            h(Field, { label: '没中加成 / 次', type: 'number', value: form.missBonus, onChange: function (v) { set('missBonus', Number(v)) } }),
            h(Field, { label: '加成上限', type: 'number', value: form.bonusCap, onChange: function (v) { set('bonusCap', Number(v)) } }),
            h(Field, { label: '安静起（点）', type: 'number', value: form.quietStart, onChange: function (v) { set('quietStart', Number(v)) } }),
            h(Field, { label: '安静止（点）', type: 'number', value: form.quietEnd, onChange: function (v) { set('quietEnd', Number(v)) } }),
            h(Field, { label: '对方多久没说话才主动（分钟）', type: 'number', value: form.minIdleMinutes, onChange: function (v) { set('minIdleMinutes', Number(v)) } }),
            h(Field, { label: '自己开口后的冷却（分钟）', type: 'number', value: form.cooldownMinutes, onChange: function (v) { set('cooldownMinutes', Number(v)) } }),
            h(Field, { label: '每天最多几次（0=不限）', type: 'number', value: form.maxPerDay, onChange: function (v) { set('maxPerDay', Number(v)) } }),
          ),
          h('label', { className: 'cp-field cp-field-wide' },
            h('span', { className: 'cp-field-label' }, '触发文案（主动开口时用这段念头）'),
            h('textarea', {
              className: 'cp-editor cp-editor-sm',
              value: form.prompt,
              onChange: function (event) { set('prompt', event.target.value) },
            }),
          ),
          h('div', { className: 'cp-muted' }, '这些参数只作用于这台机器人；哪个聊天能主动开口由「会话管理」里的开关决定。'),
          h(Toolbar, null, h(Button, { primary: true, onClick: save, disabled: busy }, '保存设置')),
        ),
        h(Card, null,
          h('div', { className: 'cp-card-title' }, '搭话统计'),
          h('div', { className: 'cp-row' }, h('span', { className: 'cp-row-name' }, '命中线 ' + (pro.line == null ? '—' : pro.line) + '（基础 ' + (pro.baseLine == null ? '—' : pro.baseLine) + ' + 加成 ' + (pro.bonus || 0) + '）'), h('span', { className: 'cp-row-meta' }, '连没中 ' + (pro.misses || 0) + ' 次')),
          h('div', { className: 'cp-row' }, h('span', { className: 'cp-row-name' }, '今天已开口 ' + (pro.saidToday || 0) + '/' + (pro.maxPerDay || 0) + ' 次'), h('span', { className: 'cp-row-meta' }, '上次 ' + ago(pro.lastSpokeAt))),
          h('div', { className: 'cp-row' }, h('span', { className: 'cp-row-name' }, '安静时段 ' + (pro.quiet || '')), h('span', { className: 'cp-row-meta' }, '冷却 ' + (pro.cooldownMinutes || 0) + ' 分钟 · 空闲 ' + (pro.minIdleMinutes || 0) + ' 分钟')),
          pro.lastRoll ? h('div', { className: 'cp-row' }, h('span', { className: 'cp-row-name' }, '上次骰子'), h('span', { className: 'cp-row-meta' }, '掷出 ' + pro.lastRoll.roll + '，命中线 ' + pro.lastRoll.line + (pro.lastRoll.hit ? '（中）' : '（没中）'))) : null,
        ),
        h(Card, null,
          h('div', { className: 'cp-card-title' }, '日志'),
          (pro.logs || []).slice().reverse().slice(0, 20).map(function (row, index) {
            return h('div', { className: 'cp-logline', key: index }, h('span', { className: 'cp-logtime' }, fmtTime(row.at)), row.text)
          }),
        ),
      )
    }

    // ---- 定时激活 ---------------------------------------------------------

    var SCHEDULE_BADGE = { pending: '', done: 'cp-badge-on', cancelled: '', failed: 'cp-badge-err' }

    function waitTextOf(job) {
      var wait = Number(job.waitMinutes) || 0
      var base = wait >= 60
        ? (Math.round((wait / 60) * 10) / 10 + ' 小时')
        : (wait + ' 分钟')
      return Number(job.repeatMinutes) > 0 ? (base + '，之后每 ' + job.repeatMinutes + ' 分钟') : base
    }

    function remainingText(minutes) {
      var value = Number(minutes) || 0
      if (value <= 0) return '马上'
      if (value < 60) return value + ' 分钟后'
      var hours = Math.floor(value / 60)
      var rest = value % 60
      return hours + ' 小时' + (rest ? (' ' + rest + ' 分钟') : '') + '后'
    }

    function SchedulePanel({ botId, tick, busy, setBusy, toast }) {
      var [jobs, setJobs] = useState([])
      var [chats, setChats] = useState([])
      var [caps, setCaps] = useState({ minWaitMinutes: 1, maxWaitMinutes: 10080, maxPending: 20, maxText: 2000 })
      var [loading, setLoading] = useState(true)
      var [form, setForm] = useState({ text: '', waitMinutes: 30, repeatMinutes: 0, conversation: '' })

      var load = useCallback(async function () {
        if (!botId) { setJobs([]); setChats([]); setLoading(false); return }
        setLoading(true)
        try {
          var body = await getJson(API + '/schedule?botId=' + encodeURIComponent(botId))
          setJobs(body.jobs || [])
          setChats(body.conversations || [])
          if (body.caps) setCaps(body.caps)
          setForm(function (old) {
            var list = body.conversations || []
            var keep = old.conversation && list.some(function (row) { return row.key === old.conversation })
            if (keep) return old
            return Object.assign({}, old, { conversation: list.length ? list[0].key : '' })
          })
        } catch (err) { toast(err.message, 'error') } finally { setLoading(false) }
      }, [botId, toast])

      useEffect(function () { load() }, [load, tick])

      if (!botId) {
        return h('div', null, h(Notice, { tone: 'info' }, '定时激活只属于机器人。请先接入并选择一台机器人。'))
      }

      function setValue(key, value) {
        setForm(function (old) { return Object.assign({}, old, { [key]: value }) })
      }

      async function create() {
        if (!String(form.text || '').trim()) { toast('先写任务内容', 'error'); return }
        if (!form.conversation) { toast('这台机器人还没有聊天，先在通道里说一句话', 'error'); return }
        setBusy(true)
        try {
          await postJson(API + '/schedule', {
            action: 'create',
            botId: botId,
            conversation: form.conversation,
            text: form.text,
            waitMinutes: Number(form.waitMinutes),
            repeatMinutes: Number(form.repeatMinutes),
          })
          toast('定时任务已提交')
          setForm(function (old) { return Object.assign({}, old, { text: '' }) })
          await load()
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }

      async function act(kind, id) {
        setBusy(true)
        try {
          var result = await postJson(API + '/schedule', { action: kind, botId: botId, id: id })
          if (kind === 'fire') {
            var fired = result.result && result.result.ok
            toast(fired ? '已激活' : ('没激活：' + ((result.result && result.result.reason) || '未知')))
          } else if (kind === 'cancel') toast('已取消')
          else if (kind === 'remove') toast('记录已删除')
          await load()
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }

      var pendingCount = jobs.filter(function (job) { return job.status === 'pending' }).length
      return h('div', null,
        h(Card, null,
          h('div', { className: 'cp-card-title' }, '新建定时任务'),
          h('div', { className: 'cp-muted' }, '到点后灵犀会把任务内容重新激活到这个聊天，像收到一条新消息那样处理，回复照常发回这里。提交时间与等待间隔会留在下面的记录里。'),
          h('label', { className: 'cp-field cp-field-wide' },
            h('span', { className: 'cp-field-label' }, '任务内容'),
            h('textarea', {
              className: 'cp-editor cp-editor-sm',
              value: form.text,
              placeholder: '例如：提醒对方该喝水了；十分钟后再看看这件事。',
              onChange: function (event) { setValue('text', event.target.value) },
            }),
          ),
          h('div', { className: 'cp-form-grid' },
            h(Field, {
              label: '等待间隔（分钟）',
              type: 'number',
              value: form.waitMinutes,
              onChange: function (v) { setValue('waitMinutes', Number(v)) },
            }),
            h(Field, {
              label: '重复间隔（分钟，0 = 只激活一次）',
              type: 'number',
              value: form.repeatMinutes,
              onChange: function (v) { setValue('repeatMinutes', Number(v)) },
            }),
            h('label', { className: 'cp-field' },
              h('span', { className: 'cp-field-label' }, '目标聊天'),
              h('select', {
                className: 'cp-select',
                value: form.conversation,
                onChange: function (event) { setValue('conversation', event.target.value) },
              }, chats.length
                ? chats.map(function (row) {
                  return h('option', { key: row.key, value: row.key }, (row.title || row.key) + (row.live ? '' : '（未连接）'))
                })
                : h('option', { key: '__none', value: '' }, '还没有聊天')),
            ),
          ),
          h(Toolbar, null,
            h(Button, { primary: true, onClick: create, disabled: busy }, '提交定时任务'),
            h('span', { className: 'cp-mini' }, '等待上限 ' + Math.round((caps.maxWaitMinutes || 10080) / 60) + ' 小时；一台机器人最多 ' + (caps.maxPending || 20) + ' 条在等激活。'),
          ),
        ),
        h(Card, null,
          h('div', { className: 'cp-card-title' }, '记录（' + jobs.length + ' 条'
            + (pendingCount ? '，' + pendingCount + ' 条待激活' : '') + '）'),
          jobs.length
            ? jobs.map(function (job) {
              return h('div', { className: 'cp-sched', key: job.id },
                h('div', { className: 'cp-sched-head' },
                  h('span', { className: 'cp-badge ' + (SCHEDULE_BADGE[job.status] || '') }, job.statusText),
                  h('span', { className: 'cp-mini' }, '到 ' + (job.conversationTitle || job.conversation)),
                  h('span', { className: 'cp-flex' }),
                  job.status === 'pending'
                    ? h(Button, { onClick: function () { act('fire', job.id) }, disabled: busy }, '立即激活')
                    : null,
                  job.status === 'pending'
                    ? h(Button, { onClick: function () { act('cancel', job.id) }, disabled: busy }, '取消')
                    : null,
                  h(Button, { danger: true, onClick: function () { act('remove', job.id) }, disabled: busy }, '删除'),
                ),
                h('div', { className: 'cp-sched-text' }, job.text),
                h('div', { className: 'cp-sched-meta' },
                  h('span', null, '提交 ' + job.submittedAt),
                  h('span', null, '等待 ' + waitTextOf(job)),
                  h('span', null, job.nextFireAt
                    ? ('下次 ' + job.nextText + '（' + remainingText(job.remainingMinutes) + '）')
                    : (job.firedAt ? ('上次激活 ' + fmtTime(job.firedAt)) : '没有下次')),
                  job.fireCount ? h('span', null, '已激活 ' + job.fireCount + ' 次') : null,
                ),
                job.lastError ? h('div', { className: 'cp-row-error' }, '没激活成功：' + job.lastError) : null,
              )
            })
            : h('div', { className: 'cp-empty' }, loading ? '正在读取定时记录…' : '还没有定时任务。让灵犀在聊天里给自己定一个，或在这里提交。'),
        ),
      )
    }

    // ---- 接入新机器人（先扫码/填凭据，成功后才落库） ----------------

    function AddBotPanel({ onBack, onDone, toast, refresh }) {
      var [channel, setChannel] = useState('qq')
      var [qr, setQr] = useState(null)
      var [starting, setStarting] = useState(false)
      var [finished, setFinished] = useState(false)
      var [form, setForm] = useState({ name: '' })
      var [verifyCode, setVerifyCode] = useState('')
      useEffect(function () {
        if (!qr || finished) return undefined
        var timer = setInterval(async function () {
          try {
            var result = await postJson(API + '/bots', { action: 'provisionStatus', channel })
            setQr(result.qr || null)
            if (finished) return
            if (result.botId) {
              setFinished(true)
              toast('机器人已接入')
              refresh()
              onDone(result.botId)
              return
            }
            var failure = result.error || (result.qr && result.qr.error) || ''
            var failedState = result.status === 'error' || (result.qr && (result.qr.status === 'error' || result.qr.status === 'failed' || result.qr.status === 'expired'))
            if (failure || failedState) {
              setFinished(true)
              toast(failure || '接入失败，请重新尝试', 'error')
              onBack()
            }
          } catch { /* 继续等 */ }
        }, 1500)
        return function () { clearInterval(timer) }
      }, [channel, qr && qr.status, finished])
      async function startQr() {
        setStarting(true)
        try {
          var result = await postJson(API + '/bots', { action: 'provisionQr', channel, name: form.name })
          setQr(result.qr || null)
          var failure = result.error || (result.qr && result.qr.error) || ''
          if (failure || result.status === 'error') {
            setFinished(true)
            toast(failure || '接入失败，请重新尝试', 'error')
            onBack()
          }
        } catch (err) { toast(err.message, 'error') } finally { setStarting(false) }
      }
      async function cancel() {
        try { await postJson(API + '/bots', { action: 'cancelProvision', channel }) } catch { /* ignore */ }
        setQr(null)
        onBack()
      }
      async function changeChannel(next) {
        if (next === channel) return
        try { await postJson(API + '/bots', { action: 'cancelProvision', channel }) } catch { /* ignore */ }
        setChannel(next)
        setQr(null)
        setVerifyCode('')
      }
      async function verify() {
        setStarting(true)
        try {
          var result = await postJson(API + '/bots', { action: 'provisionVerify', channel, code: verifyCode.trim() })
          setQr(result.qr || null)
          if (result.botId && !finished) {
            setFinished(true)
            toast('机器人已接入')
            refresh()
            onDone(result.botId)
            return
          }
          var failure = result.error || (result.qr && result.qr.error) || ''
          if (failure || result.status === 'error' || (result.qr && result.qr.status === 'error')) {
            setFinished(true)
            toast(failure || '接入失败，请重新尝试', 'error')
            onBack()
            return
          }
          toast('配对码已提交，等待授权确认')
        } catch (err) { toast(err.message, 'error') } finally { setStarting(false) }
      }
      var qrReady = qr && (qr.status === 'pending' || qr.status === 'starting')
      return h('div', null,
        h('div', { className: 'cp-panel-bar' },
          h(Button, { onClick: onBack }, '返回'),
          h('span', { className: 'cp-flex' }),
          h('div', { className: 'cp-page-title' }, '接入机器人'),
        ),
        h(Card, null,
          h('div', { className: 'cp-form-grid' },
            h('label', { className: 'cp-field' },
              h('span', { className: 'cp-field-label' }, '通道'),
              h('select', { className: 'cp-select', value: channel, onChange: function (e) { changeChannel(e.target.value) } },
                h('option', { value: 'qq' }, 'QQ'),
                h('option', { value: 'feishu' }, '飞书'),
                h('option', { value: 'webhook' }, '微信'),
              ),
            ),
            h(Field, { label: '机器人名称（可选）', value: form.name, onChange: function (v) { setForm(Object.assign({}, form, { name: v })) } }),
          ),
          h('div', { className: 'cp-add-qr' },
            h('div', { className: 'cp-muted' },
              channel === 'qq'
                ? '扫码关联 QQ 机器人；成功后自动创建。'
                : channel === 'feishu'
                  ? '扫码创建或关联飞书应用；授权完成后自动创建。'
                  : '扫码授权微信；确认后自动创建。',
            ),
            h(Toolbar, null,
              h(Button, { primary: true, onClick: startQr, disabled: starting || qrReady }, qrReady ? '等待扫码 / 授权' : '生成接入二维码'),
              qrReady ? h(Button, { onClick: cancel }, '取消') : null,
            ),
            qr && qr.qrCodeDataUrl
              ? h('div', { className: 'cp-qr-box' },
                h('img', { className: 'cp-qr-image', src: qr.qrCodeDataUrl, alt: channel === 'qq' ? 'QQ 登录二维码' : channel === 'feishu' ? '飞书接入二维码' : '微信接入二维码' }),
                h('div', { className: 'cp-muted' }, channel === 'qq' ? '用手机 QQ 扫码，并在腾讯页面确认。' : channel === 'feishu' ? '用飞书扫码，创建或关联应用并完成授权。' : '用微信扫码并确认授权；如果出现配对码，请在下方提交。'),
              )
              : null,
            qr && qr.verificationRequired
              ? h('div', { className: 'cp-form-grid' },
                h(Field, { label: '微信配对码', value: verifyCode, placeholder: '输入 4-8 位数字', onChange: function (v) { setVerifyCode(v.replace(/\D/g, '').slice(0, 8)) } }),
                h('div', { className: 'cp-field' },
                  h('span', { className: 'cp-field-label' }, '授权确认'),
                  h(Button, { primary: true, onClick: verify, disabled: starting || !/^\d{4,8}$/.test(verifyCode) }, '提交配对码'),
                ),
              )
              : null,
            qr && qr.error ? h(Notice, { tone: 'error' }, qr.error) : null,
          ),
        ),
      )
    }

    // ---- 机器人（dsh-im 式账号卡片） --------------------------------

    function BotsPanel({ state, activeBotId, view = 'list', onOpen, onBack, onAdd, onSelect, busy, setBusy, toast, refresh }) {
      var bots = (state && state.bots) || []
      var selected = activeBotId || ''
      var [form, setForm] = useState(null)
      var [qr, setQr] = useState(null)
      var [newChannel, setNewChannel] = useState('qq')
      var [credentials, setCredentials] = useState({})
      var [providers, setProviders] = useState([])
      var [presets, setPresets] = useState([])
      var bot = bots.find(function (row) { return row.id === selected }) || null
      var status = (bot && bot.status) || {}
      var qrState = qr || status.qr || null
      // 机器人没设自己的称呼时回落到插件级 identity.ownerName；输入框的 placeholder 要写出这个值。
      var fallbackOwner = (state && state.identity && state.identity.ownerName) || '主人'
      useEffect(function () {
        getJson(API + '/models').then(function (result) { setProviders(result.providers || []) }).catch(function () {})
        getJson(API + '/presets').then(function (result) { setPresets(result.items || []) }).catch(function () {})
      }, [])
      useEffect(function () {
        setCredentials({})
      }, [selected])
      useEffect(function () {
        if (bot) {
          setForm({
            name: bot.name || '',
            ownerName: bot.ownerName || '',
            sessionDefaults: sessionDefaultsOf(bot),
            groupEnabled: bot.groupEnabled === true,
            busyMessageMode: bot.busyMessageMode || 'queue',
            contextEnabled: bot.contextEnhancement?.enabled === true,
            contextGuidance: bot.contextEnhancement?.guidance || '',
            contextSender: bot.contextEnhancement?.includeSender !== false,
            contextChat: bot.contextEnhancement?.includeChat !== false,
            accessMode: bot.access?.mode || 'all',
            accessUsers: (bot.access?.users || []).join('\n'),
            accessGroups: (bot.access?.groups || []).join('\n'),
          })
          setQr(bot.status && bot.status.qr ? bot.status.qr : null)
        }
      }, [selected, JSON.stringify(bots.map(function (row) {
        return [row.id, row.name, row.ownerName || '', JSON.stringify(row.sessionDefaults || {}), row.groupEnabled, row.status && row.status.state]
      }))])
      useEffect(function () {
        if (view !== 'detail' || !bot || status.state !== 'connecting') return undefined
        var timer = setInterval(function () { refresh() }, 2000)
        return function () { clearInterval(timer) }
      }, [view, selected, status.state])
      useEffect(function () {
        if (!qrState || (qrState.status !== 'pending' && qrState.status !== 'starting')) return undefined
        var timer = setInterval(function () { refresh() }, 1800)
        return function () { clearInterval(timer) }
      }, [qrState && qrState.status, selected])
      async function addBot() {
        setBusy(true)
        try {
          var result = await postJson(API + '/bots', { action: 'add', channel: newChannel, name: (newChannel === 'qq' ? 'QQ 机器人' : newChannel === 'feishu' ? '飞书机器人' : '微信机器人') })
          if (result.bot) onSelect && onSelect(result.bot.id)
          toast('已创建机器人，接下来扫码绑定')
          refresh()
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }
      async function save() {
        if (!bot || !form) return
        setBusy(true)
        try {
          const patch = {
            name: form.name,
            ownerName: String(form.ownerName || '').trim(),
            groupEnabled: form.groupEnabled === true,
            busyMessageMode: form.busyMessageMode,
            credentials,
            contextEnhancement: {
              enabled: form.contextEnabled === true,
              includeSender: form.contextSender !== false,
              includeChat: form.contextChat !== false,
              guidance: form.contextGuidance || '',
            },
            access: {
              mode: form.accessMode || 'all',
              users: String(form.accessUsers || '').split(/\n|,/).map(function (s) { return s.trim() }).filter(Boolean),
              groups: String(form.accessGroups || '').split(/\n|,/).map(function (s) { return s.trim() }).filter(Boolean),
            },
          }
          // 工作区没配齐就只存个体设置：名字、称呼、上下文这些不该被新会话默认配置卡住。
          // 缺的那段明确说没存，别让人以为存上了（服务端也照样会校验，这里只是不带它）。
          if (!missingDefaults.length) patch.sessionDefaults = form.sessionDefaults
          await postJson(API + '/bots', { action: 'update', botId: bot.id, patch: patch })
          toast(missingDefaults.length
            ? ('已保存；新会话默认配置没存，还缺：' + missingDefaults.join('、'))
            : '机器人设置已保存')
          refresh()
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }
      function setScopeDefault(scope, key, value) {
        setForm(function (old) {
          var scopes = Object.assign({}, old.sessionDefaults)
          scopes[scope] = Object.assign({}, scopes[scope], { [key]: value })
          return Object.assign({}, old, { sessionDefaults: scopes })
        })
      }
      async function startQr() {
        if (!bot) return
        setBusy(true)
        try {
          var result = await postJson(API + '/bots', { action: 'qr', botId: bot.id })
          setQr(result.qr || null)
          toast('二维码已生成，用手机 QQ 扫')
          refresh()
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }
      async function cancelQr() {
        if (!bot) return
        setBusy(true)
        try {
          await postJson(API + '/bots', { action: 'cancelQr', botId: bot.id })
          setQr(null)
          refresh()
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }
      async function reconnect() {
        if (!bot) return
        setBusy(true)
        try {
          await postJson(API + '/bots', { action: 'reconnect', botId: bot.id })
          toast('正在重连')
          refresh()
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }
      async function testConnection() {
        if (!bot) return
        setBusy(true)
        try {
          var result = await postJson(API + '/bots', { action: 'test', botId: bot.id })
          toast(result.message || '连接正常')
          refresh()
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }
      async function pickWorkspace(scope) {
        if (!bot || !form) return
        setBusy(true)
        try {
          const result = await postJson(API + '/directory/pick', {})
          if (result.path) {
            setScopeDefault(scope, 'workspace', String(result.path))
            toast(scope === 'group' ? '群聊工作区已选择' : '私聊工作区已选择')
          } else {
            toast('没有选择文件夹', 'error')
          }
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }
      async function removeBot() {
        if (!bot || !window.confirm('移除这台机器人？连接会断开，配置和状态会删除；DSH 会话本身不删除。')) return
        setBusy(true)
        try {
          await postJson(API + '/bots', { action: 'remove', botId: bot.id })
          onSelect && onSelect('')
          toast('机器人已移除')
          await refresh()
          onBack()
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }
      var canQq = bot && bot.channel === 'qq'
      var ready = Boolean(status.connected || status.configured)
      var stateLabel = status.connected ? '运行正常' : status.state === 'ready' ? '已就绪' : status.state === 'error' ? '连接失败' : status.state === 'connecting' ? '正在连接' : '未连接'
      // 新会话默认配置缺哪段：缺了就不提交这一段（见 save()），并在按钮上方说清楚。
      var missingDefaults = SCOPES.filter(function (scope) {
        return !String(((form && form.sessionDefaults && form.sessionDefaults[scope.key]) || {}).workspace || '').trim()
      }).map(function (scope) { return scope.label })
      return h('div', null,
        h('div', { className: 'cp-panel-bar' },
          view === 'detail'
            ? h(Button, { onClick: onBack }, '← 返回机器人列表')
            : h('span', { className: 'cp-mini' }, '每台机器人一条独立连接；每个聊天一个会话。'),
          h('span', { className: 'cp-flex' }),
          view === 'detail'
            ? h('span', { className: 'cp-page-title' }, (bot && bot.name) || '机器人详情')
            : h(Button, { primary: true, onClick: onAdd, disabled: busy }, '接入机器人'),
        ),
        bots.length === 0
          ? h(Card, null,
            h('div', { className: 'cp-empty' },
              h('div', { className: 'cp-card-title' }, '还没有机器人'),
              h('div', { className: 'cp-muted' }, '先接入一台 QQ 机器人。连接成功后，才会出现工作区、会话和模型设置。'),
            ),
          )
          : h('div', { className: 'cp-channel-workspace cp-bots-view-' + view },
            h('div', { className: 'cp-channel-list' },
              h('div', { className: 'cp-channel-list-hint' }, '点机器人查看详情'),
              bots.map(function (row) {
                var s = row.status || {}
                return h('button', {
                  key: row.id,
                  className: 'cp-channel-item' + (selected === row.id ? ' cp-channel-item-on' : ''),
                  onClick: function () { (onOpen || onSelect) && (onOpen || onSelect)(row.id) },
                },
                h('span', { className: 'cp-channel-item-top' },
                  h(Dot, { on: s.connected, tone: s.connected ? 'ok' : (s.state === 'error' ? 'err' : 'warn') }),
                  h('span', { className: 'cp-channel-item-name' }, row.name || row.id),
                  h('span', { className: 'cp-badge' }, row.channel === 'qq' ? 'QQ' : row.channel),
                ),
                h('span', { className: 'cp-channel-item-note' }, s.connected ? '已连接' : (s.lastError || '未连接')),
                )
              }),
            ),
            h('div', { className: 'cp-channel-detail' },
              bot
                ? h(Card, null,
                  h('div', { className: 'cp-channel-head' },
                    h(Dot, { on: ready, tone: ready ? 'ok' : (status.state === 'error' ? 'err' : 'warn') }),
                    h('div', { className: 'cp-channel-title' }, bot.name || bot.id),
                    h('span', { className: 'cp-flex' }),
                    h('span', { className: 'cp-badge' + (ready ? ' cp-badge-on' : '') }, stateLabel),
                  ),
                  status.lastError ? h(Notice, { tone: 'error' }, status.lastError) : null,
                  canQq
                    ? h(Toolbar, null,
                      h(Button, { primary: true, onClick: startQr, disabled: busy }, status.connected ? '重新扫码' : '扫码接入'),
                      qrState && (qrState.status === 'pending' || qrState.status === 'starting') ? h(Button, { onClick: cancelQr, disabled: busy }, '取消') : null,
                      h(Button, { onClick: reconnect, disabled: busy || !bot.credentials?.appId }, '重连'),
                      h('span', { className: 'cp-flex' }),
                      h(Button, { onClick: removeBot, disabled: busy }, '移除'),
                    )
                    : h('div', null,
                      h(Toolbar, null,
                        h(Button, { primary: true, onClick: testConnection, disabled: busy }, '测试连接'),
                        h('span', { className: 'cp-flex' }),
                        h(Button, { onClick: removeBot, disabled: busy }, '移除'),
                      ),
                      h(Notice, { tone: 'info' }, '这个通道用凭据/回调接入，不需要扫码；在下面填凭据后保存。'),
                    ),
                  qrState && qrState.qrCodeDataUrl
                    ? h('div', { className: 'cp-qr-box' },
                      h('img', { className: 'cp-qr-image', src: qrState.qrCodeDataUrl, alt: 'QQ 登录二维码' }),
                      h('div', { className: 'cp-muted' }, qrState.status === 'connected' ? '绑定完成。' : '用手机 QQ 扫码，并在腾讯页面确认。'),
                    )
                    : null,
                  form && (ready || bot.channel !== 'qq')
                    ? h('div', null,
                      h('div', { className: 'cp-form-grid' },
                        h(Field, { label: '机器人名称', value: form.name, onChange: function (v) { setForm(Object.assign({}, form, { name: v })) } }),
                        h(Field, {
                          label: '她怎么叫你',
                          value: form.ownerName,
                          placeholder: '留空用全局「' + fallbackOwner + '」',
                          onChange: function (v) { setForm(Object.assign({}, form, { ownerName: v })) },
                        }),
                      ),
                      h('div', { className: 'cp-muted' },
                        bot.channel === 'qq'
                          ? 'QQ 使用官方扫码登录，不需要手填凭据。'
                          : bot.channel === 'feishu'
                            ? '飞书使用自建应用凭据。'
                            : bot.credentials?.token
                              ? '当前为原生 iLink 模式：不需要出站地址和共享密钥。'
                              : '当前为桥接模式：需要出站地址和共享密钥。',
                      ),
                      h('div', { className: 'cp-form-grid' },
                        bot.channel === 'feishu' ? h(Field, { label: '飞书 App ID', value: credentials.appId || '', placeholder: bot.credentials?.appId ? '已设置，留空不改' : '', onChange: function (v) { setCredentials(Object.assign({}, credentials, { appId: v })) } }) : null,
                        bot.channel === 'feishu' ? h(Field, { label: '飞书 App Secret', value: credentials.appSecret || '', placeholder: bot.credentials?.appSecret ? '已设置，留空不改' : '', onChange: function (v) { setCredentials(Object.assign({}, credentials, { appSecret: v })) } }) : null,
                        bot.channel === 'feishu' ? h(Field, { label: 'Verification Token', value: credentials.verificationToken || '', placeholder: bot.credentials?.verificationToken ? '已设置，留空不改' : '', onChange: function (v) { setCredentials(Object.assign({}, credentials, { verificationToken: v })) } }) : null,
                        bot.channel === 'feishu' ? h(Field, { label: 'Encrypt Key', value: credentials.encryptKey || '', placeholder: bot.credentials?.encryptKey ? '已设置，留空不改' : '', onChange: function (v) { setCredentials(Object.assign({}, credentials, { encryptKey: v })) } }) : null,
                        bot.channel === 'webhook' && !bot.credentials?.token
                          ? h(Field, { label: '出站地址（桥接模式）', value: credentials.outboundUrl || '', placeholder: bot.credentials?.outboundUrl ? '已设置，留空不改' : 'https://…', onChange: function (v) { setCredentials(Object.assign({}, credentials, { outboundUrl: v })) } })
                          : null,
                        bot.channel === 'webhook' && !bot.credentials?.token
                          ? h(Field, { label: '共享密钥（桥接模式）', value: credentials.secret || '', placeholder: bot.credentials?.secret ? '已设置，留空不改' : '', onChange: function (v) { setCredentials(Object.assign({}, credentials, { secret: v })) } })
                          : null,
                      ),
                      h(Disclosure, { title: '新会话默认配置', summary: '私聊 / 群聊各五项；缺工作区就跳过这一段', open: true },
                        h('div', { className: 'cp-muted' }, '新会话按私聊 / 群聊分别取这里的工作区、Preset、模型和默认权限。缺工作区时这一段不提交，其余设置照常保存；新建会话时会往那个聊天回一句缺什么。'),
                        h('div', { className: 'cp-scope-grid' }, SCOPES.map(function (scope) {
                          var row = form.sessionDefaults[scope.key] || blankScopeDefault()
                          var dirty = String(row.workspace || '') !== String((bot.sessionDefaults && bot.sessionDefaults[scope.key] && bot.sessionDefaults[scope.key].workspace) || '')
                          return h('div', { className: 'cp-scope-block', key: scope.key },
                            h('div', { className: 'cp-scope-head' },
                              h('span', { className: 'cp-scope-title' }, scope.label),
                              h('span', { className: 'cp-badge' + (String(row.workspace || '').trim() ? ' cp-badge-on' : '') }, String(row.workspace || '').trim() ? '已配置' : '缺工作区'),
                              h('span', { className: 'cp-flex' }),
                              h('span', { className: 'cp-mini' }, scope.hint),
                            ),
                            h('label', { className: 'cp-field' },
                              h('span', { className: 'cp-field-label' }, scope.label + '工作区'),
                              h('div', { className: 'cp-addrow' },
                                h('input', { className: 'cp-input', value: row.workspace || '', readOnly: true, placeholder: '点击选择文件夹' }),
                                h(Button, { onClick: function () { pickWorkspace(scope.key) }, disabled: busy }, row.workspace ? '更换' : '选择'),
                              ),
                              dirty ? h('span', { className: 'cp-field-hint' }, '改动未保存') : null,
                            ),
                            h('label', { className: 'cp-field' },
                              h('span', { className: 'cp-field-label' }, scope.label + '默认权限'),
                              h('select', { className: 'cp-select', value: row.defaultPermission, onChange: function (e) { setScopeDefault(scope.key, 'defaultPermission', e.target.value) } },
                                PERMISSIONS.map(function (item) { return h('option', { key: item.value, value: item.value }, item.label) }),
                              ),
                            ),
                            h('label', { className: 'cp-field' },
                              h('span', { className: 'cp-field-label' }, scope.label + ' Agent Preset'),
                              h('select', { className: 'cp-select', value: row.preset, onChange: function (e) { setScopeDefault(scope.key, 'preset', e.target.value) } },
                                h('option', { value: '' }, '跟随 Host 默认'),
                                presets.map(function (p) { return h('option', { key: p.id, value: p.id }, p.name || p.id) }),
                              ),
                            ),
                            h('label', { className: 'cp-field' },
                              h('span', { className: 'cp-field-label' }, scope.label + '模型'),
                              h('select', {
                                className: 'cp-select',
                                value: row.provider && row.model ? row.provider + '::' + row.model : '',
                                onChange: function (e) {
                                  var value = e.target.value
                                  if (!value) {
                                    setScopeDefault(scope.key, 'provider', '')
                                    setScopeDefault(scope.key, 'model', '')
                                    return
                                  }
                                  var split = value.split('::')
                                  setScopeDefault(scope.key, 'provider', split[0])
                                  setScopeDefault(scope.key, 'model', split.slice(1).join('::'))
                                },
                              },
                              h('option', { value: '' }, '跟随默认模型'),
                              providers.filter(function (p) { return (p.models || []).length > 0 }).map(function (p) {
                                return h('optgroup', { key: p.id, label: p.name || p.id },
                                  (p.models || []).map(function (m) {
                                    return h('option', { key: p.id + '::' + m.id, value: p.id + '::' + m.id }, m.name || m.id)
                                  }),
                                )
                              }),
                              ),
                            ),
                          )
                        })),
                        h('div', { className: 'cp-muted' }, '权限、Preset 和模型只在新建会话时生效；换绑已有会话不改写它的 DSH 配置。'),
                      ),
                      h(Disclosure, { title: '群聊开关', summary: '是否接收群消息' },
                        h('div', { className: 'cp-form-grid' },
                          h('label', { className: 'cp-field cp-field-check' },
                            h('input', {
                              type: 'checkbox',
                              checked: form.groupEnabled === true,
                              onChange: function (e) { setForm(Object.assign({}, form, { groupEnabled: e.target.checked })) },
                            }),
                            h('span', { className: 'cp-field-label' }, '允许群聊'),
                          ),
                        ),
                        h('div', { className: 'cp-muted' }, '关掉后群里消息不处理；群聊会话还需要在「新会话默认配置」里配好群聊工作区。'),
                      ),
                      h(Disclosure, { title: '消息处理', summary: '忙碌时排队或插话' },
                        h('div', { className: 'cp-form-grid' },
                          h('label', { className: 'cp-field' },
                            h('span', { className: 'cp-field-label' }, '消息处理方式'),
                            h('select', { className: 'cp-select', value: form.busyMessageMode, onChange: function (e) { setForm(Object.assign({}, form, { busyMessageMode: e.target.value })) } },
                              h('option', { value: 'queue' }, '排队：当前任务结束后处理'),
                              h('option', { value: 'steer' }, '插话：并入当前任务'),
                            ),
                          ),
                        ),
                      ),
                      h(Disclosure, { title: '上下文增强', summary: '默认关闭' },
                        h('label', { className: 'cp-field cp-field-check' },
                          h('input', { type: 'checkbox', checked: form.contextEnabled === true, onChange: function (e) { setForm(Object.assign({}, form, { contextEnabled: e.target.checked })) } }),
                          h('span', { className: 'cp-field-label' }, '在消息前附上渠道/发送者/会话等来源信息（时间总是会带）'),
                        ),
                        h('div', { className: 'cp-inline-checks' },
                          h('label', { className: 'cp-field-check' }, h('input', { type: 'checkbox', checked: form.contextSender !== false, onChange: function (e) { setForm(Object.assign({}, form, { contextSender: e.target.checked })) } }), h('span', null, '发送者')),
                          h('label', { className: 'cp-field-check' }, h('input', { type: 'checkbox', checked: form.contextChat !== false, onChange: function (e) { setForm(Object.assign({}, form, { contextChat: e.target.checked })) } }), h('span', null, '会话')),
                        ),
                        h('textarea', {
                          className: 'cp-textarea', rows: 3, placeholder: '可选：增强提示词，例如“群聊里只回答被 @ 的问题”',
                          value: form.contextGuidance || '',
                          onChange: function (e) { setForm(Object.assign({}, form, { contextGuidance: e.target.value })) },
                        }),
                      ),
                      h(Disclosure, { title: '访问控制', summary: '默认所有人' },
                        h('label', { className: 'cp-field' },
                          h('span', { className: 'cp-field-label' }, '模式'),
                          h('select', { className: 'cp-select', value: form.accessMode, onChange: function (e) { setForm(Object.assign({}, form, { accessMode: e.target.value })) } },
                            h('option', { value: 'all' }, '所有人'),
                            h('option', { value: 'allow' }, '只允许名单内'),
                            h('option', { value: 'block' }, '拒绝名单内'),
                          ),
                        ),
                        h('div', { className: 'cp-form-grid' },
                          h('label', { className: 'cp-field' }, h('span', { className: 'cp-field-label' }, '私聊用户 ID（每行一个）'),
                            h('textarea', { className: 'cp-textarea', rows: 3, value: form.accessUsers || '', onChange: function (e) { setForm(Object.assign({}, form, { accessUsers: e.target.value })) } })),
                          h('label', { className: 'cp-field' }, h('span', { className: 'cp-field-label' }, '群 ID（每行一个）'),
                            h('textarea', { className: 'cp-textarea', rows: 3, value: form.accessGroups || '', onChange: function (e) { setForm(Object.assign({}, form, { accessGroups: e.target.value })) } })),
                        ),
                      ),
                      h('div', { className: 'cp-muted' }, '保存后对后续消息生效；会话忙碌时按「消息处理」里的选项排队或插话。'),
                      missingDefaults.length
                        ? h('div', { className: 'cp-muted' }, '新会话默认配置还缺：' + missingDefaults.join('、')
                          + '。现在点保存只存名字、称呼、消息处理这些个体设置，这一段不会提交。')
                        : null,
                      h(Toolbar, null,
                        h(Button, { primary: true, onClick: save, disabled: busy }, '保存设置'),
                      ),
                    )
                    : h(Notice, { tone: 'info' }, '连接成功后才能配置新会话默认。'),
                )
                : h(Card, null, h('div', { className: 'cp-muted' }, '选一个机器人')),
            ),
          ),
        h(Notice, { tone: 'info' }, '新会话默认配置只管之后新建的会话；已有会话在「会话管理」里。'),
      )
    }

    // ---- 语音（全局） ------------------------------------------------------

    function VoicePanel({ state, voice, voiceLoading, reloadVoice, busy, setBusy, toast, refresh }) {
      var configVoice = ((state && state.config && state.config.voice) || {})
      var apiKeySet = Boolean(state && state.secretSet && state.secretSet['voice.apiKey'])
      var [form, setForm] = useState({
        enabled: configVoice.enabled !== false,
        provider: configVoice.provider || 'auto',
        endpoint: configVoice.endpoint || '',
        apiKey: '',
        model: configVoice.model || 'tts-1',
        voice: configVoice.voice || 'alloy',
        format: configVoice.format || 'mp3',
        prompt: configVoice.prompt || '',
      })
      var [sample, setSample] = useState('')
      var [audio, setAudio] = useState('')
      var [lastResult, setLastResult] = useState(null)
      var status = (voice && voice.voice) || null
      var promptStatus = (status && status.prompt) || {}
      var customPrompt = String(form.prompt || '').trim()
      // 「开不开」不在这里：总闸与每个聊天的开关都在「会话管理 → 主动语音」，
      // 这一页只放提示词本身（折叠起来，别把整段规则摊在页面上）。
      var promptSummary = customPrompt ? ('已自定义 · ' + customPrompt.length + ' 字') : '使用默认规则'
      // 提示词框默认就把内置规则填进去（和斗图那边一样：先看到默认文本，再在上面改），
      // 存的时候与默认一致就写回空串，语义仍是「用内置默认规则」。
      var defaultPrompt = String(promptStatus.defaultText || '')
      var [promptTouched, setPromptTouched] = useState(false)
      var promptValue = form.prompt || (promptTouched ? '' : defaultPrompt)
      // 来源设置同样折起来，摘要直接写「现在会走哪个来源 + 音色」，折上也能看明白。
      var effectiveSource = (form.provider === 'openai' || (form.provider === 'auto' && String(form.endpoint || '').trim()))
        ? 'openai'
        : 'xiaomi'
      var sourceSummary = (effectiveSource === 'openai' ? '自定义 TTS' : '宿主语音朗读')
        + (form.provider === 'auto' ? '（自动）' : '')
        + ' · ' + form.model + ' / ' + form.voice + ' · ' + form.format
      function set(key, value) { setForm(function (old) { return Object.assign({}, old, { [key]: value }) }) }
      function kb(bytes) {
        var value = Number(bytes) || 0
        if (value <= 0) return '0 KB'
        return Math.max(1, Math.round(value / 1024)) + ' KB'
      }

      async function save() {
        setBusy(true)
        try {
          // 与内置默认规则一字不差时存空串：这样摘要仍显示「使用默认规则」，
          // 以后改了默认规则也会跟着生效，而不是把旧默认固化成自定义。
          var prompt = String(form.prompt || '')
          if (prompt.trim() === defaultPrompt.trim()) prompt = ''
          await postJson(API + '/config', { config: { voice: Object.assign({}, form, { prompt: prompt }) } })
          setPromptTouched(prompt !== '')
          set('prompt', prompt)
          toast('语音设置已保存')
          refresh()
          if (reloadVoice) await reloadVoice()
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }
      async function test() {
        setBusy(true)
        try {
          var result = await postJson(API + '/voice', { text: sample || '这是一句测试语音，能听到就说明通了。' })
          setLastResult({ at: Date.now(), source: result.source, format: result.format, bytes: result.bytes })
          if (result.audio) {
            setAudio(result.audio)
            try { new Audio(result.audio).play() } catch (e) { /* 浏览器拦截自动播放 */ }
          }
          toast('合成成功，' + kb(result.bytes))
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }

      function sourceLabel(value) {
        return value === 'openai' ? '自定义 OpenAI 兼容 TTS' : (value === 'xiaomi' ? '宿主语音朗读（dsh-xiaomi-tts）' : value || '—')
      }
      return h('div', null,
        h('div', { className: 'cp-panel-bar' },
          h('span', { className: 'cp-mini' }, '全插件共用的合成设置；发给哪个聊天在「当前机器人 → 语音条」（仅 QQ）。'),
          h('span', { className: 'cp-flex' }),
          voiceLoading ? h('span', { className: 'cp-mini' }, '正在检测…') : null,
          h(Button, { onClick: function () { reloadVoice && reloadVoice() }, disabled: busy || voiceLoading }, '重新检测'),
          status ? h('span', { className: 'cp-badge' }, '检测于 ' + fmtTime(status.checkedAt)) : null,
        ),
        h(Card, null,
          h('div', { className: 'cp-channel-head' },
            h(Dot, { on: form.enabled && Boolean(status && (status.effective === 'openai' || status.xiaomi.available)), tone: form.enabled ? 'ok' : 'off' }),
            h('div', { className: 'cp-channel-title' }, '合成状态'),
            h('span', { className: 'cp-flex' }),
            h(Toggle, { label: '启用语音合成', value: form.enabled, onChange: function (v) { set('enabled', v) } }),
          ),
          !status
            ? h('div', { className: 'cp-muted' }, voiceLoading ? '正在检测宿主朗读路由…' : '还没有检测结果。')
            : h('div', null,
              h('div', { className: 'cp-row' },
                h('span', { className: 'cp-row-name' }, '实际会用的来源：' + sourceLabel(status.effective)),
                h('span', { className: 'cp-row-meta' }, status.provider === 'auto' ? '配置为自动' : ('配置为 ' + status.provider)),
              ),
              status.effective === 'xiaomi'
                ? h('div', { className: 'cp-row' },
                  h('span', { className: 'cp-row-name' }, '宿主朗读路由：' + (status.xiaomi.available ? '可用' : '不可用')),
                  h('span', { className: 'cp-row-meta cp-ellipsis' }, status.xiaomi.available ? status.xiaomi.route : (status.xiaomi.error || '未知')),
                )
                : null,
              status.effective === 'openai'
                ? h('div', { className: 'cp-row' },
                  h('span', { className: 'cp-row-name' }, '自定义 TTS：' + (status.custom.configured ? status.custom.endpoint : '没有填地址')),
                  h('span', { className: 'cp-row-meta' }, 'API Key ' + (status.apiKeySet ? '已设置' : '未设置') + ' · 模型 ' + status.model + ' · 音色 ' + status.voice + ' · ' + status.format),
                )
                : null,
              status.fallback
                ? h('div', { className: 'cp-muted' }, '宿主朗读失败时会自动改用自定义 TTS（' + status.custom.endpoint + '）。')
                : null,
              h('div', { className: 'cp-row' },
                h('span', { className: 'cp-row-name' }, '超时 ' + Math.round(status.timeoutMs / 1000) + ' 秒 · 临时目录 ' + status.dir),
                h('span', { className: 'cp-row-meta' }, '残留文件 ' + status.temp.count + ' 个 / ' + kb(status.temp.bytes)),
              ),
            ),
        ),
        h(Card, null,
          h(Disclosure, { title: '合成来源设置', summary: sourceSummary, flat: true },
            h('div', { className: 'cp-muted' }, '来源留空时借宿主「语音朗读」路由（dsh-xiaomi-tts）；填了 TTS 地址就用自己的 OpenAI 兼容服务。'),
            h('div', { className: 'cp-form-grid' },
              h('label', { className: 'cp-field' },
                h('span', { className: 'cp-field-label' }, '来源'),
                h('select', { className: 'cp-select', value: form.provider, onChange: function (event) { set('provider', event.target.value) } },
                  h('option', { value: 'auto' }, '自动（有地址用自己的，否则借宿主）'),
                  h('option', { value: 'xiaomi' }, '只用宿主语音朗读'),
                  h('option', { value: 'openai' }, '只用 OpenAI 兼容 TTS'),
                ),
              ),
              h(Field, { label: 'TTS 地址', value: form.endpoint, placeholder: '留空 = 借宿主', onChange: function (v) { set('endpoint', v) } }),
              h(Field, {
                label: 'API Key',
                value: form.apiKey,
                placeholder: apiKeySet ? '已设置，留空不改' : '按服务要求填',
                onChange: function (v) { set('apiKey', v) },
              }),
              h(Field, { label: '模型', value: form.model, onChange: function (v) { set('model', v) } }),
              h(Field, { label: '音色', value: form.voice, onChange: function (v) { set('voice', v) } }),
              h('label', { className: 'cp-field' },
                h('span', { className: 'cp-field-label' }, '格式'),
                h('select', { className: 'cp-select', value: form.format, onChange: function (event) { set('format', event.target.value) } },
                  h('option', { value: 'mp3' }, 'mp3'),
                  h('option', { value: 'wav' }, 'wav'),
                ),
              ),
            ),
            h(Toolbar, null, h(Button, { primary: true, onClick: save, disabled: busy }, '保存语音设置')),
          ),
        ),
        // 提示词是「设置」，但与合成无关；整段规则很长，折起来，页面上只留一行摘要。
        h(Card, null,
          h(Disclosure, { title: '主动语音提示词', summary: promptSummary, flat: true },
            h('div', { className: 'cp-muted' }, '写她在什么时机、用什么语气发语音；框里是当前生效的规则，直接改就行。开关在「会话管理 → 主动语音」。'),
            h('label', { className: 'cp-field' },
              h('span', { className: 'cp-field-label' }, '提示词'),
              h('textarea', {
                className: 'cp-textarea',
                rows: 8,
                placeholder: '正在载入默认规则…',
                value: promptValue,
                onChange: function (event) {
                  setPromptTouched(true)
                  set('prompt', event.target.value)
                },
              }),
            ),
            h('div', { className: 'cp-row' },
              h('span', { className: 'cp-row-name' }, '上次发语音：' + ago(promptStatus.lastSentAt)),
              h('span', { className: 'cp-row-meta' }, '刚发过会压一句「先用文字」（' + (promptStatus.pacingMinutes || 10) + ' 分钟内）'),
            ),
            h(Toolbar, null,
              h(Button, {
                onClick: function () {
                  setPromptTouched(false)
                  set('prompt', '')
                },
                disabled: busy || !customPrompt,
              }, '恢复默认规则'),
              h(Button, { primary: true, onClick: save, disabled: busy }, '保存提示词'),
            ),
          ),
        ),
        h(Card, null,
          h('div', { className: 'cp-card-title' }, '试听'),
          h('div', { className: 'cp-addrow' },
            h('input', {
              className: 'cp-input',
              value: sample,
              placeholder: '试听说一句…（留空用默认测试句）',
              onChange: function (event) { setSample(event.target.value) },
            }),
            h(Button, { onClick: test, disabled: busy }, '合成试听'),
          ),
          audio ? h('audio', { controls: true, src: audio, style: { width: '100%', marginTop: '8px' } }) : null,
          lastResult
            ? h('div', { className: 'cp-muted' }, '最近一次：' + fmtTime(lastResult.at) + ' · ' + sourceLabel(lastResult.source) + ' · ' + lastResult.format + ' · ' + kb(lastResult.bytes))
            : null,
        ),
        h(Notice, { tone: 'info' }, '试听只在浏览器里播放，不会发到聊天里；要真发出去用「当前机器人 → 语音条」。'),
      )
    }

    // ---- 语音条（当前机器人；只有 QQ 官方 Bot 有这条能力） -------------------

    function VoiceSendPanel({ state, botId, voice, voiceLoading, reloadVoice, busy, setBusy, toast }) {
      var bots = (state && state.bots) || []
      var local = bots.find(function (row) { return row.id === botId }) || null
      var bot = (voice && voice.bot) || local
      var status = (voice && voice.voice) || null
      var targets = (voice && voice.targets) || []
      var readyTargets = targets.filter(function (row) { return row.ready })
      // 主动语音只在这台是 QQ 机器人时才注入；状态要能区分「合成关着」和「主动语音关着」。
      function promptRowText(info) {
        if (!info || !info.prompt) return '未知'
        if (!info.enabled) return '合成关着'
        if (!info.prompt.promptEnabled) return '已关闭'
        return '已开启（' + (info.prompt.custom ? '自定义规则' : '默认规则') + '）'
      }
      var [sample, setSample] = useState('')
      var [audio, setAudio] = useState('')
      var [sendTo, setSendTo] = useState('')
      var [lastResult, setLastResult] = useState(null)
      function kb(bytes) {
        var value = Number(bytes) || 0
        if (value <= 0) return '0 KB'
        return Math.max(1, Math.round(value / 1024)) + ' KB'
      }

      if (!bot) {
        return h('div', null, h(Notice, { tone: 'info' }, '语音条只属于 QQ 官方 Bot 机器人。先在左边「当前机器人」里选一台 QQ 机器人。'))
      }
      if (bot.channel !== 'qq') {
        return h('div', null, h(Notice, { tone: 'info' }, (bot.name || bot.id) + ' 是「' + (CHANNEL_LABEL[bot.channel] || bot.channel) + '」机器人：目前只有 QQ 官方 Bot 能发语音条。'))
      }
      var botStatus = bot.status || {}
      var synthReady = Boolean(status && status.enabled && (status.effective === 'openai' ? true : status.xiaomi.available))

      async function send() {
        setBusy(true)
        try {
          var result = await postJson(API + '/voice', {
            text: sample || '这是一句测试语音，能听到就说明通了。',
            sendTo: sendTo,
            botId: bot.id,
          })
          setLastResult({
            at: Date.now(), source: result.source, format: result.format, bytes: result.bytes,
            sent: result.sent ? { ok: result.sent.ok === true, messageId: result.sent.messageId || '' } : null,
          })
          if (result.audio) {
            setAudio(result.audio)
            try { new Audio(result.audio).play() } catch (e) { /* 浏览器拦截自动播放 */ }
          }
          toast('语音条已发出（' + kb(result.bytes) + '）')
          if (reloadVoice) await reloadVoice()
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }

      return h('div', null,
        h('div', { className: 'cp-panel-bar' },
          h('span', { className: 'cp-mini' }, '这台 QQ 机器人能把语音条发到哪些聊天；合成来源与音色在「全局设置 → 语音」。'),
          h('span', { className: 'cp-flex' }),
          voiceLoading ? h('span', { className: 'cp-mini' }, '正在检测…') : null,
          h(Button, { onClick: function () { reloadVoice && reloadVoice() }, disabled: busy || voiceLoading }, '重新检测'),
          h('span', { className: 'cp-badge' }, (bot.name || bot.id) + ' · QQ'),
        ),
        botStatus.lastError ? h(Notice, { tone: 'error' }, botStatus.lastError) : null,
        h(Card, null,
          h('div', { className: 'cp-card-title' }, '这条通道的状态'),
          h('div', { className: 'cp-row' },
            h(Dot, { on: Boolean(botStatus.connected), tone: botStatus.connected ? 'ok' : 'warn' }),
            h('span', { className: 'cp-row-name' }, 'QQ 官方 Bot：' + (botStatus.connected ? '已连接' : (botStatus.bound ? '已绑定、未连接' : '还没绑定'))),
            h('span', { className: 'cp-row-meta' }, botStatus.appId ? ('AppID ' + botStatus.appId) : '还没有凭据'),
          ),
          h('div', { className: 'cp-row' },
            h('span', { className: 'cp-row-name' }, '合成：' + (!status ? '未知' : (synthReady ? '可用（' + (status.effective === 'openai' ? '自定义 TTS' : '宿主朗读') + '）' : '不可用'))),
            h('span', { className: 'cp-row-meta' }, status && !status.enabled
              ? '在「全局设置 → 语音」里关着'
              : (status && status.effective === 'xiaomi' && !status.xiaomi.available ? '宿主朗读路由不可用' : '')),
          ),
          h('div', { className: 'cp-row' },
            h('span', { className: 'cp-row-name' }, '可发语音的聊天 ' + readyTargets.length + ' / ' + targets.length),
            h('span', { className: 'cp-row-meta' }, '先在那个人/群里说一句话，会话才有回复目标'),
          ),
          h('div', { className: 'cp-row' },
            h('span', { className: 'cp-row-name' }, '主动语音：' + promptRowText(status)),
            h('span', { className: 'cp-row-meta' }, '上次发语音 ' + ago(status && status.prompt && status.prompt.lastSentAt)),
          ),
          !synthReady
            ? h('div', { className: 'cp-muted' }, '先去「全局设置 → 语音」把合成弄通（启用 + 来源可用），否则这里发不出去。')
            : null,
        ),
        h(Card, null,
          h('div', { className: 'cp-card-title' }, '这台机器人的 QQ 聊天'),
          targets.length === 0
            ? h('div', { className: 'cp-muted' }, '还没有 QQ 聊天。用 QQ 给这台机器人发一句话，会话会自动出现，然后就能发语音条了。')
            : targets.map(function (row) {
              return h('div', { className: 'cp-row', key: row.key },
                h(Dot, { on: row.ready, tone: row.ready ? 'ok' : 'warn' }),
                h('span', { className: 'cp-row-name cp-ellipsis' }, row.title || row.key),
                h('span', { className: 'cp-row-meta' }, (row.scope === 'group' ? '群聊' : '私聊') + ' · ' + (row.peerId || '—')
                  + ' · ' + (row.ready ? '可发送' : '没有回复目标') + ' · 对方 ' + ago(row.lastHumanAt)),
              )
            }),
        ),
        h(Card, null,
          h('div', { className: 'cp-card-title' }, '试听与发送'),
          h('div', { className: 'cp-addrow' },
            h('input', {
              className: 'cp-input',
              value: sample,
              placeholder: '要念的话…（留空用默认测试句）',
              onChange: function (event) { setSample(event.target.value) },
            }),
          ),
          h('div', { className: 'cp-addrow' },
            h('select', {
              className: 'cp-select',
              value: sendTo,
              onChange: function (event) { setSendTo(event.target.value) },
            },
            h('option', { value: '' }, readyTargets.length ? '自动：最近说过话的 QQ 聊天' : '还没有可发送的 QQ 聊天'),
            targets.map(function (row) {
              return h('option', { key: row.key, value: row.key, disabled: !row.ready },
                (row.title || row.key) + (row.ready ? '' : '（没有回复目标）'))
            }),
            ),
            h(Button, { onClick: send, disabled: busy || readyTargets.length === 0 }, '合成并发送语音条'),
          ),
          h('div', { className: 'cp-muted' }, '语音条单独发一条，文字回复照常走会话；发送失败会显示通道给的原因。'),
          audio ? h('audio', { controls: true, src: audio, style: { width: '100%', marginTop: '8px' } }) : null,
          lastResult
            ? h('div', { className: 'cp-muted' }, '最近一次：' + fmtTime(lastResult.at) + ' · ' + lastResult.format + ' · ' + kb(lastResult.bytes)
              + (lastResult.sent ? (lastResult.sent.ok ? ' · 已发出' : ' · 发送失败') : ''))
            : null,
        ),
        h(Notice, { tone: 'info' }, '模型也会发语音条：开着「主动语音」时，她按「语音」页的提示词自己发。'),
      )
    }

    // ---- 斗图 -------------------------------------------------------------

    function MemePanel({ meme, memeLoading, reloadMeme, busy, setBusy, toast }) {
      var status = meme || null
      var [enabled, setEnabled] = useState(status ? status.enabled !== false : true)
      var [maxImages, setMaxImages] = useState((status && status.maxImages) || 4)
      useEffect(function () {
        if (!status) return
        setEnabled(status.enabled !== false)
        setMaxImages(Number(status.maxImages) || 4)
      }, [status])

      function baseName(path) {
        var parts = String(path || '').split(/[\\/]/)
        return parts[parts.length - 1] || String(path || '')
      }
      function kb(count) { return String(Number(count) || 0) + ' 张' }

      async function save() {
        setBusy(true)
        try {
          await postJson(API + '/meme', { enabled: enabled, maxImages: maxImages })
          toast('斗图设置已保存')
          if (reloadMeme) await reloadMeme(true)
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }

      var stats = (status && status.stats) || {}
      var packs = (status && status.packs) || []
      var roots = (status && status.roots) || []
      var available = Boolean(status && status.available)

      return h('div', null,
        h('div', { className: 'cp-panel-bar' },
          h('span', { className: 'cp-mini' }, '表情包图库与发图规则；图库来自 dsh-meme，QQ / 微信 / 飞书共用。'),
          h('span', { className: 'cp-flex' }),
          memeLoading ? h('span', { className: 'cp-mini' }, '正在扫描图库…') : null,
          h(Button, { onClick: function () { if (reloadMeme) reloadMeme(true) }, disabled: busy || memeLoading }, '重新扫描'),
        ),

        h(Card, null,
          h('div', { className: 'cp-channel-head' },
            h(Dot, { on: available && enabled, tone: available && enabled ? 'ok' : 'warn' }),
            h('div', { className: 'cp-channel-title' }, '斗图状态'),
            h('span', { className: 'cp-flex' }),
            h(Toggle, {
              label: '把 [表情: 描述] 发成原生图片',
              value: enabled,
              onChange: function (value) { setEnabled(value) },
            }),
          ),
          !status
            ? h('div', { className: 'cp-muted' }, memeLoading ? '正在扫描图库…' : '还没有扫描结果。')
            : h('div', null,
              h('div', { className: 'cp-stat-grid' },
                h(Stat, { label: '图库', value: String(packs.length), sub: available ? '已启用索引' : '没找到图库' }),
                h(Stat, { label: '可用图片', value: kb(status.total) }),
                h(Stat, { label: '已转成图片', value: String(Number(stats.images) || 0) + ' 张' }),
                h(Stat, {
                  label: '配不上的描述',
                  value: String(Number(stats.missedTotal) || 0),
                  sub: stats.lastMissAt ? fmtTime(stats.lastMissAt) : '',
                }),
              ),
              available
                ? h('div', { className: 'cp-row' },
                  h('span', { className: 'cp-row-name' },
                    '最近一次发送：' + (stats.lastAt ? fmtTime(stats.lastAt) : '还没有'),
                  ),
                  h('span', { className: 'cp-row-meta cp-ellipsis', title: stats.lastPath || '' },
                    stats.lastCaption
                      ? (stats.lastCaption + (stats.lastPath ? ' · ' + baseName(stats.lastPath) : ''))
                      : '—',
                  ),
                )
                : h('div', null,
                  h(Notice, { tone: 'warn' }, '没找到 dsh-meme 的图库索引：先装好 dsh-meme 并在它的设置页里放几张图，或者把图库目录指到下面列出的位置之一。'),
                  h('div', { className: 'cp-muted' }, '找过这些位置：'),
                  roots.map(function (row) {
                    return h('div', { className: 'cp-row', key: row.dir },
                      h('span', { className: 'cp-row-name cp-ellipsis', title: row.dir }, row.dir),
                      h('span', { className: 'cp-row-meta' }, row.exists ? '存在' : '不存在'),
                    )
                  }),
                ),
              stats.lastMissed
                ? h('div', { className: 'cp-row' },
                  h('span', { className: 'cp-row-name' }, '最近没配上的描述'),
                  h('span', { className: 'cp-row-meta cp-ellipsis' }, stats.lastMissed),
                )
                : null,
            ),
        ),

        h(Card, null,
          h('div', { className: 'cp-card-title' }, '发送规则'),
          h('div', { className: 'cp-muted' }, '配上的表情包会作为原生图片消息发出；配不上的描述会被丢掉，只留正文。'),
          h('div', { className: 'cp-form-grid' },
            h('label', { className: 'cp-field' },
              h('span', { className: 'cp-field-label' }, '单轮最多发几张'),
              h('select', {
                className: 'cp-select',
                value: String(maxImages),
                onChange: function (event) { setMaxImages(Number(event.target.value)) },
              },
              [1, 2, 3, 4].map(function (n) { return h('option', { key: n, value: String(n) }, String(n) + ' 张') }),
              ),
            ),
          ),
          h('div', { className: 'cp-panel-bar' },
            h('span', { className: 'cp-mini' }, '「发送方式」（自动 / 纯文字 / 图片）在 dsh-meme 的设置页里。'),
            h('span', { className: 'cp-flex' }),
            h(Button, { primary: true, onClick: save, disabled: busy || !status }, '保存'),
          ),
        ),

        h(Card, null,
          h('div', { className: 'cp-card-title' }, '图库'),
          !packs.length
            ? h('div', { className: 'cp-muted' }, '还没有可用的图库。')
            : packs.map(function (pack) {
              return h('div', { className: 'cp-row', key: pack.dir },
                h('span', { className: 'cp-row-name' }, pack.name + ' · ' + pack.id),
                h('span', { className: 'cp-row-meta' }, kb(pack.count) + (pack.tags.length ? ' · ' + pack.tags.join(' / ') : '')),
              )
            }),
        ),
        h(Notice, { tone: 'info' }, '模型选图后写 [表情: 描述]；发送前会按描述在图库里换成真实图片。'),
      )
    }

    // ---- 日志 -------------------------------------------------------------

    function LogsPanel({ busy, setBusy, toast }) {
      var [lines, setLines] = useState([])
      var [path, setPath] = useState('')
      var load = useCallback(async function () {
        setBusy(true)
        try {
          var body = await getJson(API + '/diag?lines=300')
          setLines(body.lines || [])
          setPath(body.path || '')
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }, [setBusy, toast])
      useEffect(function () { load() }, [load])
      return h('div', null,
        h('div', { className: 'cp-panel-bar' },
          h('span', { className: 'cp-mini' }, '插件自己的诊断日志。'),
          h('span', { className: 'cp-flex' }),
          h(Button, { onClick: load, disabled: busy }, '刷新'),
        ),
        h(Card, null,
          h('div', { className: 'cp-filebar' }, h('span', { className: 'cp-filepath' }, path)),
          h('pre', { className: 'cp-logbox' }, lines.length ? lines.join('\n') : '（还没有日志）'),
        ),
      )
    }

    // ---- 会话管理（最外层导航的一个页面） ----------------------------------

    function ChatsPanel({ state, botId, sessions, sessionsLoading, reloadSessions, busy, setBusy, toast, refresh }) {
      var bots = (state && state.bots) || []
      var bot = bots.find(function (row) { return row.id === botId }) || null
      var workspaceRows = (state && state.workspaceDetails) || []
      var allSessions = sessions || []
      var chats = (bot && bot.chats) || []

      function sessionLabel(row) {
        var title = (row && (row.title || row.name)) || '未命名会话'
        var time = row && row.updatedAt ? ' · ' + fmtTime(row.updatedAt) : ''
        var grouped = row && row.grouped === false ? ' · 未分组' : ''
        return (title + time + grouped).slice(0, 80)
      }
      // 同一个会话 id 的两种写法（带 / 不带 session- 前缀）都算同一个会话。
      function sameSessionId(a, b) {
        var x = String(a || '').trim()
        var y = String(b || '').trim()
        if (!x || !y) return false
        if (x === y) return true
        return ('session-' + x) === y || x === ('session-' + y)
      }
      function sessionTitleFor(id) {
        var row = allSessions.find(function (item) { return sameSessionId(item.id, id) })
        return row ? sessionLabel(row) : '未命名会话'
      }
      // 候选：这个 scope 工作区里、没被别的聊天占用的 DSH 会话。
      // 当前这个聊天已经绑上的那个不算候选——它由下拉框里的「当前绑定」一项表示，
      // 再混进候选列表就是同一个会话出现两次。
      function sessionOptionsFor(workspace, chat) {
        if (!workspace) return []
        var currentChatKey = (chat && chat.key) || ''
        var currentSessionId = (chat && chat.sessionId) || ''
        var selectedWorkspace = workspaceRows.find(function (row) { return row.path === workspace || row.id === workspace })
        return allSessions.filter(function (row) {
          if (!row.id || row.origin === 'subagent' || row.parentSession) return false
          if (sameSessionId(row.id, currentSessionId)) return false
          if (row.boundKey && row.boundKey !== currentChatKey) return false
          if (selectedWorkspace) return row.workspaceId === selectedWorkspace.id || (!row.workspaceId && row.cwd === selectedWorkspace.path)
          return row.cwd === workspace
        })
      }
      async function updateChat(chat, patch, message) {
        setBusy(true)
        try {
          await postJson(API + '/bots', { action: 'chat.update', botId: bot.id, key: chat.key, patch: patch })
          toast(message || '会话已更新')
          refresh()
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }
      async function bindChat(chat) {
        setBusy(true)
        try {
          await postJson(API + '/bots', { action: 'bindSession', botId: bot.id, chatKey: chat.key, sessionId: chat.sessionId || '' })
          toast(chat.sessionId ? '会话已换绑' : '已改为自动创建新会话')
          refresh()
          // 绑定集变了，候选会话要重新算。
          if (reloadSessions) await reloadSessions()
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }

      if (!bot) {
        return h('div', null, h(Notice, { tone: 'info' }, '会话管理只属于一台机器人。先在左边「当前机器人」里选一台。'))
      }
      // 主动搭话的开关都在这一页：机器人级总闸 + 每个会话的闸门。
      var botProactiveState = ((state && state.proactives) || []).find(function (row) { return row.botId === bot.id })?.proactive || null
      var botProactiveOn = Boolean(botProactiveState && botProactiveState.enabled !== false)
      async function toggleBotProactive(enabled) {
        setBusy(true)
        try {
          await postJson(API + '/proactive', { action: 'update', botId: bot.id, patch: { enabled: enabled } })
          toast(enabled ? '这台机器人会自己开口了' : '这台机器人不再自己开口')
          refresh()
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }
      var proactiveOn = chats.filter(function (chat) { return (chat.proactive || {}).enabled === true }).length
      // 主动语音只属于 QQ 官方 Bot（其它通道没有 sendVoice）；总闸是全插件共用的。
      var isQq = bot.channel === 'qq'
      var voiceConfig = (state && state.config && state.config.voice) || {}
      var voiceMasterOn = voiceConfig.promptEnabled !== false
      var voiceChatsOn = chats.filter(function (chat) { return (chat.voicePrompt || {}).enabled === true }).length
      async function toggleVoiceMaster(enabled) {
        setBusy(true)
        try {
          await postJson(API + '/config', { config: { voice: { promptEnabled: enabled } } })
          toast(enabled ? '气氛到了她会主动发语音了' : '不再主动发语音')
          refresh()
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }
      return h('div', null,
        h('div', { className: 'cp-panel-bar' },
          h('span', { className: 'cp-mini' }, chats.length
            ? (chats.length + ' 个会话，' + proactiveOn + ' 个会主动开口'
              + (isQq ? ('，' + voiceChatsOn + ' 个会主动发语音') : ''))
            : '还没有会话；在 IM 里给这台机器人发一句话，会话会自动出现。'),
          h('span', { className: 'cp-flex' }),
          sessionsLoading ? h('span', { className: 'cp-mini' }, '正在读宿主会话…') : null,
          h(Button, { onClick: function () { reloadSessions && reloadSessions(true) }, disabled: busy || sessionsLoading }, '刷新候选会话'),
          h('span', { className: 'cp-badge' }, (bot.name || bot.id) + ' · ' + (CHANNEL_LABEL[bot.channel] || bot.channel)),
        ),
        h(Card, null,
          h('div', { className: 'cp-channel-head' },
            h(Dot, { on: botProactiveOn, tone: botProactiveOn ? 'ok' : 'off' }),
            h('div', { className: 'cp-card-title' }, '主动搭话总闸'),
            h('span', { className: 'cp-flex' }),
            h(Toggle, { label: '这台机器人会自己开口', value: botProactiveOn, onChange: function (v) { toggleBotProactive(v) } }),
          ),
          h('div', { className: 'cp-muted' }, '总闸关掉后，下面每个会话的开关都不生效；「现在说一句」仍可用。节奏参数在「主动搭话」页里。'),
        ),
        h(Card, null,
          h('div', { className: 'cp-channel-head' },
            h(Dot, { on: isQq && voiceMasterOn && voiceConfig.enabled !== false, tone: isQq && voiceMasterOn ? 'ok' : 'off' }),
            h('div', { className: 'cp-card-title' }, '主动语音总闸'),
            h('span', { className: 'cp-flex' }),
            isQq
              ? h(Toggle, { label: '气氛到了会主动发语音', value: voiceMasterOn, onChange: function (v) { toggleVoiceMaster(v) } })
              : null,
          ),
          h('div', { className: 'cp-muted' }, !isQq
            ? ('这台机器人是「' + (CHANNEL_LABEL[bot.channel] || bot.channel) + '」：只有 QQ 官方 Bot 有语音条。')
            : (voiceConfig.enabled === false
              ? '语音合成在「全局设置 → 语音」里关着，先把合成启用。总闸全插件共用；关掉后每个会话的勾都不生效。'
              : '总闸全插件共用；关掉后每个会话的勾都不生效。私聊默认开、群聊默认关。提示词在「全局设置 → 语音」里。')),
        ),
        SCOPES.map(function (scope) {
          var rows = chats.filter(function (chat) { return scopeOf(chat) === scope.key })
          var defaults = sessionDefaultsOf(bot)[scope.key]
          var workspace = String(defaults.workspace || '')
          return h(Card, { key: scope.key },
            h('div', { className: 'cp-scope-head' },
              h('span', { className: 'cp-scope-title' }, scope.label + '（' + rows.length + '）'),
              h('span', { className: 'cp-badge' + (workspace ? ' cp-badge-on' : '') }, workspace ? '工作区已配置' : '缺工作区'),
              h('span', { className: 'cp-flex' }),
              h('span', { className: 'cp-mini' }, scope.hint),
            ),
            h('div', { className: 'cp-muted' }, workspace
              ? ('新会话工作区：' + workspace + '；默认权限：' + (defaults.defaultPermission || 'workspace-write') + '（在「机器人」页里改）')
              : (scope.label + '还没有工作区，换绑会话不可用；先去「机器人 → 新会话默认配置」里给' + scope.label + '选一个。')),
            rows.length === 0
              ? h('div', { className: 'cp-muted' }, '还没有' + scope.label + '会话。先在 IM 里给这台机器人发一句，会话会自动出现。')
              : rows.map(function (chat) {
                var options = sessionOptionsFor(workspace, chat)
                // 绑定的会话在宿主目录里吗？不在（被删了、或还没真正创建）说明下条消息才会真的建它。
                var boundSessionKnown = !chat.sessionId || sessionsLoading || allSessions.length === 0
                  ? true
                  : allSessions.some(function (row) { return sameSessionId(row.id, chat.sessionId) })
                var proactive = chat.proactive || {}
                var voicePrompt = chat.voicePrompt || {}
                return h('div', { className: 'cp-chat-row cp-chat-row-wide', key: chat.key },
                  h('div', { className: 'cp-chat-main' },
                    h('div', { className: 'cp-chat-title' },
                      h(Dot, { on: chat.live, tone: chat.live ? 'ok' : 'warn' }),
                      h('span', {
                        className: 'cp-chat-title-text',
                        title: chat.title || chat.key,
                      }, chat.title || chat.key),
                      h('span', { className: 'cp-badge' }, CHANNEL_LABEL[chat.channel] || chat.channel),
                      proactive.enabled ? h('span', { className: 'cp-badge cp-badge-on' }, '主动搭话') : null,
                      isQq && voicePrompt.enabled ? h('span', { className: 'cp-badge cp-badge-on' }, '主动语音') : null,
                    ),
                    h('div', { className: 'cp-chat-meta' },
                      chat.peerId || '—',
                      ' · 会话 ' + sessionIdShort(chat.sessionId),
                      ' · 最近活跃 ' + ago(chat.lastHumanAt),
                      ' · ' + (chat.messageCount || 0) + ' 条消息',
                      proactive.lastSpokeAt ? (' · 上次主动开口 ' + ago(proactive.lastSpokeAt)) : '',
                    ),
                  ),
                  h('div', { className: 'cp-chat-actions' },
                    h('label', { className: 'cp-field-check' },
                      h('input', {
                        type: 'checkbox',
                        checked: proactive.enabled === true,
                        disabled: busy,
                        onChange: function (event) {
                          updateChat(chat, { proactiveEnabled: event.target.checked },
                            event.target.checked ? '这个会话会主动开口了' : '这个会话不再主动开口')
                        },
                      }),
                      h('span', null, '主动搭话'),
                    ),
                    // 只有 QQ 官方 Bot 有语音条；其它通道给这个勾只会误导。
                    isQq ? h('label', { className: 'cp-field-check' },
                      h('input', {
                        type: 'checkbox',
                        checked: voicePrompt.enabled === true,
                        disabled: busy,
                        title: voiceMasterOn ? '' : '上面的主动语音总闸关着，这里的勾暂时不生效',
                        onChange: function (event) {
                          updateChat(chat, { voicePromptEnabled: event.target.checked },
                            event.target.checked ? '这个会话会主动发语音了' : '这个会话不再主动发语音')
                        },
                      }),
                      h('span', null, '主动语音'),
                    ) : null,
                  ),
                  h('div', { className: 'cp-chat-actions' },
                    h('span', { className: 'cp-mini' }, '换绑会话'),
                    h('select', {
                      className: 'cp-select cp-chat-session',
                      value: chat.sessionId || '',
                      disabled: busy || !workspace || sessionsLoading,
                      onChange: function (event) {
                        var next = event.target.value
                        if (!next || next === chat.sessionId) return
                        bindChat({ key: chat.key, scope: chat.scope, sessionId: next })
                      },
                    },
                    // 第一项只表示「现在绑的是哪个会话」：它是状态，不是可选项。
                    // 绑的会话在宿主里已经找不到（被删了 / 还没真正创建）时，把状态说清楚。
                    h('option', { value: chat.sessionId || '' }, boundSessionKnown && chat.sessionId
                      ? ('当前：' + sessionTitleFor(chat.sessionId))
                      : '下一条消息开新会话'),
                    // 候选单独分组：当前会话不再混进候选，列表里只剩「可换绑的会话」。
                    options.length
                      ? h('optgroup', { label: '可换绑的会话' }, options.map(function (row) {
                        return h('option', { key: row.id, value: row.id }, sessionLabel(row))
                      }))
                      : null,
                    ),
                  ),
                  h('span', { className: 'cp-field-hint' }, options.length
                    ? '只列这个工作区里还没被别的聊天占用的会话；要新会话，先在 DSH 里建好再回来选'
                    : '这个工作区里没有可换绑的会话；要新会话，先在 DSH 里建好再回来选'),
                )
              }),
          )
        }),
        h(Notice, { tone: 'info' }, '人格、共享记忆和心情是整台机器人共用的；这一页只管每个聊天的开关与绑定。'),
      )
    }

    // ---- 主界面 -----------------------------------------------------------

    function App(props) {
      var sessionId = (props && props.sessionId) || ''
      var [state, setState] = useState(null)
      var [tab, setTab] = useState('overview')
      var [activeBotId, setActiveBotId] = useState('')
      var [botView, setBotView] = useState('list')
      var [busy, setBusy] = useState(false)
      var [toastText, setToastText] = useState('')
      var [toastTone, setToastTone] = useState('ok')
      // 宿主会话目录（换绑候选）由「会话管理」按需拉，不在每次打开设置页时扫一遍。
      var [sessions, setSessions] = useState([])
      var [sessionsLoading, setSessionsLoading] = useState(false)
      // 语音状态（宿主朗读路由探测 + 这台机器人的 QQ 聊天）同理，进对应页面时才拉。
      var [voiceInfo, setVoiceInfo] = useState(null)
      var [voiceLoading, setVoiceLoading] = useState(false)
      var [voiceSendInfo, setVoiceSendInfo] = useState(null)
      var [voiceSendLoading, setVoiceSendLoading] = useState(false)
      // 斗图状态（图库索引 + 最近转图记录）也是进页面才扫，别拖慢打开设置。
      var [memeInfo, setMemeInfo] = useState(null)
      var [memeLoading, setMemeLoading] = useState(false)
      // 定时激活页自己拉记录；顶部「刷新」按钮靠这个计数让它也重拉一次。
      var [scheduleTick, setScheduleTick] = useState(0)

      var toast = useCallback(function (message, tone) {
        setToastText(String(message || ''))
        setToastTone(tone === 'error' ? 'error' : 'ok')
        setTimeout(function () { setToastText('') }, 3200)
      }, [])

      var load = useCallback(async function () {
        setBusy(true)
        try {
          var body = await getJson(API + '/state?sessionId=' + encodeURIComponent(sessionId))
          setState(body)
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }, [sessionId, toast])

      var loadSessions = useCallback(async function (botId, force) {
        setSessionsLoading(true)
        try {
          var query = []
          if (botId) query.push('botId=' + encodeURIComponent(botId))
          if (force) query.push('refresh=1')
          var body = await getJson(API + '/sessions' + (query.length ? ('?' + query.join('&')) : ''))
          setSessions(body.sessions || [])
        } catch (err) { toast(err.message, 'error') } finally { setSessionsLoading(false) }
      }, [toast])

      var loadVoice = useCallback(async function (botId) {
        setVoiceLoading(true)
        try {
          setVoiceInfo(await getJson(API + '/voice' + (botId ? ('?botId=' + encodeURIComponent(botId)) : '')))
        } catch (err) { toast(err.message, 'error') } finally { setVoiceLoading(false) }
      }, [toast])

      var loadVoiceSend = useCallback(async function (botId) {
        if (!botId) return
        setVoiceSendLoading(true)
        try {
          setVoiceSendInfo(await getJson(API + '/voice?botId=' + encodeURIComponent(botId)))
        } catch (err) { toast(err.message, 'error') } finally { setVoiceSendLoading(false) }
      }, [toast])

      var loadMeme = useCallback(async function (force) {
        setMemeLoading(true)
        try {
          setMemeInfo(await getJson(API + '/meme' + (force ? '?refresh=1' : '')))
        } catch (err) { toast(err.message, 'error') } finally { setMemeLoading(false) }
      }, [toast])

      useEffect(function () { load() }, [load])

      // 切到这些页面时先刷新一次宿主状态，否则会显示上一次加载时的旧数据。
      useEffect(function () {
        if (tab === 'persona' || tab === 'memory' || tab === 'mood' || tab === 'proactive' || tab === 'chats') load()
      }, [tab, load])

      // 会话管理还要宿主会话目录（换绑候选）；只在进这个页面时拉，并按机器人缓存。
      useEffect(function () {
        if (tab !== 'chats') return
        loadSessions(activeBotId)
      }, [tab, activeBotId, loadSessions])

      // 语音页要宿主朗读路由的可用性；语音条页还要这台机器人的 QQ 聊天。
      useEffect(function () {
        if (tab !== 'voice') return
        loadVoice('')
      }, [tab, loadVoice])

      useEffect(function () {
        if (tab !== 'voiceSend') return
        loadVoiceSend(activeBotId)
      }, [tab, activeBotId, loadVoiceSend])

      // 斗图页要扫一次图库索引（在服务端缓存 30 秒，refresh=1 才重扫）。
      useEffect(function () {
        if (tab !== 'meme') return
        loadMeme(false)
      }, [tab, loadMeme])

      async function action(kind) {
        setBusy(true)
        try {
          if (kind === 'restart') { await postJson(API + '/channels/restart', {}); toast('通道已重启') }
          if (kind === 'proactive') {
            var result = await postJson(API + '/proactive', { botId: activeBot ? activeBot.id : '' })
            toast(result.result && result.result.spoke ? '已主动说一句' : ('没开口：' + ((result.result && result.result.reason) || '未知')))
          }
          await load()
        } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
      }

      var botRows = (state && state.bots) || []
      var activeBot = botRows.find(function (bot) { return bot.id === activeBotId }) || null
      var activeChannel = (activeBot && activeBot.channel) || ''
      // 语音条只有 QQ 官方 Bot 有这条能力（webhook/飞书没实现 sendVoice），所以那个页面只对 QQ 机器人出现。
      var activeIsQq = Boolean(activeBot && activeBot.channel === 'qq')
      var activeMood = ((state && state.moods) || []).find(function (row) { return row.botId === (activeBot && activeBot.id) })?.mood || null
      var activeProactive = ((state && state.proactives) || []).find(function (row) { return row.botId === (activeBot && activeBot.id) })?.proactive || null
      var activeChannelLabel = { qq: 'QQ', webhook: '微信', feishu: '飞书' }[activeChannel] || activeChannel
      var activeDefaults = sessionDefaultsOf(activeBot)

      // 导航按「全局设置 → 当前机器人」分组：
      //   · 机器人（连接与凭据、新会话默认）、语音（全插件共用的合成设置）、日志是全局的；
      //   · 机器人的选择器和它自己的页面（总览 / 人格 / 记忆 / 心情 / 主动搭话 / 会话管理 / 语音条）在一组里。
      var navGroups = [
        {
          label: '全局设置',
          items: [
            ['channels', '机器人', '连接、凭据、新会话默认'],
            ['voice', '语音', '合成来源与状态'],
            ['meme', '斗图', '表情包图库与发图'],
            ['logs', '日志', '运行记录'],
          ],
        },
        {
          label: '当前机器人',
          botSelector: true,
          items: [
            ['overview', '总览', '今天的状态与待办'],
            ['persona', '人格', '她是谁、怎么说话'],
            ['memory', '共享记忆', '记住与遗忘'],
            ['mood', '心情', '此刻的情绪'],
            ['proactive', '主动搭话', '什么时候开口'],
            ['schedule', '定时激活', '到点自动唤醒'],
            ['chats', '会话管理', '每个聊天单独开关与绑定'],
            activeIsQq ? ['voiceSend', '语音条', '仅 QQ · 发送与目标'] : null,
          ].filter(Boolean),
        },
      ]
      var tabMeta = {
        overview: { title: '总览', desc: '连接状态、新会话默认、会话数与主动搭话/心情摘要。' },
        channels: { title: '机器人', desc: '连接与凭据，以及新会话默认配置（私聊 / 群聊两段）。' },
        voice: { title: '语音', desc: '全插件共用的合成来源与状态、主动语音提示词。' },
        meme: { title: '斗图', desc: '表情包图库、发图状态与发送规则。' },
        voiceSend: { title: '语音条', desc: '这台 QQ 机器人可发语音条的聊天，以及试听与发送。' },
        persona: { title: '人格', desc: '当前机器人的人格文本，对它自己的所有聊天生效。' },
        memory: { title: '共享记忆', desc: '当前机器人的所有聊天共用一份长期记忆。' },
        mood: { title: '心情', desc: '当前机器人的情绪数值与今天的波动。' },
        proactive: { title: '主动搭话', desc: '当前机器人主动开口的节奏与文案。' },
        schedule: { title: '定时激活', desc: '当前机器人排着的定时任务：任务内容、提交时间、等待间隔与下次激活时间。' },
        chats: { title: '会话管理', desc: '当前机器人的所有会话：按私聊 / 群聊分组，单独开关主动搭话、主动语音，换绑会话。' },
        logs: { title: '日志', desc: '插件的诊断记录。' },
      }
      var meta = tabMeta[tab] || tabMeta.overview

      // 换到非 QQ 机器人时「语音条」这个 tab 会消失，别把人留在空白页上。
      useEffect(function () {
        if (tab === 'voiceSend' && !activeIsQq) setTab('overview')
      }, [tab, activeIsQq])

      var body = null
      if (tab === 'overview') body = h(OverviewPanel, { state, botId: activeBot && activeBot.id, refresh: load, busy, action, onNavigate: setTab })
      else if (tab === 'persona') body = h(PersonaPanel, { state, botId: activeBot && activeBot.id, busy, setBusy, toast })
      else if (tab === 'memory') body = h(MemoryPanel, { state, botId: activeBot && activeBot.id, busy, setBusy, toast })
      else if (tab === 'mood') body = h(MoodPanel, { state, mood: activeMood, botId: activeBot && activeBot.id, busy, setBusy, toast })
      else if (tab === 'proactive') body = h(ProactivePanel, { state, proactive: activeProactive, botId: activeBot && activeBot.id, busy, setBusy, toast, refresh: load, onNavigate: setTab })
      else if (tab === 'schedule') body = h(SchedulePanel, { botId: activeBot && activeBot.id, tick: scheduleTick, busy, setBusy, toast })
      else if (tab === 'chats') body = h(ChatsPanel, {
        state,
        botId: activeBot && activeBot.id,
        sessions,
        sessionsLoading,
        reloadSessions: function (force) { return loadSessions(activeBot && activeBot.id, force) },
        busy,
        setBusy,
        toast,
        refresh: load,
      })
      else if (tab === 'channels' && botView === 'add') body = h(AddBotPanel, {
        toast,
        refresh: load,
        onBack: function () { setBotView('list') },
        onDone: function (id) { setActiveBotId(id); setBotView('detail'); load() },
      })
      else if (tab === 'channels') body = h(BotsPanel, {
        state,
        activeBotId,
        view: botView,
        onOpen: function (id) { setActiveBotId(id); setBotView('detail') },
        onSelect: function (id) { setActiveBotId(id) },
        onBack: function () { setBotView('list') },
        onAdd: function () { setBotView('add') },
        busy,
        setBusy,
        toast,
        refresh: load,
      })
      else if (tab === 'voice') body = h(VoicePanel, {
        state,
        voice: voiceInfo,
        voiceLoading,
        reloadVoice: function () { return loadVoice('') },
        busy,
        setBusy,
        toast,
        refresh: load,
      })
      else if (tab === 'meme') body = h(MemePanel, {
        meme: memeInfo,
        memeLoading,
        reloadMeme: loadMeme,
        busy,
        setBusy,
        toast,
      })
      else if (tab === 'voiceSend') body = activeIsQq
        ? h(VoiceSendPanel, {
          state,
          botId: activeBot && activeBot.id,
          voice: voiceSendInfo,
          voiceLoading: voiceSendLoading,
          reloadVoice: function () { return loadVoice(activeBot && activeBot.id) },
          busy,
          setBusy,
          toast,
        })
        : h('div', null, h(Notice, { tone: 'info' }, '语音条只属于 QQ 官方 Bot 机器人。先在左边「当前机器人」里选一台 QQ 机器人。'))
      else body = h(LogsPanel, { busy, setBusy, toast })

      return h('div', { className: 'cp-root cp-shell' },
        h('aside', { className: 'cp-rail' },
          h('div', { className: 'cp-rail-brand' },
            h('div', { className: 'cp-logo' }, '灵'),
            h('div', null,
              h('div', { className: 'cp-title' }, '灵犀'),
              h('div', { className: 'cp-subtitle' }, '机器人设置'),
            ),
          ),
          h('nav', { className: 'cp-rail-nav' }, navGroups.map(function (group) {
            return h('div', { className: 'cp-rail-group', key: group.label },
              h('div', { className: 'cp-rail-label' }, group.label),
              // 「当前机器人」组自带选择器：选了谁，这一组的页面就是谁的。
              group.botSelector
                ? h('div', { className: 'cp-rail-botpick' },
                  botRows.length
                    ? h('select', {
                      className: 'cp-select',
                      value: (activeBot && activeBot.id) || '',
                      onChange: function (event) { setActiveBotId(event.target.value) },
                    }, h('option', { key: '__placeholder__', value: '' }, '请选择机器人'),
                      ...botRows.map(function (bot) {
                        return h('option', { key: bot.id, value: bot.id }, (bot.name || bot.id) + ' · ' + (CHANNEL_LABEL[bot.channel] || bot.channel))
                      }),
                    )
                    : h('span', { className: 'cp-mini' }, '先接入一台机器人'),
                )
                : null,
              group.items.map(function (item) {
                return h('button', {
                  key: item[0],
                  className: 'cp-rail-item' + (tab === item[0] ? ' cp-rail-on' : ''),
                  onClick: function () { setTab(item[0]) },
                },
                h('span', { className: 'cp-rail-name' }, item[1]),
                h('span', { className: 'cp-rail-note' }, item[2]),
                )
              }),
            )
          })),
          h('div', { className: 'cp-rail-foot' },
            h('div', { className: 'cp-rail-status' },
              h(Dot, { on: Boolean(activeBot && activeBot.status && activeBot.status.connected), tone: activeBot && activeBot.status && activeBot.status.connected ? 'ok' : 'warn' }),
              h('span', null, activeBot
                ? (activeBot.status && activeBot.status.connected ? '当前机器人已连接' : '当前机器人未连接')
                : (activeChannelLabel ? activeChannelLabel + ' · 未选择机器人' : '未选择机器人')),
            ),
            h('div', { className: 'cp-rail-session' }, activeBot
              ? ('私聊 ' + (activeDefaults.c2c.workspace || '未选') + '｜群聊 ' + (activeDefaults.group.workspace || '未选'))
              : '先接入一台机器人'),
          ),
        ),
        h('main', { className: 'cp-stage' },
          h('div', { className: 'cp-stage-head' },
            h('div', null,
              h('div', { className: 'cp-stage-title' }, meta.title),
              h('div', { className: 'cp-stage-desc' }, meta.desc),
            ),
            h('span', { className: 'cp-flex' }),
            toastText ? h('div', { className: 'cp-toast cp-toast-' + toastTone }, toastText) : null,
            h(Button, {
              onClick: function () {
                load()
                if (tab === 'chats') loadSessions(activeBot && activeBot.id)
                if (tab === 'voice') loadVoice('')
                if (tab === 'voiceSend') loadVoiceSend(activeBot && activeBot.id)
                if (tab === 'schedule') setScheduleTick(function (value) { return value + 1 })
              },
              disabled: busy,
            }, '刷新'),
          ),
          state ? h('div', { className: 'cp-stage-body' }, body) : h('div', { className: 'cp-loading' }, busy ? '正在读取设置…' : '正在连接宿主…'),
        ),
      )
    }

    // ---- 样式 -------------------------------------------------------------

    var CSS = [
      '.cp-root{--cp-fg:var(--dsw-alias-label-primary,#1f2329);--cp-muted:var(--dsw-alias-label-secondary,#5c6370);--cp-faint:var(--dsw-alias-label-tertiary,#8b939e);--cp-bg:var(--dsw-alias-bg-layer-1,#fff);--cp-card:var(--dsw-alias-bg-layer-2,#f7f8fa);--cp-field:var(--dsw-alias-bg-layer-3,#f1f3f5);--cp-line:var(--dsw-alias-border-l2,#dde1e6);--cp-line-soft:var(--dsw-alias-border-l1,#e9ecf0);--cp-brand:var(--dsw-alias-brand-primary,#4d6bfe);--cp-brand-fg:#fff;--cp-ok:#2f9e5c;--cp-warn:#b7791f;--cp-err:#c53030;--cp-err-bg:rgba(197,48,48,.08);--cp-ok-bg:rgba(47,158,92,.1);--cp-warn-bg:rgba(183,121,31,.1);color:var(--cp-fg);font-size:13px;line-height:1.6;}',
      '.cp-shell{display:grid;grid-template-columns:168px minmax(0,1fr);gap:16px;align-items:start;}',
      '.cp-rail{position:sticky;top:0;display:flex;flex-direction:column;gap:14px;padding:2px 14px 2px 0;border-right:1px solid var(--cp-line-soft);min-height:540px;}',
      '.cp-rail-brand{display:flex;align-items:center;gap:10px;padding:2px 0 6px;}',
      '.cp-rail-botpick{display:flex;flex-direction:column;gap:5px;padding:2px 0 8px;}',
      '.cp-rail-botpick .cp-select{width:100%;}',
      '.cp-rail-nav{display:flex;flex-direction:column;gap:14px;}',
      '.cp-rail-group{display:flex;flex-direction:column;gap:2px;}',
      '.cp-rail-label{font-size:10.5px;letter-spacing:.08em;color:var(--cp-faint);padding:0 8px 4px;text-transform:uppercase;}',
      '.cp-rail-item{display:flex;flex-direction:column;gap:1px;text-align:left;border:1px solid transparent;background:transparent;color:var(--cp-fg);font:inherit;padding:7px 9px;border-radius:9px;cursor:pointer;}',
      '.cp-rail-item:hover{background:var(--cp-field);}',
      '.cp-rail-on,.cp-rail-on:hover{background:var(--cp-brand);color:var(--cp-brand-fg);}',
      '.cp-rail-name{font-size:12.5px;font-weight:600;}',
      '.cp-rail-note{font-size:10.5px;color:var(--cp-faint);line-height:1.4;}',
      '.cp-rail-on .cp-rail-note{color:rgba(255,255,255,.72);}',
      '.cp-rail-foot{margin-top:auto;padding-top:12px;border-top:1px solid var(--cp-line-soft);display:flex;flex-direction:column;gap:5px;}',
      '.cp-rail-status{display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--cp-muted);}',
      '.cp-rail-session{font-size:10.5px;color:var(--cp-faint);word-break:break-all;}',
      '.cp-stage{min-width:0;}',
      '.cp-stage-head{display:flex;align-items:flex-start;gap:12px;padding:2px 0 13px;margin-bottom:15px;border-bottom:1px solid var(--cp-line-soft);flex-wrap:wrap;}',
      '.cp-stage-title{font-size:18px;font-weight:650;letter-spacing:.2px;line-height:1.3;}',
      '.cp-stage-desc{font-size:12px;color:var(--cp-muted);margin-top:3px;max-width:560px;}',
      '.cp-stage-body{min-width:0;}',
      '.cp-header{display:flex;align-items:center;gap:12px;padding:6px 0 14px;}',
      '.cp-brand{display:flex;align-items:center;gap:11px;}',
      '.cp-logo{width:34px;height:34px;border-radius:10px;background:var(--cp-brand);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:17px;flex:0 0 auto;}',
      '.cp-title{font-size:17px;font-weight:650;letter-spacing:.2px;}',
      '.cp-subtitle{font-size:12px;color:var(--cp-muted);margin-top:1px;}',
      '.cp-tabs{display:flex;gap:4px;flex-wrap:wrap;}',
      '.cp-tabs-main{border:1px solid var(--cp-line-soft);background:var(--cp-field);border-radius:11px;padding:4px;margin-bottom:16px;gap:2px;}',
      '.cp-tab{border:1px solid transparent;background:transparent;color:var(--cp-muted);font:inherit;font-size:12.5px;padding:6px 12px;border-radius:8px;cursor:pointer;}',
      '.cp-tab:hover{background:var(--cp-field);color:var(--cp-fg);}',
      '.cp-tab-on,.cp-tab-on:hover{background:var(--cp-brand);color:var(--cp-brand-fg);font-weight:600;}',
      '.cp-section{margin-bottom:14px;}',
      '.cp-section-head{display:flex;align-items:flex-start;gap:10px;margin-bottom:9px;flex-wrap:wrap;}',
      '.cp-section-title{font-size:14px;font-weight:650;}',
      '.cp-section-desc{font-size:12px;color:var(--cp-muted);flex:1 1 auto;min-width:220px;}',
      '.cp-section-right{flex:0 0 auto;margin-left:auto;}',
      '.cp-card{background:var(--cp-card);border:1px solid var(--cp-line-soft);border-radius:12px;padding:12px 14px;margin-bottom:12px;}',
      '.cp-card-title{font-size:12.5px;font-weight:650;margin-bottom:8px;color:var(--cp-fg);}',
      '.cp-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px;}',
      '.cp-setup{background:var(--cp-card);border:1px solid var(--cp-line-soft);border-radius:14px;padding:13px 14px;margin-bottom:14px;}',
      '.cp-setup-head{display:flex;align-items:flex-start;gap:10px;justify-content:space-between;margin-bottom:9px;}',
      '.cp-setup-title{font-size:13px;font-weight:650;}',
      '.cp-setup-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;}',
      '.cp-setup-step{display:flex;align-items:flex-start;gap:7px;text-align:left;border:1px solid var(--cp-line-soft);background:var(--cp-bg);color:var(--cp-fg);font:inherit;padding:8px;border-radius:10px;cursor:pointer;}',
      '.cp-setup-step:hover{border-color:var(--cp-brand);}',
      '.cp-setup-step-done{opacity:.72;}',
      '.cp-setup-index{width:19px;height:19px;border-radius:50%;background:var(--cp-field);display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:700;flex:0 0 auto;}',
      '.cp-setup-step-done .cp-setup-index{background:var(--cp-ok-bg);color:var(--cp-ok);}',
      '.cp-setup-text{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto;}',
      '.cp-setup-label{font-size:11.5px;font-weight:600;}',
      '.cp-setup-hint{font-size:10.5px;color:var(--cp-faint);line-height:1.35;word-break:break-word;}',
      '.cp-setup-action{font-size:10.5px;color:var(--cp-brand);white-space:nowrap;align-self:center;}',
      '.cp-panel-bar{display:flex;align-items:center;gap:10px;margin:0 0 10px;flex-wrap:wrap;}',
      '.cp-stat{background:var(--cp-card);border:1px solid var(--cp-line-soft);border-radius:12px;padding:11px 13px;}',
      '.cp-stat-label{font-size:11.5px;color:var(--cp-faint);}',
      '.cp-stat-value{font-size:16px;font-weight:650;margin-top:2px;}',
      '.cp-stat-sub{font-size:11.5px;color:var(--cp-muted);margin-top:3px;}',
      '.cp-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;}',
      '.cp-row{display:flex;align-items:center;gap:9px;padding:7px 0;border-bottom:1px solid var(--cp-line-soft);min-width:0;}',
      '.cp-row:last-child{border-bottom:0;}',
      '.cp-row-name{font-size:12.5px;color:var(--cp-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.cp-row-meta{font-size:11.5px;color:var(--cp-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-left:auto;}',
      '.cp-row-error{font-size:11px;color:var(--cp-err);}',
      '.cp-sched{padding:9px 0;border-bottom:1px solid var(--cp-line-soft);min-width:0;}',
      '.cp-sched:last-child{border-bottom:0;}',
      '.cp-sched-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.cp-sched-text{font-size:12.5px;color:var(--cp-fg);white-space:pre-wrap;word-break:break-word;margin:6px 0 4px;}',
      '.cp-sched-meta{display:flex;gap:12px;flex-wrap:wrap;font-size:11.5px;color:var(--cp-faint);}',
      '.cp-badge-err{background:var(--cp-err-bg);color:var(--cp-err);border-color:transparent;}',
      '.cp-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:var(--cp-faint);}',
      '.cp-dot-ok{background:var(--cp-ok);}.cp-dot-warn{background:var(--cp-warn);}.cp-dot-off{background:var(--cp-faint);opacity:.45;}',
      '.cp-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;padding:5px 11px;border-radius:8px;border:1px solid var(--cp-line);background:var(--cp-bg);color:var(--cp-fg);cursor:pointer;}',
      '.cp-btn:hover:not(:disabled){border-color:var(--cp-brand);}',
      '.cp-btn:disabled{opacity:.45;cursor:default;}',
      '.cp-btn-primary{background:var(--cp-brand);border-color:var(--cp-brand);color:var(--cp-brand-fg);font-weight:600;}',
      '.cp-btn-danger{color:var(--cp-err);border-color:var(--cp-err);}',
      '.cp-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:9px;}',
      '.cp-flex{flex:1 1 auto;}',
      '.cp-muted{color:var(--cp-muted);font-size:12px;}',
      '.cp-mini{color:var(--cp-faint);font-size:11.5px;}',
      '.cp-empty{padding:18px 12px;text-align:center;color:var(--cp-muted);font-size:12.5px;}',
      '.cp-loading{padding:40px;text-align:center;color:var(--cp-muted);}',
      '.cp-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin:8px 0;}',
      '.cp-field{display:flex;flex-direction:column;gap:4px;min-width:0;}',
      '.cp-field.cp-field-check{flex-direction:row;align-items:center;gap:7px;padding-top:18px;}',
      '.cp-field.cp-field-check .cp-field-label{font-weight:500;}',
      '.cp-inline-checks{display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:12px;}',
      '.cp-inline-checks .cp-field-check{display:flex;align-items:center;gap:5px;}',
      '.cp-bot-section{margin-top:14px;padding-top:12px;border-top:1px solid var(--cp-line-soft);display:flex;flex-direction:column;gap:9px;}',
      '.cp-disclosure{margin-top:14px;padding-top:12px;border-top:1px solid var(--cp-line-soft);}',
      '.cp-disclosure-summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none;font-size:13px;font-weight:650;color:var(--cp-fg);}',
      '.cp-disclosure-summary::-webkit-details-marker{display:none;}',
      '.cp-disclosure-summary::marker{content:"";}',
      '.cp-disclosure-title{font-weight:650;}',
      '.cp-disclosure-summary-text{font-size:12px;color:var(--cp-muted);font-weight:400;}',
      '.cp-disclosure-arrow{margin-left:auto;color:var(--cp-muted);transition:transform .12s ease;}',
      '.cp-disclosure[open] .cp-disclosure-arrow{transform:rotate(180deg);}',
      '.cp-disclosure-flat{margin-top:0;padding-top:0;border-top:0;}',
      '.cp-disclosure-body{display:flex;flex-direction:column;gap:10px;margin-top:8px;}',
      '.cp-field-wide{grid-column:1/-1;}',
      '.cp-field-label{font-size:12px;color:var(--cp-fg);font-weight:550;}',
      '.cp-field-hint{font-size:11px;color:var(--cp-faint);}',
      '.cp-input,.cp-select{font:inherit;font-size:12.5px;padding:6px 9px;border-radius:8px;border:1px solid var(--cp-line);background:var(--cp-field);color:var(--cp-fg);min-width:0;}',
      '.cp-input:focus,.cp-select:focus{outline:2px solid var(--cp-brand);outline-offset:-1px;}',
      '.cp-toggle{display:flex;align-items:center;gap:7px;padding:6px 0;font-size:12.5px;cursor:pointer;flex-wrap:wrap;}',
      '.cp-toggle input{accent-color:var(--cp-brand);}',
      '.cp-toggle-hint{font-size:11.5px;color:var(--cp-faint);width:100%;padding-left:22px;}',
      '.cp-editor{width:100%;box-sizing:border-box;min-height:300px;resize:vertical;border:1px solid var(--cp-line);border-radius:10px;background:var(--cp-field);color:var(--cp-fg);font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:13px;line-height:1.75;padding:12px 13px;outline:none;}',
      '.cp-editor:focus{border-color:var(--cp-brand);}',
      '.cp-editor-sm{min-height:78px;font-family:inherit;font-size:12.5px;}',
      '.cp-filebar{display:flex;align-items:center;gap:8px;padding:6px 2px 8px;font-size:11.5px;color:var(--cp-faint);}',
      '.cp-filepath{font-family:var(--dsw-font-family-mono,ui-monospace,Menlo,Consolas,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;}',
      '.cp-code{font-family:var(--dsw-font-family-mono,ui-monospace,Menlo,Consolas,monospace);font-size:11.5px;background:var(--cp-field);border:1px solid var(--cp-line-soft);border-radius:6px;padding:2px 6px;color:var(--cp-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;}',
      '.cp-code-block{display:block;padding:6px 8px;margin-top:4px;white-space:nowrap;overflow:auto;}',
      '.cp-preview{background:var(--cp-field);border:1px solid var(--cp-line-soft);border-radius:10px;padding:10px 12px;font-size:12px;line-height:1.65;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;font-family:inherit;margin:8px 0 0;}',
      '.cp-notice{border-radius:10px;padding:9px 12px;font-size:12px;line-height:1.6;margin:6px 0 12px;}',
      '.cp-notice-info{background:var(--cp-field);border:1px solid var(--cp-line-soft);color:var(--cp-muted);}',
      '.cp-notice-warn{background:var(--cp-warn-bg);border:1px solid var(--cp-warn);color:var(--cp-warn);}',
      '.cp-notice-error{background:var(--cp-err-bg);border:1px solid var(--cp-err);color:var(--cp-err);}',
      '.cp-toast{font-size:12px;padding:5px 10px;border-radius:8px;}',
      '.cp-toast-ok{background:var(--cp-ok-bg);color:var(--cp-ok);}',
      '.cp-toast-error{background:var(--cp-err-bg);color:var(--cp-err);}',
      '.cp-addrow{display:flex;gap:8px;margin:8px 0;}',
      '.cp-addrow .cp-input{flex:1 1 auto;}',
      '.cp-list{display:flex;flex-direction:column;}',
      '.cp-memory{display:flex;align-items:flex-start;gap:9px;padding:8px 0;border-bottom:1px solid var(--cp-line-soft);}',
      '.cp-memory:last-child{border-bottom:0;}',
      '.cp-memory-main{flex:1 1 auto;min-width:0;}',
      '.cp-memory-text{font-size:12.5px;line-height:1.6;word-break:break-word;}',
      '.cp-memory-meta{font-size:11px;color:var(--cp-faint);margin-top:2px;}',
      '.cp-memory-mini{font-size:12px;color:var(--cp-muted);padding:3px 0;word-break:break-word;}',
      '.cp-x{border:0;background:transparent;color:var(--cp-faint);font-size:16px;cursor:pointer;line-height:1;padding:2px 5px;border-radius:6px;}',
      '.cp-x:hover{color:var(--cp-err);background:var(--cp-err-bg);}',
      '.cp-mood-head{display:flex;align-items:center;gap:13px;padding:4px 0 10px;}',
      '.cp-mood-emoji{font-size:38px;line-height:1;}',
      '.cp-mood-num{font-size:21px;font-weight:650;}',
      '.cp-dims{display:flex;flex-direction:column;gap:6px;margin:6px 0 10px;}',
      '.cp-dim{display:flex;align-items:center;gap:9px;}',
      '.cp-dim-label{width:48px;font-size:12px;color:var(--cp-muted);flex:0 0 auto;}',
      '.cp-dim-track{flex:1 1 auto;height:7px;border-radius:99px;background:var(--cp-field);overflow:hidden;}',
      '.cp-dim-fill{height:100%;background:var(--cp-brand);border-radius:99px;}',
      '.cp-dim-value{width:28px;text-align:right;font-size:11.5px;color:var(--cp-faint);font-variant-numeric:tabular-nums;}',
      '.cp-channel-head{display:flex;align-items:center;gap:9px;margin-bottom:6px;}',
      '.cp-channel-title{font-size:13px;font-weight:650;}',
      '.cp-comm-intro{margin:2px 0 12px;}',
      '.cp-comm-title{font-size:16px;font-weight:650;letter-spacing:.2px;}',
      '.cp-card-accent{border-color:color-mix(in srgb,var(--cp-brand) 28%,var(--cp-line));background:linear-gradient(135deg,color-mix(in srgb,var(--cp-brand) 8%,var(--cp-card)),var(--cp-card));}',
      '.cp-hero-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}',
      '.cp-hero-icon{width:36px;height:36px;border-radius:11px;background:var(--cp-brand);color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;flex:0 0 auto;}',
      '.cp-hero-main{flex:1 1 220px;min-width:180px;}',
      '.cp-hero-select{display:flex;flex-direction:column;gap:4px;min-width:150px;}',
      '.cp-hero-current{font-size:12.5px;font-weight:650;color:var(--cp-brand);background:var(--cp-field);padding:5px 11px;border-radius:999px;white-space:nowrap;}',
      '.cp-hero-summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px;padding-top:10px;border-top:1px solid var(--cp-line-soft);}',
      '.cp-hero-summary-text{font-size:12px;color:var(--cp-muted);}',
      '.cp-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:1;padding:4px 7px;border-radius:999px;background:var(--cp-field);color:var(--cp-muted);border:1px solid var(--cp-line-soft);white-space:nowrap;}',
      '.cp-badge-on{background:var(--cp-ok-bg);color:var(--cp-ok);border-color:transparent;}',
      '.cp-channel-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:14px;}',
      '.cp-channel-workspace{display:grid;grid-template-columns:158px minmax(0,1fr);gap:12px;align-items:start;margin-bottom:14px;}',
      '.cp-channel-list{display:flex;flex-direction:column;gap:6px;position:sticky;top:0;}',
      '.cp-channel-list-hint{font-size:10.5px;color:var(--cp-faint);padding:0 2px 2px;}',
      '.cp-channel-item{display:flex;flex-direction:column;gap:2px;text-align:left;border:1px solid var(--cp-line-soft);background:var(--cp-card);color:var(--cp-fg);font:inherit;padding:9px 10px;border-radius:11px;cursor:pointer;}',
      '.cp-channel-item:hover{border-color:var(--cp-line);}',
      '.cp-channel-item-on{border-color:var(--cp-brand);box-shadow:0 0 0 1px color-mix(in srgb,var(--cp-brand) 40%,transparent);}',
      '.cp-channel-item-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
      '.cp-channel-item-name{font-size:12.5px;font-weight:650;}',
      '.cp-channel-item-note{font-size:10.5px;color:var(--cp-faint);}',
      '.cp-channel-item-state{font-size:10.5px;color:var(--cp-muted);margin-top:2px;}',
      '.cp-channel-detail{min-width:0;}',
      '.cp-channel-detail>.cp-card{margin-bottom:0;}',
      '.cp-voice-details{margin-top:6px;}',
      '.cp-session-panel{margin:12px 0 4px;padding:12px;border:1px solid var(--cp-line-soft);border-radius:12px;background:var(--cp-field);}',
      '.cp-session-head{display:flex;align-items:flex-start;gap:10px;justify-content:space-between;margin-bottom:8px;}',
      '.cp-session-title{font-size:12.5px;font-weight:650;margin-bottom:2px;}',
      '.cp-session-foot{display:flex;align-items:center;gap:8px;margin-top:8px;}',
      '.cp-field-wide{grid-column:1 / -1;}',
      '.cp-callback{margin:8px 0 2px;}',
      '.cp-qr-box{display:flex;flex-direction:column;align-items:center;gap:8px;margin:12px 0 4px;padding:12px;border:1px dashed var(--cp-line);border-radius:12px;background:var(--cp-field);}',
      '.cp-chat-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 10px;border:1px solid var(--cp-line-soft);border-radius:10px;background:var(--cp-field);}',
      // 纵向排列的会话行必须关掉 flex-wrap：多行 flex 容器的行交叉尺寸按内容算，
      // 长 wxid 会把每个子项撑到几百 px，整行溢出卡片。
      '.cp-chat-row-wide{flex-direction:column;align-items:stretch;gap:8px;flex-wrap:nowrap;}',
      '.cp-chat-row-wide>*{min-width:0;max-width:100%;}',
      '.cp-chat-actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap;min-width:0;}',
      '.cp-chat-main{min-width:0;flex:1 1 auto;}',
      '.cp-chat-title{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;min-width:0;overflow:hidden;}',
      '.cp-chat-title-text{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.cp-chat-title>.cp-badge,.cp-chat-title>.cp-dot{flex:0 0 auto;}',
      '.cp-chat-meta{font-size:10.5px;color:var(--cp-faint);margin-top:2px;word-break:break-all;}',
      '.cp-chat-session{max-width:300px;flex:1 1 180px;}',
      '.cp-input-mini{width:64px;}',
      '.cp-scope-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin:10px 0;}',
      '.cp-scope-block{display:flex;flex-direction:column;gap:9px;padding:11px 12px;border:1px solid var(--cp-line-soft);border-radius:11px;background:var(--cp-bg);}',
      '.cp-scope-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.cp-scope-title{font-size:12.5px;font-weight:650;}',
      '.cp-bots-view-list .cp-channel-detail{display:none;}',
      '.cp-channel-workspace.cp-bots-view-list{grid-template-columns:1fr;}',
      '.cp-bots-view-detail .cp-channel-list{display:none;}',
      '.cp-channel-workspace.cp-bots-view-detail{grid-template-columns:1fr;}',
      '.cp-page-title{font-size:14px;font-weight:650;}',
      '.cp-add-qr{display:flex;flex-direction:column;gap:10px;margin-top:12px;}',
      '.cp-textarea{width:100%;box-sizing:border-box;border:1px solid var(--cp-line);border-radius:10px;background:var(--cp-field);color:var(--cp-text);padding:9px 10px;font-size:12.5px;resize:vertical;}',
      '.cp-qr-image{display:block;width:230px;height:230px;border-radius:8px;background:#fff;padding:8px;}',
      '.cp-qr-placeholder{width:230px;height:230px;display:flex;align-items:center;justify-content:center;text-align:center;border-radius:8px;border:1px dashed var(--cp-line);color:var(--cp-faint);font-size:12px;line-height:1.6;padding:18px;background:var(--cp-card);}',
      '.cp-details{margin:14px 0;border-top:1px solid var(--cp-line-soft);padding-top:10px;}',
      '.cp-details summary{cursor:pointer;font-size:12px;color:var(--cp-muted);margin-bottom:10px;}',
      '.cp-logline{font-family:var(--dsw-font-family-mono,ui-monospace,Menlo,Consolas,monospace);font-size:11.5px;line-height:1.7;color:var(--cp-muted);border-bottom:1px solid var(--cp-line-soft);padding:4px 0;word-break:break-word;}',
      '.cp-logtime{color:var(--cp-faint);margin-right:8px;}',
      '.cp-logbox{background:var(--cp-field);border:1px solid var(--cp-line-soft);border-radius:10px;padding:10px 12px;font-size:11.5px;line-height:1.7;white-space:pre-wrap;word-break:break-word;max-height:58vh;overflow:auto;font-family:var(--dsw-font-family-mono,ui-monospace,Menlo,Consolas,monospace);margin:0;}',
      '.cp-ellipsis{max-width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '@media (max-width:720px){.cp-row-meta{display:none;}.cp-stat-value{font-size:15px;}.cp-channel-grid{grid-template-columns:1fr;}.cp-hero-select{width:100%;}.cp-shell{grid-template-columns:1fr;gap:14px;}.cp-rail{position:static;border-right:0;border-bottom:1px solid var(--cp-line-soft);min-height:0;padding:0 0 10px;}.cp-rail-nav{flex-direction:row;gap:10px;overflow:auto;}.cp-rail-group{min-width:max-content;}.cp-rail-label,.cp-rail-note,.cp-rail-foot{display:none;}.cp-channel-workspace{grid-template-columns:1fr;}.cp-channel-list{position:static;flex-direction:row;overflow:auto;}.cp-channel-item{min-width:130px;}.cp-setup-list{grid-template-columns:repeat(2,minmax(0,1fr));}}',
      '@supports not (color:var(--dsw-alias-label-primary)){.cp-root{--cp-fg:#1f2329;--cp-muted:#5c6370;--cp-faint:#8b939e;--cp-bg:#fff;--cp-card:#f7f8fa;--cp-field:#f1f3f5;--cp-line:#dde1e6;--cp-line-soft:#e9ecf0;--cp-brand:#4d6bfe;}}',
    ].join('')

    // ---- 挂饰的会话来源 ----------------------------------------------------
    // 右下角挂饰是宿主注入的普通脚本（assets/widget/widget.js），读不到 React 上下文，
    // 所以由这里把「页面当前正在看的会话」交出去：全局变量给初值，自定义事件给变化。
    // 挂饰拿这个 id 去问宿主 /api/companion/session，确认会话属于某台机器人后才出现。
    var WIDGET_SESSION_KEY = '__dshCompanionSessionId'
    var WIDGET_SESSION_EVENT = 'dsh-companion:session'

    function publishWidgetSession(sessionId) {
      var value = String(sessionId || '')
      try { window[WIDGET_SESSION_KEY] = value } catch (error) { /* 没有 window 就算了 */ }
      try {
        window.dispatchEvent(new CustomEvent(WIDGET_SESSION_EVENT, { detail: { sessionId: value } }))
      } catch (error) { /* 老宿主没有 CustomEvent：挂饰读全局变量，最坏是不实时 */ }
    }

    /**
     * 只负责广播会话，不画任何东西。
     * 判定口径与宿主自己的标题栏一致（ui-layout 的 DocumentTitle）：
     * 被主视图保留（retainedBy.mainView）的那个会话，就是页面正在看的会话。
     */
    function WidgetSessionBridge(props) {
      var useSessions = props && props.useSessions
      var sessionId = typeof useSessions === 'function'
        ? useSessions(function (state) {
          if (!state || !state.byId) return ''
          var rows = Object.values(state.byId)
          for (var i = 0; i < rows.length; i++) {
            if (rows[i] && rows[i].retainedBy && (rows[i].retainedBy.mainView || 0) > 0) return String(rows[i].id || '')
          }
          return ''
        })
        : ''
      // 渲染期先写一次：挂饰脚本可能晚一步才加载，读到全局就有初值。
      publishWidgetSession(sessionId)
      useEffect(function () { publishWidgetSession(sessionId) }, [sessionId])
      return null
    }

    // ---- 注册 -------------------------------------------------------------

    function apply(ctx) {
      ctx.effect(function () {
        var id = 'dsh-lingxi-agent-bot-styles'
        if (document.getElementById(id) === null) {
          var style = document.createElement('style')
          style.id = id
          style.textContent = CSS
          document.head.appendChild(style)
        }
        return function () {
          var el = document.getElementById(id)
          if (el && el.parentNode) el.parentNode.removeChild(el)
        }
      }, 'dsh-lingxi-agent-bot: styles')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'companion',
          order: 47,
          locale: NS,
          label: function () { return '灵犀' },
        }, function (props) {
          return h(ErrorBoundary, null, h(App, props || {}))
        })
      })

      // 挂饰的会话来源：帧级浮层里放一个不渲染任何节点的项，只负责广播当前会话。
      // shell.overlay 是 root 作用域的浮层，它的 useSessions 能看到主视图保留的会话。
      // 拿不到这个插槽（老宿主）时只是挂饰不显示，不影响设置页。
      try {
        ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({
            name: 'shell.overlay',
            id: 'companion-widget-session',
            order: 900,
          }, function (props) {
            return h(WidgetSessionBridge, props || {})
          })
        })
      } catch (error) {
        publishWidgetSession('')
        console.warn('[companion] 挂饰会话来源注册失败：' + (error && error.message ? error.message : error))
      }
    }

    module.exports = {
      name: 'companion',
      inject: ['slots'],
      apply: apply,
      // 仅测试用：让测试能直接渲染各面板，真实 ModuleLoader 不会用到。
      __test: {
        App: App,
        OverviewPanel: OverviewPanel,
        PersonaPanel: PersonaPanel,
        MemoryPanel: MemoryPanel,
        MoodPanel: MoodPanel,
        ProactivePanel: ProactivePanel,
        SchedulePanel: SchedulePanel,
        ChatsPanel: ChatsPanel,
        BotsPanel: BotsPanel,
        AddBotPanel: AddBotPanel,
        LogsPanel: LogsPanel,
        VoicePanel: VoicePanel,
        VoiceSendPanel: VoiceSendPanel,
        MemePanel: MemePanel,
        // 折叠块的组件本身：测试用它数「这页有几块是折叠的」。
        Disclosure: Disclosure,
        // 挂饰的会话广播：测试直接渲染它，检查写出去的全局变量与事件。
        WidgetSessionBridge: WidgetSessionBridge,
        publishWidgetSession: publishWidgetSession,
      },
    }
    return module.exports
  },
})
