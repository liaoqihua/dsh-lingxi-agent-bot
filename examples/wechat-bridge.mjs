// 微信桥接骨架（灵犀 · 自定义 Webhook 通道）
//
// 微信个人号没有稳定的官方协议，所以灵犀只定义两端语义：
//   1. 微信侧收到消息 → POST 本文件 /inbound → 灵犀 /api/companion/channels/webhook/inbound
//   2. 灵犀要回话       → POST 本文件 /send    → sendToWeChat()
//
// 用法：
//   $env:DSH_URL="http://127.0.0.1:58336"
//   $env:COMPANION_SECRET="和设置里一致的共享密钥"
//   node examples/wechat-bridge.mjs
//
// 然后把灵犀 → 通信 → 自定义 Webhook 的「出站地址」填成 http://127.0.0.1:8787/send。
// 真正接入微信：把 sendToWeChat 换成你手上的发送实现（wxauto / wechaty / 微信客服 API 都行），
// 并让你的微信自动化在收到消息时调用本文件的 /inbound（见文件末尾的示例 curl）。
import { createServer } from 'node:http'

const PORT = Number(process.env.BRIDGE_PORT || 8787)
const DSH_URL = (process.env.DSH_URL || 'http://127.0.0.1:58336').replace(/\/+$/, '')
const SECRET = process.env.COMPANION_SECRET || ''
const INBOUND_PATH = '/api/companion/channels/webhook/inbound'

function json(res, code, value) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
  })
}

// ---------------------------------------------------------------------------
// 换成你的微信发送实现。返回 messageId（可选）。
// ---------------------------------------------------------------------------
async function sendToWeChat({ conversation, text }) {
  // 示例：假设你的微信自动化在 127.0.0.1:9000 提供 /send
  // const response = await fetch('http://127.0.0.1:9000/send', {
  //   method: 'POST',
  //   headers: { 'content-type': 'application/json' },
  //   body: JSON.stringify({ wxid: conversation, text }),
  // })
  // const body = await response.json()
  // return body.messageId
  console.log(`[send] ${conversation}: ${text}`)
  return `local-${Date.now()}`
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    if (SECRET && req.headers['x-companion-secret'] !== SECRET) return json(res, 401, { ok: false, error: 'bad secret' })
    const body = await readBody(req)
    if (req.url === '/inbound') {
      const response = await fetch(`${DSH_URL}${INBOUND_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          ...(SECRET ? { 'x-companion-secret': SECRET } : {}),
        },
        body: JSON.stringify(body),
      })
      const data = await response.json().catch(() => null)
      return json(res, response.ok ? 200 : 502, data || { ok: response.ok })
    }
    if (req.url === '/send') {
      const messageId = await sendToWeChat({ conversation: String(body.conversation ?? ''), text: String(body.text ?? '') })
      return json(res, 200, { ok: true, messageId })
    }
    return json(res, 404, { ok: false, error: 'not found' })
  } catch (error) {
    return json(res, 500, { ok: false, error: String(error?.message ?? error) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`微信桥接已启动：http://127.0.0.1:${PORT}`)
  console.log(`灵犀出站地址填：http://127.0.0.1:${PORT}/send`)
  console.log(`你的微信自动化收到消息时 POST /inbound：`)
  console.log(`curl -s http://127.0.0.1:${PORT}/inbound -H "content-type: application/json" \\`)
  console.log(`  -d '{"conversation":"wxid_xxx","senderName":"饲养员","text":"在吗"}'`)
})
