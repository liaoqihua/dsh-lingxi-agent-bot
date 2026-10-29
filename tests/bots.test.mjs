import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const root = mkdtempSync(join(tmpdir(), 'companion-bots-'))
const { BotRegistry, BOT_DEFAULT_PERMISSION, missingSessionDefaults, ownerNameFor } = await import('../lib/bots.js')

test('机器人：新增后落配置和状态目录，两段新会话默认配置各自独立', () => {
  const registry = new BotRegistry({ root })
  const bot = registry.add({
    channel: 'qq',
    name: '测试机器人',
    credentials: { appId: '123', appSecret: 'secret' },
    sessionDefaults: {
      c2c: { workspace: 'D:\\.dsh\\qq', defaultPermission: 'workspace-write' },
      group: { workspace: 'D:\\.dsh\\qq-group', defaultPermission: 'read-only' },
    },
  })
  assert.match(bot.id, /^qq-/)
  assert.equal(bot.sessionDefaults.c2c.workspace, 'D:\\.dsh\\qq')
  assert.equal(bot.sessionDefaults.c2c.defaultPermission, 'workspace-write')
  assert.equal(bot.sessionDefaults.group.workspace, 'D:\\.dsh\\qq-group')
  assert.equal(bot.sessionDefaults.group.defaultPermission, 'read-only')
  assert.equal(bot.sessionDefaults.c2c.preset, '')
  assert.equal('workspace' in bot, false)
  assert.equal('sessionId' in bot, false)
  assert.equal(registry.list().length, 1)
  assert.equal(registry.list('feishu').length, 0)
  const dir = join(root, 'bots', bot.id)
  for (const name of ['persona.md', 'memory.json', 'mood.json', 'proactive.json', 'chats.json']) {
    assert.ok(existsSync(join(dir, name)), `应该有 ${name}`)
  }
  const persona = readFileSync(join(dir, 'persona.md'), 'utf8')
  assert.match(persona, /测试机器人/)
  const disk = JSON.parse(readFileSync(join(root, 'bots.json'), 'utf8'))
  assert.equal(disk.bots[0].id, bot.id)
  assert.equal(disk.bots[0].sessionDefaults.c2c.workspace, 'D:\\.dsh\\qq')
  assert.equal('workspace' in disk.bots[0], false)
})

test('机器人：新增时的默认权限缺省为 workspace-write', () => {
  const registry = new BotRegistry({ root: mkdtempSync(join(tmpdir(), 'companion-bots-perm-')) })
  const bot = registry.add({ channel: 'qq', name: '默认权限机器人', credentials: { appId: 'perm-1' } })
  assert.equal(bot.sessionDefaults.c2c.defaultPermission, BOT_DEFAULT_PERMISSION)
  assert.equal(bot.sessionDefaults.group.defaultPermission, BOT_DEFAULT_PERMISSION)
  assert.deepEqual(missingSessionDefaults(bot.sessionDefaults), ['私聊：工作区', '群聊：工作区'])
})

test('机器人：旧顶层字段加载时忽略，两段默认配置回落到空白', () => {
  const legacyRoot = mkdtempSync(join(tmpdir(), 'companion-bots-legacy-'))
  writeLegacy(legacyRoot)
  const registry = new BotRegistry({ root: legacyRoot })
  const bot = registry.list()[0]
  assert.equal(bot.id, 'qq-legacy')
  assert.equal(bot.sessionDefaults.c2c.workspace, '')
  assert.equal('workspace' in bot, false)
  assert.equal('preset' in bot, false)
  assert.equal('provider' in bot, false)
  assert.equal('model' in bot, false)
  assert.equal('sessionId' in bot, false)
  assert.equal('defaultPermission' in bot, false)
})

function writeLegacy(legacyRoot) {
  mkdirSync(legacyRoot, { recursive: true })
  writeFileSync(join(legacyRoot, 'bots.json'), JSON.stringify({
    version: 1,
    bots: [{
      id: 'qq-legacy',
      channel: 'qq',
      name: '旧机器人',
      workspace: 'D:\\old',
      preset: 'old-preset',
      provider: 'old-provider',
      model: 'old-model',
      sessionId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      defaultPermission: 'read-only',
      createdAt: 1,
      updatedAt: 1,
    }],
  }, null, 2), 'utf8')
}

test('机器人：更新保留 id/createdAt，可改两段工作区和默认权限', () => {
  const registry = new BotRegistry({ root })
  const bot = registry.list()[0]
  const updated = registry.update(bot.id, {
    sessionDefaults: {
      c2c: { workspace: 'D:\\new', defaultPermission: 'read-only' },
      group: { workspace: 'D:\\new-group', defaultPermission: 'danger-full-access' },
    },
  })
  assert.equal(updated.id, bot.id)
  assert.equal(updated.createdAt, bot.createdAt)
  assert.equal(updated.sessionDefaults.c2c.workspace, 'D:\\new')
  assert.equal(updated.sessionDefaults.c2c.defaultPermission, 'read-only')
  assert.equal(updated.sessionDefaults.group.workspace, 'D:\\new-group')
  assert.equal(updated.sessionDefaults.group.defaultPermission, 'danger-full-access')
})

test('机器人：非法通道拒绝，重复 id 拒绝', () => {
  const registry = new BotRegistry({ root })
  assert.throws(() => registry.add({ channel: 'telegram', name: 'x' }), /通道/)
  const bot = registry.list()[0]
  assert.throws(() => registry.add({ id: bot.id, channel: 'qq', name: '重复' }), /已存在/)
})

test('机器人：同一通道同一凭据重复接入会被拒绝', () => {
  const registry = new BotRegistry({ root })
  registry.add({ channel: 'qq', name: 'QQ 一号', credentials: { appId: 'dup-qq', appSecret: 's' } })
  assert.throws(
    () => registry.add({ channel: 'qq', name: 'QQ 二号', credentials: { appId: 'dup-qq', appSecret: 's' } }),
    /已经接入/,
  )
  registry.add({ channel: 'feishu', name: '飞书一号', credentials: { appId: 'dup-fs', appSecret: 's', ownerOpenId: 'o' } })
  assert.throws(
    () => registry.add({ channel: 'feishu', name: '飞书二号', credentials: { appId: 'dup-fs', appSecret: 's', ownerOpenId: 'o' } }),
    /已经接入/,
  )
  registry.add({ channel: 'webhook', name: '微信一号', credentials: { accountId: 'dup-wx', token: 't' } })
  assert.throws(
    () => registry.add({ channel: 'webhook', name: '微信二号', credentials: { accountId: 'dup-wx', token: 't' } }),
    /已经接入/,
  )
})

test('机器人：删除后配置和状态目录都删除，不归档', () => {
  const registry = new BotRegistry({ root })
  const bot = registry.list()[0]
  const dir = join(root, 'bots', bot.id)
  assert.ok(existsSync(dir))
  assert.equal(registry.remove(bot.id), true)
  assert.equal(registry.get(bot.id), null)
  assert.equal(existsSync(dir), false)
  assert.equal(existsSync(join(root, 'bots-removed')), false)
})

test('机器人：称呼按机器人存 bots.json，去空白、截 32 字，空串表示回落全局', () => {
  const registry = new BotRegistry({ root: mkdtempSync(join(tmpdir(), 'companion-bots-owner-')) })
  const bot = registry.add({ channel: 'qq', name: '昵称机器人', ownerName: '  小明  ', credentials: { appId: 'owner-1' } })
  assert.equal(bot.ownerName, '小明')
  assert.equal(registry.update(bot.id, { ownerName: '小'.repeat(40) }).ownerName.length, 32)
  assert.equal(registry.update(bot.id, { ownerName: '小 Q' }).ownerName, '小 Q')
  assert.equal(registry.update(bot.id, { ownerName: '' }).ownerName, '')
  // 老 bots.json 里没有这个字段：加载出来是空串，不是 undefined。
  const legacy = registry.add({ channel: 'qq', name: '老机器人', credentials: { appId: 'owner-2' } })
  assert.equal(legacy.ownerName, '')
})

test('称呼解析：机器人自己设过就用它，没设过回落插件级默认', () => {
  const config = { identity: { ownerName: '主人' } }
  assert.equal(ownerNameFor({ ownerName: '小明' }, config), '小明')
  assert.equal(ownerNameFor({ ownerName: '   ' }, config), '主人')
  assert.equal(ownerNameFor({}, config), '主人')
  assert.equal(ownerNameFor(null, config), '主人')
  // 全局也留空时还得有个兜底，别让提示词里出现空名字。
  assert.equal(ownerNameFor(null, { identity: { ownerName: '' } }), '主人')
  assert.equal(ownerNameFor(null, {}), '主人')
})

test.after(() => rmSync(root, { recursive: true, force: true }))
