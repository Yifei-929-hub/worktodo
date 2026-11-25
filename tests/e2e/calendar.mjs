// 在真实 Electron 窗口中检查日历（E1–E8）。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const dir = mkdtempSync(join(tmpdir(), 'worktodo-e2e-'))
const clockFile = join(dir, 'clock.txt')
const crashFile = join(dir, 'crash.txt')
const dbFile = join(dir, 'user-data', 'data', 'worktodo.db')
const shots = process.env.WORKTODO_SHOTS
if (shots) mkdirSync(shots, { recursive: true })
const env = {
  ...process.env,
  WORKTODO_USER_DATA: join(dir, 'user-data'),
  WORKTODO_TEST_CLOCK: clockFile,
  WORKTODO_TEST_NOTIFY: '1'
}
delete env.ELECTRON_RUN_AS_NODE

const HOUR = 72
let offset = 0
const setClock = (ms) => {
  offset = ms
  writeFileSync(clockFile, String(ms))
}
const pad = (n) => String(n).padStart(2, '0')
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
// 固定在本周的周三上午 10 点，前后都有同一周的日子
const start = new Date()
start.setDate(start.getDate() - ((start.getDay() + 6) % 7) + 2)
start.setHours(10, 0, 5, 0)
setClock(start.getTime() - Date.now())
const day = (n) => {
  const d = new Date(start)
  d.setDate(d.getDate() + n)
  return keyOf(d)
}
const TODAY = day(0)

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
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()))
  await page.getByLabel('快速添加').waitFor()
}
async function relaunch() {
  await app.close()
  await launch()
}
const nav = (name) => page.locator('.nav-item', { hasText: name }).click()
const mode = (name) => page.locator('.cal-bar').getByRole('button', { name, exact: true }).click()
const block = (title) => page.locator(`.cal-block[data-item="${title}"]`)
const chip = (title) => page.locator(`.cal-chip[data-item="${title}"]`)
const detail = () => page.locator('.detail')
const closeDetail = () => detail().getByRole('button', { name: '关闭' }).click()
const row = (title) => page.locator(`li[data-todo="${title}"]`)
const shot = (name) => (shots ? page.screenshot({ path: join(shots, `${name}.png`) }) : undefined)
/** 直接读库 */
const saved = (title) => {
  const db = new DatabaseSync(dbFile)
  try {
    const r = db.prepare('SELECT date, time, end_time AS endTime FROM todos WHERE title = ?').get(title)
    return r && { ...r }
  } finally {
    db.close()
  }
}
const expectSaved = (title, date, time, endTime) =>
  eventually(async () => assert.deepEqual(saved(title), { date, time, endTime }), `${title} 保存的内容不符`)
const scrollTo = (minutes) =>
  page.locator('.cal-scroll').evaluate((e, top) => (e.scrollTop = top), Math.max(0, (minutes / 60) * HOUR))
/** 时间轴上某天某分钟的屏幕坐标 */
async function at(d, minutes, dx = 0.5) {
  const box = await page.locator(`[data-column="${d}"]`).boundingBox()
  return [box.x + box.width * dx, box.y + (minutes / 60) * HOUR]
}
async function drag(from, to, release = true) {
  await page.mouse.move(...from)
  await page.mouse.down()
  await page.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 5 })
  await page.mouse.move(...to, { steps: 8 })
  await page.waitForTimeout(60)
  if (release) await page.mouse.up()
}
const typeDraft = async (title) => {
  await page.getByLabel('新建待办标题').fill(title)
  await page.keyboard.press('Enter')
  await page.getByLabel('新建待办标题').waitFor({ state: 'detached' })
}
const center = async (locator) => {
  const b = await locator.boundingBox()
  return [b.x + b.width / 2, b.y + b.height / 2]
}
const M = (h, m = 0) => h * 60 + m

const steps = {
  'E2 默认周视图，从周一开始，含今天': async () => {
    await nav('日历')
    const days = await page.locator('[data-column]').evaluateAll((l) => l.map((e) => e.dataset.column))
    assert.deepEqual(days, [-2, -1, 0, 1, 2, 3, 4].map(day))
    await scrollTo(M(8, 30))
  },
  'E5 点空白取最近的整半点，拖选同时填开始和结束，取消不留数据': async () => {
    await page.mouse.click(...(await at(TODAY, M(11, 10))))
    await page.getByLabel('新建待办标题').waitFor()
    await page.keyboard.press('Escape')
    assert.equal(await page.getByLabel('新建待办标题').count(), 0)
    await page.mouse.click(...(await at(TODAY, M(11, 10))))
    await typeDraft('点选')
    await expectSaved('点选', TODAY, '11:00', null)
    await drag(await at(day(1), M(13, 3)), await at(day(1), M(14, 28)))
    await typeDraft('拖选')
    await expectSaved('拖选', day(1), '13:00', '14:30')
    await drag(await at(day(1), M(15)), await at(day(1), M(16)), false)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    assert.equal(await page.getByLabel('新建待办标题').count(), 0)
    await page.locator(`.allday-cell[data-cell="${TODAY}"]`).click()
    await typeDraft('全天')
    await expectSaved('全天', TODAY, null, null)
    const db = new DatabaseSync(dbFile)
    assert.equal(db.prepare('SELECT count(*) AS n FROM todos').get().n, 3)
    db.close()
  },
  'E3 位置和高度与时间一致，没有结束时间的显示 30 分钟': async () => {
    for (const [title, d, from, len] of [['点选', TODAY, M(11), 30], ['拖选', day(1), M(13), 90]]) {
      const b = await block(title).boundingBox()
      const c = await page.locator(`[data-column="${d}"]`).boundingBox()
      assert.ok(Math.abs(b.y - c.y - (from / 60) * HOUR) < 1, `${title} 位置`)
      assert.ok(Math.abs(b.height - (len / 60) * HOUR) < 1, `${title} 高度`)
    }
  },
  'E1 详情中填、改、清空结束时间，无效的提示且不保存': async () => {
    await block('点选').locator('.cal-open').click()
    const end = detail().getByLabel('结束时间')
    await end.fill('10:00')
    await detail().getByText('结束时间要晚于开始时间').waitFor()
    await detail().getByLabel('标题').focus()
    assert.equal(await end.inputValue(), '')
    await expectSaved('点选', TODAY, '11:00', null)
    await end.fill('12:15')
    await expectSaved('点选', TODAY, '11:00', '12:15')
    await detail().getByLabel('时间', { exact: true }).fill('09:30')
    await expectSaved('点选', TODAY, '09:30', '10:45')
    await detail().getByRole('button', { name: '清空结束时间' }).click()
    await expectSaved('点选', TODAY, '09:30', null)
    // 键盘逐键改开始时间，时长以输入前为准
    await end.fill('11:30')
    await expectSaved('点选', TODAY, '09:30', '11:30')
    const time = detail().getByLabel('时间', { exact: true })
    await time.focus()
    await page.keyboard.type('2330', { delay: 60 })
    await eventually(async () => assert.equal(saved('点选').time, '23:30'), '键盘输入未保存')
    await expectSaved('点选', TODAY, '23:30', '23:59')
    await time.fill('09:30')
    await detail().getByLabel('标题').focus()
    await expectSaved('点选', TODAY, '09:30', '11:30')
    await nav('今天')
    await row('点选').getByText('09:30–11:30').waitFor()
    await nav('日历')
    await scrollTo(M(8, 30))
  },
  'E6 拖动改时间、改日期，保持时长；点一下只打开不改': async () => {
    const [x, y] = await at(TODAY, M(9, 45))
    await drag([x, y], [x, y + HOUR + 4])
    await expectSaved('点选', TODAY, '10:30', '12:30')
    await drag(await at(TODAY, M(11)), await at(day(1), M(11)))
    await expectSaved('点选', day(1), '10:30', '12:30')
    assert.equal(await detail().count(), 0) // 拖动不打开详情
    await block('点选').locator('.cal-open').click()
    await detail().waitFor()
    await closeDetail()
    await expectSaved('点选', day(1), '10:30', '12:30')
    // 拖动后用键盘打开不受影响
    await drag(await at(day(1), M(11)), await at(day(2), M(11)))
    await expectSaved('点选', day(2), '10:30', '12:30')
    await block('点选').locator('.cal-open').focus()
    await page.keyboard.press('Enter')
    await detail().waitFor()
    await closeDetail()
  },
  'E6 拖下边缘改时长，最短 15 分钟；没有结束时间的拖后才写入': async () => {
    const handle = async (title) => center(block(title).locator('.cal-handle'))
    let h = await handle('点选')
    await drag(h, [h[0], h[1] + HOUR / 2])
    await expectSaved('点选', day(2), '10:30', '13:00')
    h = await handle('点选')
    await drag(h, [h[0], h[1] - HOUR * 3.2])
    await expectSaved('点选', day(2), '10:30', '10:45')
    await page.mouse.click(...(await at(day(3), M(10))))
    await typeDraft('无结束')
    h = await handle('无结束')
    await drag(h, [h[0], h[1] + HOUR / 4])
    await expectSaved('无结束', day(3), '10:00', '10:45')
  },
  'E6 进出全天区；按 Esc 取消拖动不改数据': async () => {
    await drag(await at(day(1), M(13, 30)), await center(page.locator(`.allday-cell[data-cell="${day(2)}"]`)))
    await expectSaved('拖选', day(2), null, null)
    await drag(await center(chip('拖选')), await at(day(1), M(14)))
    await expectSaved('拖选', day(1), '14:00', null)
    await drag(await at(day(1), M(14, 10)), await at(TODAY, M(9)), false)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await page.waitForTimeout(200)
    await expectSaved('拖选', day(1), '14:00', null)
    assert.equal(await detail().count(), 0)
    await block('拖选').locator('.cal-open').click()
    await detail().waitFor()
    await closeDetail()
  },
  'E6 拖到当天末尾，结束时间截到 23:59': async () => {
    await scrollTo(M(13, 30))
    const h = await center(block('拖选').locator('.cal-handle'))
    await drag(h, [h[0], h[1] + HOUR * 1.5])
    await expectSaved('拖选', day(1), '14:00', '16:00')
    await page.locator('.cal-scroll').evaluate((e) => (e.scrollTop = 99999))
    // 滚到底后，先用详情把它移到 20:00，再拖到 23:00
    await nav('未来')
    await row('拖选').locator('.row-main').click()
    await detail().getByLabel('时间', { exact: true }).fill('20:00')
    await nav('日历')
    await page.locator('.cal-scroll').evaluate((e) => (e.scrollTop = 99999))
    const b = await block('拖选').boundingBox()
    await drag([b.x + 20, b.y + 10], [b.x + 20, b.y + 10 + HOUR * 2.5])
    await expectSaved('拖选', day(1), '22:30', '23:59')
  },
  'E4 重叠的并排且都可点，首尾相接的不并排；已完成的变淡且不可拖；红线位置': async () => {
    await scrollTo(M(12)) // 避开可见区边缘的自动滚动
    for (const [title, a, b] of [['重一', M(14), M(15)], ['重二', M(16), M(17)], ['接上', M(17), M(18)]]) {
      await drag(await at(day(4), a), await at(day(4), b))
      await typeDraft(title)
    }
    const b2 = await block('重二').boundingBox()
    await drag([b2.x + 10, b2.y + 10], [b2.x + 10, b2.y + 10 - HOUR * 1.5])
    await expectSaved('重二', day(4), '14:30', '15:30')
    const [x1, x2] = [await block('重一').boundingBox(), await block('重二').boundingBox()]
    assert.ok(x1.x + x1.width <= x2.x + 1 || x2.x + x2.width <= x1.x + 1, '未并排')
    for (const t of ['重一', '重二']) {
      await block(t).locator('.cal-open').click()
      assert.equal(await detail().getByLabel('标题').inputValue(), t)
      await closeDetail()
    }
    await block('重一').locator('.cal-open').click()
    await detail().locator('.check input').click()
    await closeDetail()
    await eventually(
      async () => assert.equal(await block('重一').evaluate((e) => getComputedStyle(e).opacity), '0.5'),
      '已完成的未变淡'
    )
    const done = await block('重一').boundingBox()
    await drag([done.x + 10, done.y + 10], [done.x + 10, done.y + 10 + HOUR])
    await expectSaved('重一', day(4), '14:00', '15:00')
    const line = await page.locator('.cal-now').boundingBox()
    const col = await page.locator(`[data-column="${TODAY}"]`).boundingBox()
    assert.ok(Math.abs(line.x - col.x) < 2 && Math.abs(line.y - col.y - 10 * HOUR) < 4, '红线位置')
    await shot('calendar-week')
  },
  'P19 短块和贴近午夜的块，上中下都能点开，能移动': async () => {
    const sql = new DatabaseSync(dbFile)
    const add = (t, time, end) =>
      sql
        .prepare('INSERT INTO todos (id, title, date, time, end_time, remind, sort, created_at) VALUES (?, ?, ?, ?, ?, NULL, 900, 1)')
        .run(t, t, day(-1), time, end)
    const list = [['五分', '11:00', '11:05'], ['十分', '12:00', '12:10'], ['十五分', '13:00', '13:15'], ['末尾', '23:50', null], ['最末', '23:59', null]]
    list.forEach((x) => add(...x))
    sql.close()
    await relaunch()
    await nav('日历')
    await mode('周')
    for (const [title] of list) {
      const late = title === '末尾' || title === '最末'
      if (late) await page.locator('.cal-scroll').evaluate((e) => (e.scrollTop = 99999))
      else await scrollTo(M(9, 30))
      const b = await block(title).boundingBox()
      assert.ok(b.height >= 17, `${title} 高度 ${b.height}`)
      for (const part of [0.15, 0.5, 0.92]) {
        await page.mouse.click(b.x + b.width / 2, b.y + b.height * part)
        await eventually(async () => assert.equal(await detail().getByLabel('标题').inputValue(), title), `${title} ${part} 未打开`)
        await closeDetail()
      }
    }
    const b = await block('最末').boundingBox()
    await drag([b.x + b.width / 2, b.y + 8], [b.x + b.width / 2, b.y + 8 - HOUR])
    await expectSaved('最末', day(-1), '22:59', null)
    await scrollTo(M(9, 30))
    const s = await block('五分').boundingBox()
    await drag([s.x + s.width / 2, s.y + 8], [s.x + s.width / 2, s.y + 8 - HOUR / 2])
    await expectSaved('五分', day(-1), '10:30', '10:35')
    await scrollTo(M(12))
  },
  'P20 拖到日历外松开即取消，回到日历内可继续': async () => {
    const b = await block('接上').boundingBox()
    const from = [b.x + b.width / 2, b.y + 10]
    const box = await page.locator('.cal-scroll').boundingBox()
    const bar = await page.locator('.cal-bar').boundingBox()
    const places = {
      导航: [60, 400],
      工具栏: [bar.x + 300, bar.y + 12],
      日期栏: [from[0], box.y + 8],
      下方: [from[0], box.y + box.height + 8],
      窗口上方: [from[0], -60]
    }
    for (const [name, to] of Object.entries(places)) {
      // 先在日历内移动并确认拖动已开始，再移到外面松开
      await drag(from, [from[0], from[1] - HOUR], false)
      await eventually(async () => assert.match(await block('接上').getAttribute('class'), /is-dragging/), '拖动未开始')
      await page.mouse.move(...to, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(150)
      assert.deepEqual(saved('接上'), { date: day(4), time: '17:00', endTime: '18:00' }, name)
      await scrollTo(M(12))
    }
    const h = await center(block('接上').locator('.cal-handle'))
    await drag(h, [h[0], h[1] - 30], false)
    await eventually(async () => assert.match(await block('接上').getAttribute('class'), /is-dragging/), '改时长未开始')
    await page.mouse.move(60, h[1], { steps: 8 })
    await page.mouse.up()
    await drag(await at(TODAY, M(13)), await at(TODAY, M(14)), false)
    await page.locator('.cal-select').waitFor()
    await page.mouse.move(60, 500, { steps: 8 })
    await page.locator('.cal-select').waitFor({ state: 'detached' })
    await page.mouse.up()
    await page.waitForTimeout(150)
    assert.deepEqual(saved('接上'), { date: day(4), time: '17:00', endTime: '18:00' })
    assert.equal(await page.getByLabel('新建待办标题').count(), 0)
    assert.equal(await detail().count(), 0)
    await scrollTo(M(12))
    await drag(from, [60, 400], false)
    await page.mouse.move(from[0], from[1] - HOUR, { steps: 8 })
    await page.mouse.up()
    await expectSaved('接上', day(4), '16:00', '17:00')
    await drag([from[0], from[1] - HOUR], from)
    await expectSaved('接上', day(4), '17:00', '18:00')
  },
  'P22 最小窗口打开详情时，视图按钮可点，日期不竖排': async () => {
    const resize = (w, h) =>
      app.evaluate(
        ({ BrowserWindow }, [a, b]) =>
          BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('#main')).setSize(a, b),
        [w, h]
      )
    await block('接上').locator('.cal-open').click()
    await resize(760, 520)
    await page.waitForTimeout(400)
    await shot('calendar-narrow')
    for (const d of await page.locator('.cal-day').all()) {
      const r = await d.boundingBox()
      assert.ok(r.width >= 70 && r.height < 60, JSON.stringify(r))
    }
    const left = (s) => page.locator(s).evaluateAll((l) => l.map((e) => Math.round(e.getBoundingClientRect().left)))
    assert.deepEqual(await left('.cal-day'), await left('.cal-column'))
    assert.deepEqual(await left('.allday-cell'), await left('.cal-column'))
    for (const m of ['月', '日', '周']) {
      await page.locator('.cal-bar').getByRole('button', { name: m, exact: true }).click({ timeout: 3000 })
    }
    await closeDetail()
    await resize(1120, 740)
    await page.waitForTimeout(400)
    await scrollTo(M(12))
  },
  'E6 保存失败时保留并自动重试；新建失败保留文字': async () => {
    const db = new DatabaseSync(dbFile)
    db.exec('BEGIN IMMEDIATE')
    const b = await block('接上').boundingBox()
    await drag([b.x + 10, b.y + 10], [b.x + 10, b.y + 10 + HOUR / 2])
    await page.getByText('有修改尚未保存').waitFor()
    await page.mouse.click(...(await at(TODAY, M(15))))
    await page.getByLabel('新建待办标题').fill('占用时新建')
    await page.keyboard.press('Enter')
    await page.getByRole('alert').getByText('占用').waitFor()
    assert.equal(await page.getByLabel('新建待办标题').inputValue(), '占用时新建')
    db.exec('ROLLBACK')
    db.close()
    await page.getByText('有修改尚未保存').waitFor({ state: 'detached', timeout: 15000 })
    await expectSaved('接上', day(4), '17:30', '18:30')
    await page.getByLabel('新建待办标题').press('Enter')
    await expectSaved('占用时新建', TODAY, '15:00', null)
    await page.getByRole('button', { name: '知道了' }).click()
  },
  'E5 写了字的新建框不被替换；翻页后文字不丢': async () => {
    await page.mouse.click(...(await at(TODAY, M(16))))
    await page.getByLabel('新建待办标题').fill('写到一半')
    await page.mouse.click(...(await at(TODAY, M(17))))
    assert.equal(await page.getByLabel('新建待办标题').inputValue(), '写到一半')
    await page.getByLabel('下一页').click()
    await page.getByLabel('上一页').click()
    assert.equal(await page.getByLabel('新建待办标题').inputValue(), '写到一半')
    await page.getByLabel('新建待办标题').press('Escape')
    assert.equal(saved('写到一半'), undefined)
  },
  'E7 拖动改时间后只按新时间提醒': async () => {
    await scrollTo(M(8, 30))
    await page.mouse.click(...(await at(TODAY, M(11))))
    await typeDraft('提醒项')
    const b = await block('提醒项').boundingBox()
    await drag([b.x + 10, b.y + 8], [b.x + 10, b.y + 8 + HOUR])
    await expectSaved('提醒项', TODAY, '12:00', null)
    const go = (h) => {
      const d = new Date(start)
      d.setHours(h, 0, 5, 0)
      setClock(d.getTime() - Date.now())
    }
    const sent = () => app.evaluate(() => globalThis.testNotifications.map((n) => n.title))
    go(11)
    await page.waitForTimeout(2300)
    assert.deepEqual(await sent(), [])
    go(12)
    await eventually(async () => assert.deepEqual(await sent(), ['提醒项']), '未按新时间提醒')
    await page.waitForTimeout(1500)
    assert.deepEqual(await sent(), ['提醒项'])
  },
  'E2 月视图：归属、还有 N 项、改日期、新建只填日期': async () => {
    await mode('月')
    const cell = page.locator(`.month-cell[data-cell="${TODAY}"]`)
    await cell.waitFor()
    await shot('calendar-month')
    const inCell = await cell.locator('.cal-chip').count()
    assert.ok(inCell <= 3)
    await nav('今天')
    for (const t of ['多一', '多二', '多三']) {
      await page.getByLabel('快速添加').fill(t)
      await page.keyboard.press('Enter')
      await row(t).waitFor()
    }
    await nav('日历')
    assert.equal(await page.locator('.month').count(), 1) // 记住上次的视图
    await cell.getByRole('button', { name: /还有 \d+ 项/ }).waitFor()
    const target = page.locator(`.month-cell[data-cell="${day(3)}"]`)
    await drag(await center(chip('全天')), await center(target.locator('.month-day')))
    await expectSaved('全天', day(3), null, null)
    // 点其他日子的空白处（日期数字旁）新建
    const box = await page.locator(`.month-cell[data-cell="${day(-2)}"]`).boundingBox()
    await page.mouse.click(box.x + box.width - 12, box.y + 10)
    await typeDraft('月里新建')
    await expectSaved('月里新建', day(-2), null, null)
    await cell.getByRole('button', { name: /还有 \d+ 项/ }).click()
    const days = await page.locator('[data-column]').evaluateAll((l) => l.map((e) => e.dataset.column))
    assert.deepEqual(days, [TODAY])
    await shot('calendar-day')
  },
  'E2 翻页、今天、跨零点；E8 与列表和悬浮窗同步，重启后视图和数据不变': async () => {
    const shown = () => page.locator('[data-column]').evaluateAll((l) => l.map((e) => e.dataset.column))
    await page.getByLabel('下一页').click()
    assert.deepEqual(await shown(), [day(1)])
    await page.getByLabel('上一页').click()
    await page.getByLabel('上一页').click()
    assert.deepEqual(await shown(), [day(-1)])
    await page.locator('.cal-bar').getByRole('button', { name: '今天' }).click()
    assert.deepEqual(await shown(), [TODAY])
    await nav('悬浮窗')
    const f = await eventually(() => {
      const p = app.windows().find((w) => w.url().endsWith('#float'))
      assert.ok(p)
      return p
    }, '悬浮窗未出现')
    await f.locator('li[data-todo="提醒项"]').getByRole('checkbox').click()
    await eventually(
      async () => assert.match(await block('提醒项').getAttribute('class'), /is-done/),
      '悬浮窗勾选未同步到日历'
    )
    const midnight = new Date(start)
    midnight.setHours(24, 0, 5, 0)
    setClock(midnight.getTime() - Date.now())
    await eventually(async () => assert.deepEqual(await shown(), [day(1)]), '跨零点未更新')
    await relaunch()
    await nav('日历')
    assert.deepEqual(await shown(), [day(1)])
    await mode('周')
    await block('接上').waitFor()
    await expectSaved('接上', day(4), '17:30', '18:30')
  },
  '无报错': async () => {
    assert.equal(existsSync(crashFile) ? readFileSync(crashFile, 'utf8') : '', '')
    assert.deepEqual(problems, [])
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
      await shot('failure-calendar')?.catch(() => {})
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
