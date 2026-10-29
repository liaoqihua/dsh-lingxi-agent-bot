import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

// 图库根用 DSH_MEME_ROOTS 显式指定，插件数据目录用临时盘，避免碰到真实 ~/.dsh。
const home = mkdtempSync(join(tmpdir(), 'companion-meme-'))
process.env.DSH_HOME = join(home, 'plugin')
const packsRoot = join(home, 'meme-packs')
const packDir = join(packsRoot, 'test-001')
process.env.DSH_MEME_ROOTS = packsRoot

const { clearMemeCache, findMeme, memeStatus, recordMemeConversion, renderMemeMarkers } =
  await import('../lib/meme.js')
const { PATHS } = await import('../lib/config.js')

function seedPack() {
  mkdirSync(join(packDir, 'memes', 'happy'), { recursive: true })
  mkdirSync(join(packDir, 'memes', 'angry'), { recursive: true })
  writeFileSync(join(packDir, 'memes', 'happy', 'deyi.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0x01]))
  writeFileSync(join(packDir, 'memes', 'angry', 'shengqi.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0x02]))
  writeFileSync(join(packDir, 'manifest.json'), JSON.stringify({ name: '测试图库', version: '1' }), 'utf8')
  const db = new DatabaseSync(join(packDir, 'index.db'))
  db.exec('CREATE TABLE memes (path TEXT PRIMARY KEY, tag TEXT, file_name TEXT, caption TEXT, keywords TEXT)')
  const insert = db.prepare('INSERT INTO memes (path, tag, file_name, caption, keywords) VALUES (?, ?, ?, ?, ?)')
  insert.run('memes/happy/deyi.jpg', 'happy', 'deyi.jpg', '得意闭眼拳头，好耶', '得意 好耶 满意')
  insert.run('memes/angry/shengqi.jpg', 'angry', 'shengqi.jpg', '气鼓鼓叉腰，额头冒火', '生气 愤怒 叉腰')
  db.close()
}

seedPack()
clearMemeCache()

test.after(() => rmSync(home, { recursive: true, force: true }))

test('斗图：标记按描述换成真实图片路径', () => {
  const result = renderMemeMarkers('哈哈，[表情: 得意闭眼拳头，好耶] 给你看')
  assert.equal(result.matched, 1)
  assert.equal(result.missed.length, 0)
  assert.equal(result.images.length, 1)
  assert.ok(result.images[0].endsWith(join('memes', 'happy', 'deyi.jpg')))
  assert.match(result.text, /!\[表情\]\(.+deyi\.jpg\)/)
  assert.ok(!result.text.includes('[表情:'))
  assert.ok(result.text.startsWith('哈哈，'))
})

test('斗图：模型多写半句也能配上（包含匹配）', () => {
  const hit = findMeme('得意闭眼拳头')
  assert.ok(hit)
  assert.ok(hit.absolute.endsWith('deyi.jpg'))
  const loose = renderMemeMarkers('[表情：气鼓鼓叉腰]')
  assert.equal(loose.matched, 1)
  assert.ok(loose.images[0].endsWith('shengqi.jpg'))
})

test('斗图：描述完全配不上就丢掉标记并记下来', () => {
  clearMemeCache()
  const result = renderMemeMarkers('这条别丢：[表情: 一只完全不存在的小恐龙] 结束')
  assert.equal(result.matched, 0)
  assert.deepEqual(result.missed, ['一只完全不存在的小恐龙'])
  assert.ok(!result.text.includes('表情'))
  assert.ok(result.text.includes('这条别丢'))
  recordMemeConversion(result)
  const status = memeStatus({ enabled: true, maxImages: 4 })
  assert.equal(status.stats.missedTotal, 1)
  assert.equal(status.stats.lastMissed, '一只完全不存在的小恐龙')
})

test('斗图：单轮张数上限生效，超出的标记被丢弃', () => {
  const result = renderMemeMarkers(
    '[表情: 得意闭眼拳头，好耶] 中间 [表情: 气鼓鼓叉腰，额头冒火] 尾巴 [表情: 得意闭眼拳头，好耶]',
    { maxImages: 1 },
  )
  assert.equal(result.matched, 1)
  assert.equal(result.skipped, 2)
  assert.equal(result.images.length, 1)
  assert.ok(!result.text.includes('[表情:'))
})

test('斗图：状态里能看到图库清单与发送统计', () => {
  clearMemeCache()
  recordMemeConversion({
    matched: 1,
    missed: [],
    images: [join(packDir, 'memes', 'happy', 'deyi.jpg')],
    captions: ['得意闭眼拳头，好耶'],
  })
  const status = memeStatus({ enabled: false, maxImages: 2 })
  assert.equal(status.enabled, false)
  assert.equal(status.maxImages, 2)
  assert.equal(status.available, true)
  assert.equal(status.total, 2)
  assert.equal(status.packs.length, 1)
  assert.equal(status.packs[0].name, '测试图库')
  assert.equal(status.packs[0].count, 2)
  assert.deepEqual([...status.packs[0].tags].sort(), ['angry', 'happy'])
  assert.equal(status.stats.images, 1)
  assert.equal(status.stats.lastCaption, '得意闭眼拳头，好耶')
  // 统计落盘，重开进程也读得回来
  const raw = JSON.parse(readFileSync(join(PATHS.root, 'meme-state.json'), 'utf8'))
  assert.equal(raw.images, 1)
  assert.equal(raw.missedTotal, 1)
})

test('斗图：没有标记时原样返回，不碰图库', () => {
  const text = '普通一句话，没有表情包'
  const result = renderMemeMarkers(text)
  assert.equal(result.text, text)
  assert.equal(result.images.length, 0)
})