// 在真实 Electron 窗口中检查备份与恢复（D1、D2）。文件选择框由测试代答。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const dir = mkdtempSync(join(tmpdir(), 'worktodo-e2e-'))
const userData = join(dir, 'user-data')
const dbFile = join(userData, 'data', 'worktodo.db')
const backupDir = join(userData, 'backups')
const clockFile = join(dir, 'clock.txt')
const crashFile = join(dir, 'crash.txt')
const exported = join(dir, '导出.worktodo-backup')
const shots = process.env.WORKTODO_SHOTS
if (shots) mkdirSync(shots, { recursive: true })
const env = { ...process.env, WORKTODO_USER_DATA: userData, WORKTODO_TEST_CLOCK: clockFile, WORKTODO_TEST_NOTIFY: '1' }
delete env.ELECTRON_RUN_AS_NODE

const start = new Date()
start.setHours(10, 0, 0, 0)
let offset = start.getTime() - Date.now()
const setClock = (ms) => {
  offset = ms
  writeFileSync(clockFile, String(ms))
}
setClock(offset)

let app
let page
const problems = []
async function eventually(fn, message) {
  let last
  for (let i = 0; i < 60; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error(`${message}: ${last}`)
}
async function launch() {
  app = await _electron.launch({ args: [root], env })
  await app.evaluate((_e, file) => {
    process.on('uncaughtException', (e) => process.getBuiltinModule('node:fs').appendFileSync(file, e.stack + '\n'))
  }, crashFile)
  page = await eventually(() => {
    const p = app.windows().find((w) => w.url().endsWith('#main'))
    assert.ok(p)
    return p
  }, '主窗口未出现')
  page.on('pageerror', (e) => problems.push(String(e)))
  await page.getByLabel('快速添加').waitFor()
}
const nav = (name) => page.locator('.nav-item', { hasText: name }).click()
const row = (title) => page.locator(`li[data-todo="${title}"]`)
const detail = () => page.locator('.detail')
async function add(title) {
  await page.getByLabel('快速添加').fill(title)
  await page.keyboard.press('Enter')
  await row(title).waitFor()
}
const answer = (save, open) =>
  app.evaluate(
    ({ dialog }, [s, o]) => {
      dialog.showSaveDialog = async () => ({ canceled: !s, filePath: s ?? '' })
      dialog.showOpenDialog = async () => ({ canceled: !o, filePaths: o ? [o] : [] })
    },
    [save, open]
  )
const titles = () => {
  const db = new DatabaseSync(dbFile)
  const list = db.prepare('SELECT title FROM todos WHERE deleted_at IS NULL ORDER BY title').all().map((r) => r.title)
  db.close()
  return list
}
const restoreButton = () => page.getByRole('button', { name: '从文件恢复' })
const confirm = (name) => page.getByRole('dialog').getByRole('button', { name, exact: true }).click()
const files = (prefix) => readdirSync(backupDir).filter((f) => f.startsWith(prefix)).sort()
const alert = (text) => page.locator('.backup [role=alert]').getByText(text).waitFor()

const steps = {
  'D2 首次启动当天备份一份，再次启动不重复': async () => {
    await add('甲')
    await eventually(() => assert.equal(files('auto-').length, 1), '没有自动备份')
    await app.close()
    await launch()
    await page.waitForTimeout(1500)
    assert.equal(files('auto-').length, 1)
  },
  'D1 导出，取消不生成文件；输入条里未保存的文字也在备份中': async () => {
    await row('甲').getByRole('checkbox').click()
    await page.getByPlaceholder('选填，写日志时会用到').fill('甲的结果')
    await nav('备份与恢复')
    await answer(null, null)
    await page.getByRole('button', { name: '导出备份' }).click()
    await page.waitForTimeout(300)
    assert.equal(existsSync(exported), false)
    await answer(exported, null)
    await page.getByRole('button', { name: '导出备份' }).click()
    await page.getByText('已导出到').waitFor()
    const db = new DatabaseSync(exported)
    assert.equal(db.prepare('SELECT result FROM todos').get().result, '甲的结果')
    db.close()
    await shot('backup')
  },
  'D1 不能导出到数据目录': async () => {
    await answer(join(backupDir, 'x.worktodo-backup'), null)
    await page.getByRole('button', { name: '导出备份' }).click()
    await alert('数据目录')
    assert.equal(existsSync(join(backupDir, 'x.worktodo-backup')), false)
  },
  'D1 修改后恢复与导出时一致，先确认，并保存恢复前的数据': async () => {
    await nav('今天')
    await add('乙')
    await row('乙').locator('.row-main').click()
    await nav('备份与恢复')
    await answer(null, exported)
    await restoreButton().click()
    await page.getByRole('dialog').getByText('1 项待办').waitFor()
    await shot('restore')
    await confirm('取消')
    assert.deepEqual(titles(), ['乙', '甲'])
    await restoreButton().click()
    await confirm('恢复')
    await page.getByText('已恢复。').waitFor()
    assert.deepEqual(titles(), ['甲'])
    assert.equal(files('before-restore-').length, 1)
    await nav('今天')
    assert.equal(await row('乙').count(), 0)
    assert.equal(await detail().count(), 0)
    await page.locator('section[aria-label="今天已完成"]').locator('button.group-title').click()
    await row('甲').locator('.row-main').click()
    assert.equal(await detail().getByLabel('完成情况').inputValue(), '甲的结果')
  },
  'D1 可从恢复前的备份找回': async () => {
    await nav('备份与恢复')
    await page.locator('li[data-backup^="before-restore-"]').getByRole('button', { name: '恢复' }).click()
    await confirm('恢复')
    await page.getByText('已恢复。').waitFor()
    assert.deepEqual(titles(), ['乙', '甲'])
  },
  'D1 无效文件被拒绝，数据不变': async () => {
    const bad = join(dir, '无效.worktodo-backup')
    writeFileSync(bad, '这不是备份')
    await answer(null, bad)
    await restoreButton().click()
    await alert('备份文件无效')
    assert.equal(await page.getByRole('dialog').count(), 0)
    assert.deepEqual(titles(), ['乙', '甲'])
  },
  'D1 数据库被占用时恢复失败并提示，数据不变': async () => {
    await answer(null, exported)
    await restoreButton().click()
    await page.getByRole('dialog').waitFor()
    const db = new DatabaseSync(dbFile)
    db.exec('BEGIN IMMEDIATE')
    await confirm('恢复')
    await alert('当前数据没有改变')
    db.exec('ROLLBACK')
    db.close()
    assert.deepEqual(titles(), ['乙', '甲'])
    await page.locator('.error').getByRole('button', { name: '知道了' }).click()
  },
  'D1 有未保存的修改时不能恢复；恢复后悬浮窗同步': async () => {
    await nav('悬浮窗')
    const f = await eventually(() => {
      const p = app.windows().find((w) => w.url().endsWith('#float'))
      assert.ok(p)
      return p
    }, '悬浮窗未出现')
    await f.locator('li[data-todo="乙"]').waitFor()
    await nav('今天')
    await row('乙').locator('.row-main').click()
    const db = new DatabaseSync(dbFile)
    db.exec('BEGIN IMMEDIATE')
    await detail().getByLabel('标题').fill('乙改')
    await page.getByText('有修改尚未保存，文字已保留').waitFor()
    await nav('备份与恢复')
    assert.equal(await restoreButton().isDisabled(), true)
    db.exec('ROLLBACK')
    db.close()
    await eventually(async () => assert.equal(await restoreButton().isDisabled(), false), '保存后仍不可恢复')
    assert.deepEqual(titles(), ['乙改', '甲'])
    await restoreButton().click()
    await confirm('恢复')
    await page.getByText('已恢复。').waitFor()
    await f.locator('li[data-todo="乙改"]').waitFor({ state: 'detached' })
    await page.waitForTimeout(3500) // 超过重试间隔，旧修改不会写回
    assert.deepEqual(titles(), ['甲'])
  },
  'D2 跨天运行时备份，超过 7 份删最旧': async () => {
    for (let i = 0; i < 8; i++) {
      const before = files('auto-').at(-1)
      setClock(offset + 86_400_000)
      await eventually(() => assert.notEqual(files('auto-').at(-1), before), '跨天未备份')
      // 写入新的和删除最旧的之间短暂有 8 份，等删除完成再判断
      await eventually(() => assert.ok(files('auto-').length <= 7), '超过 7 份')
    }
    assert.equal(files('auto-').length, 7)
    assert.equal(readdirSync(backupDir).some((f) => /part|tmp|wal|shm/.test(f)), false)
  },
  '无报错': async () => {
    await app.close()
    assert.equal(existsSync(crashFile) ? readFileSync(crashFile, 'utf8') : '', '')
    assert.deepEqual(problems, [])
  }
}
const shot = (name) => (shots ? page.screenshot({ path: join(shots, `${name}.png`) }) : undefined)

let failed = 0
try {
  await launch()
  for (const [name, fn] of Object.entries(steps)) {
    try {
      await fn()
      console.log(`通过  ${name}`)
    } catch (e) {
      failed++
      console.log(`失败  ${name}\n${e.stack}`)
      await shot('failure-backup')?.catch(() => {})
      break
    }
  }
} finally {
  await app?.close().catch(() => {})
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch (e) {
    console.log(`临时目录未能清理：${e.message}`)
  }
}
process.exit(failed ? 1 : 0)
