// 灵犀 · 通用小工具（只用 node: 内置模块，保证 link 安装也能加载）。
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

export function num(value, fallback, lo = -Infinity, hi = Infinity) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return clamp(n, lo, hi)
}

export function bool(value, fallback) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  return fallback
}

export function text(value, fallback = '') {
  if (typeof value !== 'string') return fallback
  const s = value.trim()
  return s === '' ? fallback : s
}

export function sha1(value) {
  return createHash('sha1').update(String(value)).digest('hex')
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

/** 由会话键派生 DSH 允许的 UUID 形状（与 qqbot 的派生方式一致）。 */
export function derivedSessionId(key) {
  const hash = sha256(key)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
}

export function newId(prefix = '') {
  return prefix + randomUUID()
}

/** 会话 id 的两种写法（带/不带 session- 前缀）都认。 */
export function sessionIdCandidates(id) {
  const raw = String(id == null ? '' : id).trim()
  if (raw === '') return []
  const out = [raw]
  if (raw.startsWith('session-')) out.push(raw.slice('session-'.length))
  else out.push('session-' + raw)
  return [...new Set(out)]
}

export function sessionIdOf(session) {
  if (!session) return ''
  if (typeof session === 'string') return session
  const candidates = [session.header?.id, session.id, session.sessionId]
  for (const value of candidates) {
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

export function shortId(id, length = 8) {
  const s = String(id ?? '')
  return s.length <= length ? s : s.slice(-length)
}

export function nowMs() {
  return Date.now()
}

export function localTime(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function dayKey(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function relTime(ms, now = Date.now()) {
  const at = Number(ms) || 0
  if (!at) return '较早'
  const hours = (now - at) / 3_600_000
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} 分钟前`
  if (hours < 24) return `${Math.round(hours)} 小时前`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} 天前`
  if (days < 365) return `${Math.round(days / 30)} 个月前`
  return `${Math.round(days / 365)} 年前`
}

/** 从消息的 content 数组里只取正文（跳过 reasoning / 工具块）。 */
export function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out = []
  for (const block of content) {
    if (!block) continue
    if (typeof block === 'string') { out.push(block); continue }
    if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
  }
  return out.join('\n').trim()
}

/** 宿主事件的正文可能在 data / payload / message 里，递归取 text 块。 */
export function messageText(input, depth = 0) {
  if (!input || depth > 5) return ''
  if (typeof input === 'string') return input
  const direct = contentText(input.content)
  if (direct) return direct
  if (typeof input.text === 'string' && !Array.isArray(input.content)) return input.text
  if (typeof input.content === 'string') return input.content
  if (input.message && typeof input.message === 'object') {
    const inner = messageText(input.message, depth + 1)
    if (inner) return inner
  }
  return ''
}

/** 宽松 JSON：模型可能包 markdown 或前后带杂字。 */
export function parseJsonLoose(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return null
  try { return JSON.parse(s) } catch { /* fall through */ }
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)) } catch { return null }
  }
  const c = s.indexOf('[')
  const d = s.lastIndexOf(']')
  if (c >= 0 && d > c) {
    try { return JSON.parse(s.slice(c, d + 1)) } catch { return null }
  }
  return null
}

export function stripHtmlComments(md) {
  return String(md ?? '').replace(/<!--[\s\S]*?-->/g, '')
}

export function normalizeText(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase()
}

export function truncate(s, max) {
  const t = String(s ?? '')
  if (t.length <= max) return t
  return t.slice(0, Math.max(0, max - 1)) + '…'
}

export function chunkText(s, limit = 1800) {
  const source = String(s ?? '').trim()
  if (!source) return []
  if (source.length <= limit) return [source]
  const chunks = []
  let rest = source
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit)
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = limit
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) chunks.push(rest)
  return chunks
}

/** 把 Markdown 压成聊天软件里能直接读的纯文本（图片语法留给通道自己处理）。 */
export function toPlainText(input) {
  return String(input ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,，。！？]|$)/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1（$2）')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 从正文里挑出 Markdown 图片，返回「剩下的文字 + 图片源列表」。
 *
 * 图片源可以是 http(s) 地址，也可以是绝对路径；路径里带空格时用 `![alt](<带 空格>)`
 * 的尖括号写法。通道按这个顺序决定发文本还是发原生图片，顺序与正文里出现的顺序一致。
 */
export function extractMarkdownImages(input) {
  const images = []
  const text = String(input ?? '').replace(
    /!\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g,
    (_all, raw) => {
      const source = String(raw ?? '').trim().replace(/^<(.*)>$/, '$1').trim()
      if (source) images.push(source)
      return ''
    },
  )
  return { text, images }
}

export function readJsonSafe(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}

/** 原子写：先写 .tmp 再 rename，掉电最多丢这一次。 */
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, path)
}

export function appendLog(path, line) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${new Date().toISOString()}  ${line}\n`, 'utf8')
  } catch { /* 日志失败不影响主流程 */ }
}

/** 中文没有空格；用「CJK 连续段 + 拉丁词」的方式切，再补二元词。 */
const CJK = /[\u4e00-\u9fff]/
const STOP = new Set(['的', '了', '是', '我', '你', '他', '她', '它', '们', '在', '有', '和', '就', '都', '也', '不', '很', '这', '那', '一个', '什么', '怎么', '可以', '但是', '因为', '所以', '如果', '然后', '还是', '就是', '没有', '自己', '现在', '时候', '今天', '昨天', '明天', '知道', '觉得', '感觉', '这么', '那么', '这个', '那个'])

/**
 * 轻量分词：不引外部词典。
 * - 拉丁/数字词按空白与标点切；
 * - 中文连续段取 2~3 字滑窗（「车站」不会被「车」或「站」命中）；
 * - 过滤常见虚词，保留数字/英文原词。
 */
export function tokenize(input) {
  const s = normalizeText(input).replace(/\s+/g, ' ')
  const tokens = new Set()
  for (const word of s.match(/[a-z0-9][a-z0-9_+.-]{1,}/g) ?? []) {
    if (word.length >= 2) tokens.add(word)
  }
  for (const run of s.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (const size of [2, 3]) {
      for (let i = 0; i + size <= run.length; i++) {
        const gram = run.slice(i, i + size)
        if (STOP.has(gram)) continue
        if (size === 2 && (STOP.has(gram[0]) || STOP.has(gram[1]))) continue
        tokens.add(gram)
      }
    }
    // 四字以上专名（人名/书名）单独保留一份，召回时更有证据
    if (run.length >= 4 && run.length <= 12) tokens.add(run)
  }
  return [...tokens]
}

export function isImageMediaType(type) {
  return type === 'image/png' || type === 'image/jpeg' || type === 'image/webp' || type === 'image/gif'
}

export function detectImageType(bytes) {
  try {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif'
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return 'image/webp'
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  } catch { /* ignore */ }
  return 'image/jpeg'
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function safeFilename(s, fallback = 'image') {
  const name = String(s ?? '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80)
  return name || fallback
}

export function joinUrl(base, path) {
  return String(base ?? '').replace(/\/+$/, '') + path
}
