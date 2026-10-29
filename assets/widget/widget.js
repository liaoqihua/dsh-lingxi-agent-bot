// 灵犀 · 心情右下角挂饰（浏览器端，纯 DOM）
// 整张形象图直接当按钮，可拖动；点开看当前机器人的心情。
//
// 挂饰只属于「某台机器人的会话」，这是它与 dsh-feiyu-mood（一个全局挂饰）的关键区别：
//   1. 会话 id 由浏览器半侧（client.js 里的 shell.overlay 项）广播——
//      全局变量给初值、自定义事件给变化；
//   2. 拿会话 id 问宿主 GET /api/companion/session，确认这个会话登记在某台机器人名下；
//   3. 不是机器人的会话（或问不出结果时）**一个节点都不进 DOM**：
//      不显示、不挡点击、也不加载形象图。
;(function () {
  'use strict'
  if (window.__lingxiMoodInited) return
  window.__lingxiMoodInited = true

  var B = '/api/companion/widget'
  var API = '/api/companion'
  // 与 client.js 的约定：全局变量给初值，事件给变化。
  var SESSION_KEY = '__dshCompanionSessionId'
  var SESSION_EVENT = 'dsh-companion:session'
  // 宿主或浏览器半侧刚起来时可能还答不上来：隔几拍再问，之后等下一次会话变化。
  var RETRY_MS = [3000, 10000, 30000]

  var dimColor = {
    happy: '#5ddc8a', calm: '#7aaadc', sweet: '#e28fc0',
    heartache: '#e0b070', worry: '#e8a25b', sad: '#7a96c8', jealous: '#c88fdc'
  }
  var DIM_LABELS = { happy: '开心', calm: '踏实', sweet: '甜蜜', heartache: '心疼', worry: '担心', sad: '难过', jealous: '吃醋' }
  var DIM_KEYS = ['happy', 'calm', 'sweet', 'heartache', 'worry', 'sad', 'jealous']

  function face(v) {
    if (v >= 80) return { img: B + '/face-great.png', label: '欢喜' }
    if (v >= 62) return { img: B + '/face-good.png', label: '开心' }
    if (v >= 42) return { img: B + '/face-ok.png', label: '一般' }
    if (v >= 25) return { img: B + '/face-worry.png', label: '心疼' }
    return { img: B + '/face-sad.png', label: '难过' }
  }

  var css = [
    '.lm-widget{position:fixed;right:18px;bottom:18px;z-index:99990;width:180px;height:180px;',
    'cursor:grab;user-select:none;background:transparent;border:0;padding:0;-webkit-user-drag:none;',
    'transition:filter .15s}',
    '.lm-widget:hover{filter:brightness(1.04)}',
    '.lm-widget:active{cursor:grabbing}',
    '.lm-widget>img{width:100%;height:100%;object-fit:contain;display:block;pointer-events:none}',
    '.lm-panel{position:absolute;left:0;bottom:calc(100% + 10px);width:300px;max-height:62vh;',
    'overflow:auto;background:#1b1c1f;color:#e8e8ea;border:1px solid rgba(128,128,128,.28);',
    'border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.5);padding:14px;display:none;',
    'font-size:13px;line-height:1.6;cursor:auto;',
    'font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
    '.lm-panel img{pointer-events:none;-webkit-user-drag:none}',
    '.lm-who{color:#9aa0a6;font-size:12px;margin:0 0 8px}',
    '.lm-head{display:flex;align-items:center;gap:12px;margin-bottom:4px}',
    '.lm-face{width:64px;height:64px;object-fit:contain;flex:none}',
    '.lm-big{font-size:22px;font-weight:700;line-height:1.15}',
    '.lm-reason{color:#9aa0a6;margin:6px 0 10px;overflow-wrap:anywhere}',
    '.lm-dim{display:flex;align-items:center;gap:8px;margin:4px 0}',
    '.lm-dimlabel{width:34px;flex:none;color:#9aa0a6}',
    '.lm-bar{flex:1;height:7px;border-radius:4px;background:rgba(128,128,128,.2);overflow:hidden}',
    '.lm-bar i{display:block;height:100%}',
    '.lm-val{width:28px;text-align:right;color:#9aa0a6;flex:none}',
    '.lm-btn{margin-top:12px;display:block;width:100%;padding:7px 0;border:1px solid rgba(128,128,128,.35);',
    'border-radius:8px;background:transparent;color:inherit;cursor:pointer;font-size:13px;text-align:center;font-family:inherit}',
    '.lm-btn:hover{background:rgba(128,128,128,.12)}',
    '.lm-h{font-weight:600;margin:10px 0 6px;color:#c9cdd3}',
    '.lm-back{color:#8fa8c8;cursor:pointer;font-size:13px;margin-bottom:6px;display:inline-block}',
    '.lm-back:hover{text-decoration:underline}',
    '.lm-tlrow{display:flex;gap:6px;padding:3px 0;border-bottom:1px solid rgba(128,128,128,.1);align-items:baseline}',
    '.lm-tltime{flex:none;width:50px;color:#7a8088}',
    '.lm-tlmood{flex:none;width:32px;font-weight:600}',
    '.lm-tldelta{flex:none;width:44px;text-align:left;font-size:12px}',
    '.lm-tlreason{flex:1;overflow-wrap:anywhere;word-break:break-word}',
    '.lm-tldims{color:#8a93a0;font-size:11px;padding:1px 0 5px 62px}'
  ].join('')

  var style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }
  function elImg(src, cls, alt) {
    var n = document.createElement('img')
    n.src = src
    n.className = cls
    n.alt = alt || ''
    n.draggable = false
    return n
  }

  // 元素先建好但不入 DOM：只有确认是机器人的会话才挂上去。
  var widget = el('div', 'lm-widget')
  var bodyImg = elImg(B + '/feiyu.png', '', '形象')
  widget.appendChild(bodyImg)
  var panel = el('div', 'lm-panel')
  widget.appendChild(panel)

  var attached = false
  var open = false
  var page = 'main'
  var sessionId = ''
  var botId = ''
  var botName = ''
  var data = null
  var probeSeq = 0
  var retries = 0

  function attachWidget() {
    if (attached) return
    attached = true
    widget.title = (botName || '心情') + '（点开看，按住拖动换位置）'
    document.body.appendChild(widget)
  }

  /** 收起来：连节点一起摘掉，页面上不留任何痕迹（面板状态一并复位）。 */
  function detachWidget() {
    if (attached && widget.parentNode) widget.parentNode.removeChild(widget)
    attached = false
    open = false
    page = 'main'
    panel.style.display = 'none'
    panel.innerHTML = ''
    data = null
  }

  function fmt(t) {
    if (!t) return ''
    var d = new Date(t)
    var p = function (n) { return String(n).padStart(2, '0') }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }
  function fdate(t) {
    if (!t) return ''
    var d = new Date(t)
    var p = function (n) { return String(n).padStart(2, '0') }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  }
  function deltaText(dt) {
    var n = Number(dt) || 0
    if (n > 0) return '▲+' + n
    if (n < 0) return '▼' + n
    return '·'
  }

  // 按屏幕边适配面板：挂饰在中间就居中，贴边就往里挤、放不下就往另一侧弹
  function positionPanel() {
    var rect = widget.getBoundingClientRect()
    var pw = panel.offsetWidth || 300
    var ph = panel.offsetHeight || 340
    var winW = window.innerWidth
    var m = 8
    var left = (rect.width - pw) / 2
    var screenLeft = rect.left + left
    if (screenLeft < m) left += (m - screenLeft)
    var screenRight = rect.left + left + pw
    if (screenRight > winW - m) left -= (screenRight - (winW - m))
    panel.style.left = left + 'px'
    panel.style.right = 'auto'
    if (rect.top >= ph + 20) {
      panel.style.top = 'auto'
      panel.style.bottom = (rect.height + 10) + 'px'
    } else {
      panel.style.bottom = 'auto'
      panel.style.top = (rect.height + 10) + 'px'
    }
  }

  function renderMain(d) {
    panel.innerHTML = ''
    panel.appendChild(el('div', 'lm-who', (botName || '机器人') + ' 的心情'))

    if (!botId) {
      panel.appendChild(el('div', 'lm-reason', '这个会话还没有绑机器人。'))
      positionPanel()
      return
    }

    var f = face(d && d.mood)
    var head = el('div', 'lm-head')
    head.appendChild(elImg(f.img, 'lm-face', f.label))
    var htxt = el('div')
    htxt.appendChild(el('div', 'lm-big', ((d && d.mood != null ? d.mood : '--')) + '　' + f.label))
    htxt.appendChild(el('div', 'lm-reason', (d && d.lastReason) || '这会儿平静地待着，等你来。'))
    head.appendChild(htxt)
    panel.appendChild(head)

    ;((d && d.dims) || []).forEach(function (x) {
      var dim = el('div', 'lm-dim')
      dim.appendChild(el('span', 'lm-dimlabel', x.label))
      var bar = el('div', 'lm-bar')
      var fill = el('i')
      fill.style.width = (x.value || 0) + '%'
      fill.style.background = dimColor[x.key] || '#8a8a8a'
      bar.appendChild(fill)
      dim.appendChild(bar)
      dim.appendChild(el('span', 'lm-val', String(x.value || 0)))
      panel.appendChild(dim)
    })

    var btn = el('button', 'lm-btn', '看完整记录 ▸')
    btn.addEventListener('click', function (e) { e.stopPropagation(); page = 'log'; renderLog(d) })
    panel.appendChild(btn)
    positionPanel()
  }

  function renderLog(d) {
    panel.innerHTML = ''
    panel.appendChild(el('div', 'lm-who', (botName || '机器人') + ' 的心情'))
    var back = el('span', 'lm-back', '‹ 返回当前心情')
    back.addEventListener('click', function (e) { e.stopPropagation(); page = 'main'; renderMain(d) })
    panel.appendChild(back)
    panel.appendChild(el('div', 'lm-h', '心情完整记录'))

    var tl = ((d && d.timeline) || []).slice().reverse()
    if (!tl.length) {
      panel.appendChild(el('div', 'lm-tlreason', '还没有记录 —— 聊起来就有了。'))
      positionPanel()
      return
    }
    var lastDate = ''
    for (var i = 0; i < tl.length; i++) {
      var t = tl[i]
      var day = fdate(t.at)
      if (day !== lastDate) {
        lastDate = day
        var cnt = 0
        for (var j = 0; j < tl.length; j++) if (fdate(tl[j].at) === day) cnt++
        panel.appendChild(el('div', 'lm-h', day + '　' + cnt + ' 条'))
      }
      var tr = el('div', 'lm-tlrow')
      tr.appendChild(el('span', 'lm-tltime', fmt(t.at).slice(6)))
      tr.appendChild(el('span', 'lm-tlmood', String(t.mood)))
      tr.appendChild(el('span', 'lm-tldelta', deltaText(t.delta)))
      tr.appendChild(el('span', 'lm-tlreason', t.reason || '—'))
      panel.appendChild(tr)
      var dd = t.dimsDelta
      if (dd) {
        var parts = []
        for (var k = 0; k < DIM_KEYS.length; k++) {
          var key = DIM_KEYS[k]
          var v = Number(dd[key]) || 0
          if (v !== 0) parts.push(DIM_LABELS[key] + (v > 0 ? '+' : '') + v)
        }
        if (parts.length) panel.appendChild(el('div', 'lm-tldims', parts.join('　')))
      }
    }
    positionPanel()
  }

  function renderAll(d) {
    if (!attached) return
    if (page === 'log') renderLog(d)
    else renderMain(d)
  }

  function loadMood() {
    if (!botId || !attached) return
    var target = botId
    try {
      fetch(API + '/mood?botId=' + encodeURIComponent(target), { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (r) {
          if (target !== botId || !attached) return
          data = (r && r.ok && r.mood) ? r.mood : data
          renderAll(data)
        })
        .catch(function () { /* 拿不到就先空着，下次打开再拉 */ })
    } catch (e) { /* 同上 */ }
  }

  function retryLater() {
    if (retries >= RETRY_MS.length) return
    var delay = RETRY_MS[retries++]
    setTimeout(function () { if (sessionId) probeSession() }, delay)
  }

  /** 问宿主：这个会话是哪台机器人的？不是机器人的会话就彻底不显示。 */
  function probeSession() {
    if (!sessionId) { detachWidget(); return }
    var seq = ++probeSeq
    var target = sessionId
    try {
      fetch(API + '/session?sessionId=' + encodeURIComponent(target), { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (r) {
          if (seq !== probeSeq || target !== sessionId) return
          if (!r || r.ok !== true) { detachWidget(); retryLater(); return }
          if (r.bound !== true || !r.botId) { detachWidget(); return }
          botId = String(r.botId)
          botName = String(r.botName || r.botId)
          retries = 0
          attachWidget()
          loadMood()
        })
        .catch(function () {
          if (seq !== probeSeq || target !== sessionId) return
          detachWidget()
          retryLater()
        })
    } catch (e) {
      detachWidget()
      retryLater()
    }
  }

  /** 会话变了：先收起来，再重新确认（换会话时身份可能整个换掉）。 */
  function setSession(next) {
    var value = String(next || '')
    if (value === sessionId) return
    sessionId = value
    botId = ''
    botName = ''
    retries = 0
    probeSeq++
    detachWidget()
    if (value) probeSession()
  }

  function readSessionId() {
    try { return String(window[SESSION_KEY] || '') } catch (e) { return '' }
  }

  function toggle() {
    open = !open
    panel.style.display = open ? 'block' : 'none'
    page = 'main'
    if (open) { loadMood(); positionPanel() }
  }

  // ---- 拖动（动了算拖，没动算点）----
  var sx = 0, sy = 0, ox = 0, oy = 0, moved = false, dragged = false
  widget.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return
    if (e.target !== bodyImg && e.target !== widget) return
    sx = e.clientX; sy = e.clientY
    var rect = widget.getBoundingClientRect()
    ox = rect.left; oy = rect.top
    moved = false
    function onMove(ev) {
      var dx = ev.clientX - sx, dy = ev.clientY - sy
      if (!moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) moved = true
      if (moved) {
        dragged = true
        var maxX = window.innerWidth - widget.offsetWidth
        var maxY = window.innerHeight - widget.offsetHeight
        widget.style.left = Math.min(maxX, Math.max(0, ox + dx)) + 'px'
        widget.style.top = Math.min(maxY, Math.max(0, oy + dy)) + 'px'
        widget.style.right = 'auto'
        widget.style.bottom = 'auto'
      }
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      if (!moved) toggle()
      else if (open) positionPanel()
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  })

  // ---- 会话来源 ----------------------------------------------------------
  try {
    window.addEventListener(SESSION_EVENT, function (event) {
      var detail = event && event.detail
      setSession(detail && detail.sessionId)
    })
  } catch (e) { /* 没有窗口事件时只能读全局初值 */ }

  // 从后台切回来时再确认一次：宿主重启、长时间后台都可能错过事件。
  try {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && sessionId && !attached) probeSession()
    })
  } catch (e) { /* 忽略 */ }

  // 挂饰脚本可能比浏览器半侧晚加载（也可能早）：读一次全局初值就知道当前会话。
  setSession(readSessionId())
})()