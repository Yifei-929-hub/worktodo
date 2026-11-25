// 在真实 Electron 窗口中检查阶段 B（B1–B6）。通知只记录、不弹出。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const electronPath = createRequire(import.meta.url)('electron')
const dir = mkdtempSync(join(tmpdir(), 'worktodo-e2e-'))
const clockFile = join(dir, 'clock.txt')
const crashFile = join(dir, 'crash.txt')
const shots = process.env.WORKTODO_SHOTS
if (shots) mkdirSync(shots, { recursive: true })
const env = {
  ...process.env,
  WORKTODO_USER_DATA: join(dir, 'user-data'),
  WORKTODO_TEST_CLOCK: clockFile,
  WORKTODO_TEST_NOTIFY: '1'
}
delete env.ELECTRON_RUN_AS_NODE

const MIN = 60_000
let offset = 0
const setClock = (ms) => {
  offset = ms
  writeFileSync(clockFile, String(ms))
}
const now = () => Date.now() + offset
const pad = (n) => String(n).padStart(2, '0')
const key = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
/** 把程序时钟调到今天的 h:min:05 */
const goTo = (h, min) => {
  const d = new Date(now())
  d.setHours(h, min, 5, 0)
  setClock(d.getTime() - Date.now())
}
goTo(10, 0)

let app
let page
const problems = []
const isFloat = (p) => p.url().endsWith('#float')

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
const quit = async () => {
  const exited = new Promise((r) => app.process().once('exit', r))
  await app.close()
  await exited
}
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
const row = (title, p = page) => p.locator(`li[data-todo="${title}"]`)
const nav = (name) => page.locator('.nav-item', { hasText: name }).click()
const detail = () => page.locator('.detail')
async function add(title, p = page) {
  await p.getByLabel('快速添加').fill(title)
  await p.keyboard.press('Enter')
  await row(title).waitFor()
}
async function setTime(title, time, remind) {
  await row(title).locator('.row-main').click()
  await detail().locator('input[type=time]').fill(time)
  if (remind) await detail().getByLabel('提醒').selectOption({ label: remind })
  await row(title).getByText(time).waitFor()
  if (remind) {
    await eventually(
      async () => assert.equal(await detail().getByLabel('提醒').locator('option:checked').innerText(), remind),
      '提醒方式未更新'
    )
  }
}
const sent = () => app.evaluate(() => globalThis.testNotifications.map((n) => ({ title: n.title, body: n.body })))
const sentTitles = async () => (await sent()).map((n) => n.title)
const click = (title) =>
  app.evaluate((_e, t) => globalThis.testNotifications.findLast((n) => n.title === t).click(), title)
const expectSent = (expected) =>
  eventually(async () => assert.deepEqual(await sentTitles(), expected), '通知不符')
const settle = () => page.waitForTimeout(2300)
const mainWin = (fn, arg) =>
  app.evaluate(
    ({ BrowserWindow }, [code, a]) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('#main'))
      return new Function('w', 'a', `return ${code}`)(w, a)
    },
    [fn, arg]
  )
const floatWin = (fn, arg) =>
  app.evaluate(
    ({ BrowserWindow }, [code, a]) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('#float'))
      return w ? new Function('w', 'a', `return ${code}`)(w, a) : null
    },
    [fn, arg]
  )
const tray = (label) =>
  app.evaluate((_e, l) => globalThis.testTrayMenu().items.find((i) => i.label === l).click(), label)
const trayChecked = () =>
  app.evaluate(() => globalThis.testTrayMenu().items.find((i) => i.label === '悬浮窗').checked)
const floatPage = () =>
  eventually(async () => {
    const p = app.windows().find(isFloat)
    assert.ok(p)
    await p.getByLabel('快速添加').waitFor({ timeout: 1000 })
    return p
  }, '悬浮窗未出现')
const noFloat = () => eventually(async () => assert.equal(await floatWin('true'), null), '悬浮窗未关闭')
const shot = (name, p = page) => (shots ? p.screenshot({ path: join(shots, `${name}.png`) }) : undefined)

const steps = {
  'B1 到点与提前提醒，只填日期和不提醒的不弹，只弹一次': async () => {
    for (const t of ['到点', '提前五', '提前十五', '提前三十', '不弹', '只有日期']) await add(t)
    await setTime('到点', '11:00')
    await setTime('提前五', '11:00', '提前 5 分钟')
    await setTime('提前十五', '11:00', '提前 15 分钟')
    await setTime('提前三十', '11:00', '提前 30 分钟')
    await setTime('不弹', '11:00', '不提醒')
    await shot('remind')
    goTo(10, 29)
    await settle()
    await expectSent([])
    goTo(10, 30)
    await expectSent(['提前三十'])
    goTo(10, 45)
    await expectSent(['提前三十', '提前十五'])
    goTo(10, 55)
    await expectSent(['提前三十', '提前十五', '提前五'])
    goTo(11, 0)
    await expectSent(['提前三十', '提前十五', '提前五', '到点'])
    await settle()
    await expectSent(['提前三十', '提前十五', '提前五', '到点'])
    assert.equal((await sent())[0].body, '今天 11:00（提前 30 分钟提醒）')
  },
  'B4 完成、删除的不提醒，改时间后只按新时间提醒': async () => {
    const before = await sentTitles()
    for (const t of ['完成的', '删除的', '改时间的']) {
      await add(t)
      await setTime(t, '11:10')
    }
    await setTime('改时间的', '11:20')
    await row('删除的').locator('.row-main').click()
    await detail().getByRole('button', { name: '移到回收站' }).click()
    await row('完成的').getByRole('checkbox').click()
    await page.getByRole('button', { name: '跳过' }).click()
    goTo(11, 10)
    await settle()
    await expectSent(before)
    goTo(11, 20)
    await expectSent([...before, '改时间的'])
    // 改成已过的时刻不补弹
    await setTime('改时间的', '11:05')
    await settle()
    await expectSent([...before, '改时间的'])
  },
  'B2 关闭窗口后收进托盘并继续提醒，首次有提示，点通知定位': async () => {
    await add('托盘提醒')
    await setTime('托盘提醒', '11:30')
    await nav('未来')
    await mainWin('w.close()')
    await eventually(async () => assert.equal(await mainWin('w.isVisible()'), false), '窗口未隐藏')
    assert.equal((await sentTitles()).at(-1), 'WorkTodo 仍在运行')
    goTo(11, 30)
    await eventually(async () => assert.equal((await sentTitles()).at(-1), '托盘提醒'), '隐藏后未提醒')
    await click('托盘提醒')
    await eventually(async () => assert.equal(await mainWin('w.isVisible()'), true), '窗口未显示')
    await eventually(async () => assert.equal(await detail().getByLabel('标题').inputValue(), '托盘提醒'), '未定位')
    const count = (await sent()).length
    await mainWin('w.close()')
    await settle()
    assert.equal((await sent()).length, count) // 只提示一次
    await tray('打开主窗口')
    await eventually(async () => assert.equal(await mainWin('w.isVisible()'), true), '托盘未能打开主窗口')
  },
  'B2 再次打开只有一个实例，并显示已有窗口': async () => {
    await mainWin('w.close()')
    const code = await new Promise((r) => spawn(electronPath, [root], { env, stdio: 'ignore' }).once('exit', r))
    assert.equal(code, 0)
    await eventually(async () => assert.equal(await mainWin('w.isVisible()'), true), '未显示已有窗口')
  },
  '多项提醒同时迟到时合并成一条': async () => {
    for (const t of ['迟到一', '迟到二']) {
      await add(t)
      await setTime(t, '11:40')
    }
    goTo(11, 55)
    await eventually(async () => assert.equal((await sentTitles()).at(-1), '有 2 项提醒已过时间'), '未合并')
  },
  'B2 B3 从托盘退出后结束进程；错过的提醒启动后汇总一次，不重复': async () => {
    for (const t of ['错过一', '错过二']) {
      await add(t)
      await setTime(t, '12:30')
    }
    await add('错过但已完成')
    await setTime('错过但已完成', '12:30')
    await row('错过但已完成').getByRole('checkbox').click()
    const exited = new Promise((r) => app.process().once('exit', r))
    await tray('退出').catch(() => {}) // 退出时连接会中断
    assert.equal(await exited, 0)
    goTo(13, 0)
    await launch()
    const missed = page.getByLabel('错过的提醒')
    await missed.getByText('错过了 2 项提醒').waitFor()
    await shot('missed')
    await settle()
    assert.deepEqual(await sentTitles(), [])
    await missed.getByRole('button', { name: '错过一' }).click()
    assert.equal(await detail().getByLabel('标题').inputValue(), '错过一')
    await missed.getByRole('button', { name: '知道了' }).click()
    await missed.waitFor({ state: 'detached' })
    await quit()
    await launch()
    await settle()
    assert.equal(await page.getByLabel('错过的提醒').count(), 0)
    assert.deepEqual(await sentTitles(), [])
  },
  'B5 悬浮窗默认关闭，可从主窗口和托盘打开': async () => {
    assert.equal(await floatWin('true'), null)
    await nav('悬浮窗')
    await floatPage()
    assert.equal(await trayChecked(), true)
    await nav('悬浮窗')
    await noFloat()
    assert.equal(await trayChecked(), false)
    await tray('悬浮窗')
    await floatPage()
    await page.locator('.nav-float', { hasText: '已打开' }).waitFor()
  },
  'B5 只显示今天和逾期，勾选、添加与主窗口同步，点标题打开主窗口': async () => {
    const f = await floatPage()
    await nav('未来')
    await add('无日期的')
    await nav('今天')
    await add('主窗口添加')
    await row('主窗口添加', f).waitFor()
    assert.equal(await row('无日期的', f).count(), 0)
    await add('悬浮窗添加', f)
    await row('悬浮窗添加', f).waitFor()
    await row('悬浮窗添加', f).getByRole('checkbox').click()
    await row('悬浮窗添加', f).waitFor({ state: 'detached' })
    await page.locator('section[aria-label="今天已完成"]').locator('button.group-title').click()
    assert.equal(await row('悬浮窗添加').getByRole('checkbox').isChecked(), true)
    await row('主窗口添加').locator('.row-main').click()
    await detail().getByLabel('标题').fill('主窗口改名')
    await row('主窗口改名', f).waitFor()
    await nav('回收站')
    await mainWin('w.close()')
    await row('主窗口改名', f).locator('.row-main').click()
    await eventually(async () => assert.equal(await mainWin('w.isVisible()'), true), '未打开主窗口')
    await eventually(async () => assert.equal(await detail().getByLabel('标题').inputValue(), '主窗口改名'), '未定位')
    await shot('float', f)
    // 次日变为逾期，仍显示
    const tomorrow = now() + 24 * 60 * MIN
    setClock(offset + 24 * 60 * MIN)
    await f.locator('section[aria-label="已逾期"] li[data-todo="主窗口改名"]').waitFor()
    assert.equal(key(now()), key(tomorrow))
  },
  'B6 图钉切换置顶，重启后保持': async () => {
    let f = await floatPage()
    assert.equal(await floatWin('w.isAlwaysOnTop()'), true)
    await f.getByRole('button', { name: '置顶' }).click()
    await eventually(async () => assert.equal(await floatWin('w.isAlwaysOnTop()'), false), '未取消置顶')
    await quit()
    await launch()
    f = await floatPage()
    assert.equal(await floatWin('w.isAlwaysOnTop()'), false)
    await f.getByRole('button', { name: '置顶' }).click()
    await eventually(async () => assert.equal(await floatWin('w.isAlwaysOnTop()'), true), '未置顶')
  },
  'B6 可调整大小和拖动，重新打开和重启后位置大小不变；位置失效时回到屏幕内': async () => {
    assert.equal(await floatWin('w.isResizable() && w.isMovable()'), true)
    const f = await floatPage()
    assert.equal(
      await f.locator('.float-head').evaluate((e) => getComputedStyle(e).getPropertyValue('-webkit-app-region')),
      'drag'
    )
    await floatWin('w.setBounds(a)', { x: 120, y: 90, width: 340, height: 460 })
    const bounds = await floatWin('w.getBounds()')
    await f.getByRole('button', { name: '关闭悬浮窗' }).click()
    await noFloat()
    await nav('悬浮窗')
    await floatPage()
    assert.deepEqual(await floatWin('w.getBounds()'), bounds)
    await floatWin('w.setBounds(a)', { x: 200, y: 140, width: 300, height: 400 })
    const moved = await floatWin('w.getBounds()')
    await quit()
    await launch()
    await floatPage()
    assert.deepEqual(await floatWin('w.getBounds()'), moved)
    await floatWin('w.setPosition(-9000, -9000)')
    await page.waitForTimeout(600)
    await nav('悬浮窗')
    await noFloat()
    await nav('悬浮窗')
    await floatPage()
    const b = await floatWin('w.getBounds()')
    assert.ok(b.x > -1000 && b.y > -1000, JSON.stringify(b))
  },
  '关闭主窗口时悬浮窗仍可用；退出后两个窗口都关闭，主进程无报错': async () => {
    const f = await floatPage()
    await mainWin('w.close()')
    await f.getByLabel('快速添加').fill('隐藏时添加')
    await f.keyboard.press('Enter')
    await row('隐藏时添加', f).waitFor()
    await quit()
    assert.equal(existsSync(crashFile) ? readFileSync(crashFile, 'utf8') : '', '')
    assert.deepEqual(problems, [])
    await launch()
    await row('隐藏时添加').waitFor()
  }
}

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
      await shot('failure-b').catch(() => {})
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
