// 挂饰的显隐规则：只有「当前会话属于某台机器人」才把挂饰挂到页面上。
// 这里用最小 DOM 替身跑真实的 assets/widget/widget.js——不启动浏览器，但走的是同一段代码。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const code = readFileSync(join(import.meta.dirname, '..', 'assets', 'widget', 'widget.js'), 'utf8')

function makeNode(tag) {
  const node = {
    tagName: tag,
    className: '',
    textContent: '',
    style: {},
    title: '',
    draggable: true,
    src: '',
    alt: '',
    children: [],
    parentNode: null,
    listeners: new Map(),
    html: '',
    get childNodes() { return node.children },
    get offsetWidth() { return 300 },
    get offsetHeight() { return 340 },
    getBoundingClientRect() { return { left: 0, top: 0, width: 180, height: 180, right: 180, bottom: 180 } },
    appendChild(child) {
      child.parentNode = node
      node.children.push(child)
      return child
    },
    removeChild(child) {
      const index = node.children.indexOf(child)
      if (index >= 0) node.children.splice(index, 1)
      child.parentNode = null
      return child
    },
    addEventListener(type, fn) { node.listeners.set(type, fn) },
    removeEventListener(type) { node.listeners.delete(type) },
    get innerHTML() { return node.html },
    set innerHTML(value) {
      node.html = String(value ?? '')
      node.children.splice(0)
    },
  }
  return node
}

function makeDom() {
  const head = makeNode('head')
  const body = makeNode('body')
  const listeners = new Map()
  const document = {
    head,
    body,
    visibilityState: 'visible',
    createElement: (tag) => makeNode(tag),
    getElementById: () => null,
    addEventListener(type, fn) { listeners.set(type, fn) },
    removeEventListener(type) { listeners.delete(type) },
  }
  return { document, head, body }
}

function makeWindow() {
  const listeners = new Map()
  return {
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? []
      list.push(fn)
      listeners.set(type, list)
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) ?? []
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
    dispatchEvent(event) {
      for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event)
      return true
    },
  }
}

class FakeCustomEvent {
  constructor(type, init) {
    this.type = type
    this.detail = init?.detail
  }
}

/** 跑一遍挂饰脚本，返回它的窗口、文档与请求记录。 */
function startWidget({ respond, sessionId = '' } = {}) {
  const { document, head, body } = makeDom()
  const window = makeWindow()
  window.__dshCompanionSessionId = sessionId
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    const payload = respond(String(url)) ?? { ok: false }
    return { ok: true, async json() { return payload } }
  }
  const run = new Function('window', 'document', 'fetch', 'CustomEvent', 'setTimeout', code)
  run(window, document, fetchImpl, FakeCustomEvent, () => 0)
  const tell = (id) => window.dispatchEvent(new FakeCustomEvent('dsh-companion:session', { detail: { sessionId: id } }))
  return { window, document, head, body, calls, tell }
}

const settle = async (times = 4) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve))
}

test('挂饰：没有会话时什么都不挂（脚本只加样式，不进 body）', () => {
  const { body, head, calls } = startWidget({ respond: () => ({ ok: true }) })
  assert.equal(body.children.length, 0)
  assert.equal(head.children.length, 1, '样式还是要加的')
  assert.equal(calls.length, 0, '没有会话就不该问宿主')
})

test('挂饰：会话不属于机器人就不显示', async () => {
  const { body, calls, tell } = startWidget({
    respond: (url) => (url.includes('/api/companion/session?') ? { ok: true, bound: false, botId: '' } : { ok: true }),
  })
  tell('s-plain')
  await settle()
  assert.equal(body.children.length, 0)
  assert.ok(calls.some((url) => url.startsWith('/api/companion/session?sessionId=s-plain')), '应该带着会话 id 去问宿主')
  assert.equal(calls.some((url) => url.includes('/mood?')), false, '没确认是机器人的会话，不必拉心情')
})

test('挂饰：宿主答不上来（非 ok）也不显示', async () => {
  const { body, tell } = startWidget({ respond: () => ({ ok: false, error: '宿主还没起来' }) })
  tell('s-error')
  await settle()
  assert.equal(body.children.length, 0)
})

test('挂饰：会话属于机器人就出现，并只拉这台机器人的心情', async () => {
  const { body, calls, tell } = startWidget({
    respond: (url) => {
      if (url.includes('/api/companion/session?')) {
        return { ok: true, bound: true, botId: 'bot-a', botName: '机器人甲', chatKey: 'qq-a:qq:c2c:u1' }
      }
      if (url.includes('/api/companion/mood?')) {
        return { ok: true, mood: { mood: 72, lastReason: '聊得挺开心', dims: [{ key: 'happy', label: '开心', value: 80 }] } }
      }
      return { ok: false }
    },
  })
  tell('s-bot')
  await settle()
  assert.equal(body.children.length, 1, '机器人的会话应该有挂饰')
  assert.ok(body.children[0].children.some((node) => node.tagName === 'img'))
  assert.ok(calls.some((url) => url.includes('/mood?botId=bot-a')), '心情只按这台机器人拉')
})

test('挂饰：切到别的会话会收起来，切回机器人会话再出现', async () => {
  let plain = false
  const { body, tell } = startWidget({
    respond: (url) => {
      if (url.includes('/api/companion/session?')) {
        return plain ? { ok: true, bound: false } : { ok: true, bound: true, botId: 'bot-a', botName: '机器人甲' }
      }
      return { ok: true, mood: { mood: 60, dims: [] } }
    },
  })
  tell('s-bot')
  await settle()
  assert.equal(body.children.length, 1)

  plain = true
  tell('s-plain')
  await settle()
  assert.equal(body.children.length, 0, '不是机器人的会话就不该留在页面上')

  plain = false
  tell('s-bot-2')
  await settle()
  assert.equal(body.children.length, 1)
})

test('挂饰：脚本比浏览器半侧晚加载时，也能从全局初值认出会话', async () => {
  const { body } = startWidget({
    sessionId: 's-early',
    respond: (url) => {
      if (url.includes('/api/companion/session?sessionId=s-early')) return { ok: true, bound: true, botId: 'bot-a', botName: '机器人甲' }
      return { ok: true, mood: { mood: 66, dims: [] } }
    },
  })
  await settle()
  assert.equal(body.children.length, 1)
})