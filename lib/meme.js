// 灵犀 · 表情包桥：把模型写在回复里的 [表情: 描述] 还原成图库里的真实图片。
//
// 斗图的链路里，dsh-meme 在 Web 会话只让模型写 `[表情: 描述]`（前端按描述配图）。
// 这句话发到 QQ / 微信 / 飞书这边就只是一行方括号文字，所以出站前在这里换成
// `![表情](绝对路径)`，通道再把它作为原生图片发出去。
//
// 图库索引用的是 dsh-meme 自己的 SQLite（memes 表：path/tag/file_name/caption/keywords）。
// 本插件只读、不改、不强制依赖：一台机器上没装 dsh-meme 或找不到图库时，
// 原样返回正文，标记照旧被通道的纯文本清理掉，不会把插件带崩。
import { existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, sep } from 'node:path'

import { PATHS } from './config.js'
import { appendLog, readJsonSafe, writeJsonAtomic } from './util.js'

/** 模型照 dsh-meme 的提示抄进回复的标记；全角冒号也认。 */
const MARKER_RE = /\[\s*表情\s*[:：]\s*([^\]\n]{1,120}?)\s*\]/gu

/** 索引缓存：图库目录不常变，30 秒重扫一次目录、单个包按 index.db 的 mtime 复用。 */
const PACKS_CACHE_MS = 30_000
let packsCache = { at: 0, dirs: [] }
const rowsCache = new Map()

let sqliteModule = null
let sqliteUnavailable = false

function sqlite() {
  if (sqliteModule) return sqliteModule
  if (sqliteUnavailable) return null
  try {
    // 内置模块；用 createRequire 拿，避免在 Electron 里被 ESM 解析规则挡住。
    sqliteModule = createRequire(import.meta.url)('node:sqlite')
    return sqliteModule
  } catch (error) {
    sqliteUnavailable = true
    appendLog(PATHS.diag, '表情包索引不可用（node:sqlite）：' + (error?.message ?? error))
    return null
  }
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * 候选图库根目录。
 *
 * 依次看：环境变量（测试/自定义）、dsh-meme 文档里的 `~/.dsh/meme-packs`、
 * 它代码里算出来的 `~/.dsh/.dsh/meme-packs`、设置文件里的自定义目录，
 * 以及每个 profile 里装着的 dsh-meme 自带图库（`<profile>/node_modules/dsh-meme/memes`）。
 */
export function memeRoots({ home = homedir() } = {}) {
  const dsh = join(home, '.dsh')
  const roots = new Set()
  // 显式指定就只认这一组（测试、或者图库放在非常规位置时用）。
  const explicit = String(process.env.DSH_MEME_ROOTS ?? '').trim()
  if (explicit) return explicit.split(delimiter).map((item) => item.trim()).filter(Boolean)
  const fromEnv = String(process.env.DSH_MEME_PACKS ?? '').trim()
  if (fromEnv) roots.add(fromEnv)
  roots.add(join(dsh, 'meme-packs'))
  roots.add(join(dsh, '.dsh', 'meme-packs'))
  const settings = readJsonSafe(join(dsh, 'dsh-expression.json'), null)
  if (settings && typeof settings === 'object') {
    const packsDir = String(settings.packsDir ?? '').trim()
    if (packsDir) roots.add(packsDir)
    const memeRoot = String(settings.memeRoot ?? '').trim()
    if (memeRoot) roots.add(dirname(memeRoot))
  }
  for (const entry of safeReaddir(join(dsh, 'profiles'))) {
    if (!entry.isDirectory()) continue
    roots.add(join(dsh, 'profiles', entry.name, 'node_modules', 'dsh-meme', 'memes'))
  }
  return [...roots]
}

/** 根目录 → 真正的图库目录（含 index.db）。容忍「根目录本身就是包」和历史上多嵌一层的布局。 */
export function discoverPacks(roots = memeRoots()) {
  if (Date.now() - packsCache.at < PACKS_CACHE_MS && packsCache.dirs.length) return packsCache.dirs
  const dirs = new Set()
  for (const root of roots) {
    let stat = null
    try { stat = statSync(root) } catch { continue }
    if (!stat.isDirectory()) continue
    if (existsSync(join(root, 'index.db'))) {
      dirs.add(root)
      continue
    }
    for (const entry of safeReaddir(root)) {
      if (!entry.isDirectory()) continue
      const child = join(root, entry.name)
      if (existsSync(join(child, 'index.db'))) {
        dirs.add(child)
        continue
      }
      for (const inner of safeReaddir(child)) {
        if (!inner.isDirectory()) continue
        const nested = join(child, inner.name)
        if (existsSync(join(nested, 'index.db'))) dirs.add(nested)
      }
    }
  }
  packsCache = { at: Date.now(), dirs: [...dirs] }
  return packsCache.dirs
}

function rowAbsolute(dir, storedPath) {
  const rel = String(storedPath ?? '').trim()
  if (!rel) return ''
  return isAbsolute(rel) ? rel : join(dir, rel)
}

function readPackRows(dir) {
  const dbPath = join(dir, 'index.db')
  let stat = null
  try { stat = statSync(dbPath) } catch { return [] }
  const cached = rowsCache.get(dbPath)
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.rows
  const module = sqlite()
  if (!module) return cached?.rows ?? []
  let rows = []
  try {
    const db = new module.DatabaseSync(dbPath, { readOnly: true })
    try {
      const list = db
        .prepare("SELECT path, tag, file_name, caption, COALESCE(keywords, '') AS keywords FROM memes")
        .all()
      rows = list
        .map((row) => {
          const absolute = rowAbsolute(dir, row?.path)
          if (!absolute || !existsSync(absolute)) return null
          return {
            absolute,
            tag: String(row?.tag ?? ''),
            file: String(row?.file_name ?? ''),
            caption: String(row?.caption ?? ''),
            keywords: String(row?.keywords ?? ''),
          }
        })
        .filter(Boolean)
    } finally {
      db.close()
    }
  } catch (error) {
    appendLog(PATHS.diag, `表情包索引读取失败（${dir}）：${error?.message ?? error}`)
    return cached?.rows ?? []
  }
  rowsCache.set(dbPath, { mtimeMs: stat.mtimeMs, rows })
  return rows
}

/** 所有启用/已扫描图库里的候选行（只要文件确实存在）。 */
export function memeRows() {
  const rows = []
  for (const dir of discoverPacks()) rows.push(...readPackRows(dir))
  return rows
}

/** 比较用的归一化：去空白、去标点、转小写，避免模型多抄一个句号就配不上图。 */
function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\u3000，。、,.!！?？~～'"“”‘’()（）【】\[\]<>《》·…—]/g, '')
}

function tokenizeCaption(value) {
  return String(value ?? '')
    .toLowerCase()
    .split(/[\s\u3000，,。.、!！?？~～]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

/**
 * 描述 → 一条图库记录。三种匹配，按可靠性从高到低：
 * 1. 归一化后完全相同（模型「抄候选原文」时命中）；
 * 2. 互相包含（模型多写/少写半句）；
 * 3. 叠词兜底：拆出来的词全部出现在 caption/关键词/文件名/分类里。
 */
export function findMeme(caption, rows = memeRows()) {
  const query = normalize(caption)
  if (!query) return null
  let loose = null
  for (const row of rows) {
    const cap = normalize(row.caption)
    if (!cap) continue
    if (cap === query) return row
    if (!loose && cap.length >= 4 && query.length >= 4 && (cap.includes(query) || query.includes(cap))) loose = row
  }
  if (loose) return loose
  const tokens = tokenizeCaption(caption)
  if (!tokens.length) return null
  for (const row of rows) {
    const hay = `${row.caption} ${row.keywords} ${row.file} ${row.tag}`.toLowerCase()
    if (tokens.every((token) => hay.includes(token))) return row
  }
  return null
}

/**
 * 把正文里的 [表情: 描述] 换成 `![表情](绝对路径)`。
 *
 * 配不上的标记直接去掉（留在 IM 里就是一行方括号文字），并记一条日志，
 * 方便在「设置 → 灵犀 → 日志」里看出是哪句描述没找到图库。
 *
 * @param {string} input 模型这一轮的正文
 * @param {{ rows?: Array<object>, log?: boolean }} [options]
 * @returns {{ text: string, images: string[], matched: number, missed: string[] }}
 */
export function renderMemeMarkers(input, { rows = null, log = true, maxImages = 4 } = {}) {
  const source = String(input ?? '')
  const matches = [...source.matchAll(MARKER_RE)]
  if (!matches.length) return { text: source, images: [], matched: 0, missed: [], skipped: 0 }
  const pool = Array.isArray(rows) ? rows : memeRows()
  const images = []
  const captions = []
  const missed = []
  let skipped = 0
  let out = ''
  let cursor = 0
  const cap = Math.max(1, Number(maxImages) || 4)
  for (const match of matches) {
    out += source.slice(cursor, match.index)
    cursor = match.index + match[0].length
    const caption = String(match[1] ?? '').trim()
    const hit = findMeme(caption, pool)
    if (!hit) {
      missed.push(caption)
      continue
    }
    if (images.length >= cap) {
      skipped += 1
      continue
    }
    images.push(hit.absolute)
    captions.push(hit.caption || hit.file || caption)
    out += `![表情](${hit.absolute})`
  }
  out += source.slice(cursor)
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (log && missed.length) {
    appendLog(PATHS.diag, `表情包没配上图库：${missed.join('、')}`.slice(0, 300))
  }
  return { text: out, images, captions, matched: images.length, missed, skipped }
}

/** 测试用：丢掉目录与索引缓存。 */
export function clearMemeCache() {
  packsCache = { at: 0, dirs: [] }
  rowsCache.clear()
}

// ---- 设置页要看的：图库清单 + 最近的发送记录 ----

const STATE_PATH = join(PATHS.root, 'meme-state.json')
const EMPTY_STATE = Object.freeze({
  version: 1,
  converted: 0,
  images: 0,
  missedTotal: 0,
  lastAt: 0,
  lastCaption: '',
  lastPath: '',
  lastMissAt: 0,
  lastMissed: '',
})

/** 最近的「转成图片 / 没配上图库」记录（设置页 → 斗图）。 */
export function memeStats() {
  const raw = readJsonSafe(STATE_PATH, null)
  if (!raw || typeof raw !== 'object') return { ...EMPTY_STATE }
  return {
    version: 1,
    converted: Number(raw.converted) || 0,
    images: Number(raw.images) || 0,
    missedTotal: Number(raw.missedTotal) || 0,
    lastAt: Number(raw.lastAt) || 0,
    lastCaption: String(raw.lastCaption ?? ''),
    lastPath: String(raw.lastPath ?? ''),
    lastMissAt: Number(raw.lastMissAt) || 0,
    lastMissed: String(raw.lastMissed ?? ''),
  }
}

function bumpStats({ matched = 0, missed = [] } = {}) {
  if (!matched && !missed.length) return
  const now = Date.now()
  const stats = memeStats()
  if (matched) {
    stats.converted += 1
    stats.images += matched
    stats.lastAt = now
  }
  if (missed.length) {
    stats.missedTotal += missed.length
    stats.lastMissAt = now
    stats.lastMissed = missed.join('、').slice(0, 120)
  }
  try { writeJsonAtomic(STATE_PATH, stats) } catch { /* 统计写不进去不影响发送 */ }
}

/** 包目录的展示信息：名称取 manifest，张数按索引行算。 */
function packMeta(dir, rows) {
  let name = basename(dir)
  try {
    const manifest = readJsonSafe(join(dir, 'manifest.json'), null)
    if (manifest?.name) name = String(manifest.name)
  } catch { /* 没 manifest 就用目录名 */ }
  const own = rows.filter((row) => row.absolute.startsWith(dir + sep))
  return {
    id: basename(dir),
    name,
    dir,
    count: own.length,
    tags: [...new Set(own.map((row) => row.tag).filter(Boolean))].slice(0, 12),
  }
}

/**
 * 设置页 → 斗图 的数据源：开关、图库、总量、最近一次转图/配不上。
 *
 * @param {{ enabled?: boolean, maxImages?: number }} [settings] 来自 config.json 的 meme 段
 */
export function memeStatus(settings = {}) {
  const enabled = settings.enabled !== false
  const maxImages = Math.max(1, Math.min(4, Number(settings.maxImages) || 4))
  const roots = memeRoots()
  const rows = memeRows()
  const packs = discoverPacks(roots).map((dir) => packMeta(dir, rows)).filter((pack) => pack.count > 0)
  const tags = [...new Set(rows.map((row) => row.tag).filter(Boolean))]
  return {
    ok: true,
    enabled,
    maxImages,
    available: rows.length > 0,
    total: rows.length,
    packs,
    tags,
    roots: roots.map((dir) => ({ dir, exists: existsSync(dir) })),
    stats: memeStats(),
  }
}

/** 出站转换后记一笔，供设置页显示「最近转成了哪张图」。 */
export function recordMemeConversion(result) {
  const matched = Number(result?.matched) || 0
  const missed = Array.isArray(result?.missed) ? result.missed : []
  if (!matched && !missed.length) return
  bumpStats({ matched, missed })
  if (!matched) return
  const stats = memeStats()
  // lastPath/lastCaption 只用于展示，取这一轮真正发出去的第一张图。
  stats.lastPath = String(result?.images?.[0] ?? stats.lastPath)
  stats.lastCaption = String(result?.captions?.[0] ?? stats.lastCaption)
  try { writeJsonAtomic(STATE_PATH, stats) } catch { /* ignore */ }
}