// 灵犀 · 右下角心情挂饰（宿主侧）
//
// 机制照抄 dsh-feiyu-mood：
//   1. 注册 /api/companion/widget.js 与图片路由；
//   2. 监听 webserver/index-inject，把加载挂饰脚本的一行注入页面；
//   3. 挂饰脚本自己拉 /api/companion/mood?botId=... 渲染。
//
// 与 dsh-feiyu-mood 的唯一区别：心情按机器人隔离，所以挂饰面板允许选择机器人，
// 选择结果存在 localStorage，页面刷新后仍然记得。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PATHS } from './config.js'
import { appendLog } from './util.js'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ASSET_DIR = join(PACKAGE_ROOT, 'assets', 'widget')

const SCRIPT_PATH = '/api/companion/widget.js'
const IMAGE_PREFIX = '/api/companion/widget/'
const IMAGE_FILES = new Set([
  'feiyu.png',
  'face-great.png',
  'face-good.png',
  'face-ok.png',
  'face-worry.png',
  'face-sad.png',
])

// 页面注入行：只负责把 widget.js 加载进来；重复注入会被下面的去重逻辑挡住。
const WIDGET_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;'
  + 'var s=document.createElement("script");s.src="' + SCRIPT_PATH + '";'
  + 's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

function hasWidgetRow(table) {
  for (const row of table) {
    if (!row || typeof row !== 'object') continue
    if (row.kind === 'script-src' && row.src === SCRIPT_PATH) return true
    if (row.kind === 'script' && typeof row.text === 'string' && row.text.includes(SCRIPT_PATH)) return true
  }
  return false
}

export function installMoodWidget(ctx, { logger } = {}) {
  const disposers = []
  const register = (path, handler) => {
    try {
      const dispose = ctx.webServer.register({ kind: 'exact', path, handler })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      appendLog(PATHS.diag, `心情挂饰路由注册失败（${path}）：${error?.message ?? error}`)
    }
  }

  register(SCRIPT_PATH, (req, res) => {
    try {
      const text = readFileSync(join(ASSET_DIR, 'widget.js'), 'utf8')
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text)
    } catch (error) {
      appendLog(PATHS.diag, '心情挂饰脚本读取失败：' + (error?.message ?? error))
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('widget.js not found')
    }
  })

  for (const file of IMAGE_FILES) {
    register(IMAGE_PREFIX + file, (req, res) => {
      try {
        const bytes = readFileSync(join(ASSET_DIR, file))
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
        res.end(bytes)
      } catch (error) {
        appendLog(PATHS.diag, `心情挂饰图片读取失败（${file}）：${error?.message ?? error}`)
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('image not found')
      }
    })
  }

  // 只读诊断：确认挂饰脚本行真的出现在宿主 index 注入表里。
  register('/api/companion/widget/status', (req, res) => {
    let rows = null
    let error = ''
    try {
      rows = ctx.webServer.collectIndexInjections?.()
    } catch (cause) {
      error = String(cause?.message ?? cause)
    }
    const list = Array.isArray(rows) ? rows : []
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      ok: true,
      scriptPath: SCRIPT_PATH,
      collectAvailable: Array.isArray(rows),
      injected: list.some((row) => hasWidgetRow([row])),
      rows: list.length,
      error,
    }))
  })

  try {
    const off = ctx.on?.('webserver/index-inject', (table) => {
      if (!Array.isArray(table)) return
      if (hasWidgetRow(table)) return
      table.push({ kind: 'script', placement: 'body', text: WIDGET_ROW_TEXT })
    })
    if (typeof off === 'function') disposers.push(off)
  } catch (error) {
    appendLog(PATHS.diag, '心情挂饰注入失败：' + (error?.message ?? error))
  }

  logger?.info?.('companion: 右下角心情挂饰已注册')
  return () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* ignore */ }
    }
  }
}