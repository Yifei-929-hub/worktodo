// 在真实 Electron 窗口中检查阶段 A（A1–A6）。先构建，再运行：npm run e2e
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const dir = mkdtempSync(join(tmpdir(), 'worktodo-e2e-'))
const clockFile = join(dir, 'clock.txt')
const shots = process.env.WORKTODO_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

const HOUR = 3600_000
let offset = 0
const setClock = (ms) => {
  offset = ms
  writeFileSync(clockFile, String(ms))
}
const fakeNow = () => new Date(Date.now() + offset)
const key = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const plusDays = (n) => {
  const d = fakeNow()
  d.setDate(d.getDate() + n)
  return key(d)
}
// 固定从上午 10 点开始，避免结果受运行时刻影响
const start = new Date()
start.setHours(10, 0, 0, 0)
setClock(start.getTime() - Date.now())

let app
let page
const problems = []
const requests = []

async function launch() {
  const env = { ...process.env, WORKTODO_USER_DATA: join(dir, 'user-data'), WORKTODO_TEST_CLOCK: clockFile }
  delete env.ELECTRON_RUN_AS_NODE
  app = await _electron.launch({ args: [root], env })
  page = await app.firstWindow()
  page.on('pageerror', (e) => problems.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()))
  page.on('request', (r) => requests.push(r.url()))
  await page.getByLabel('快速添加').waitFor()
}
async function relaunch() {
  await app.close()
  await launch()
}
const nav = (name) => page.locator('.nav-item', { hasText: name }).click()
const row = (title) => page.locator(`li[data-todo="${title}"]`)
const group = (name) => page.locator(`section[aria-label="${name}"]`)
const titlesIn = (name) => group(name).locator('li').evaluateAll((l) => l.map((x) => x.dataset.todo))
const detail = () => page.locator('.detail')
const select = async (title) => {
  await row(title).locator('.row-main').click()
  await detail().waitFor()
}
async function add(title) {
  await page.getByLabel('快速添加').fill(title)
  await page.keyboard.press('Enter')
  await row(title).waitFor()
}
// 选择写入数据库后才显示，因此点击后等待结果
async function setHigh() {
  await detail().locator('.seg').getByText('高').click()
  await eventually(
    async () => assert.equal(await detail().getByLabel('高', { exact: true }).isChecked(), true),
    '优先级未更新'
  )
}
async function eventually(fn, message) {
  let last
  for (let i = 0; i < 50; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error(`${message}: ${last}`)
}
const expectTitles = (name, expected) =>
  eventually(async () => assert.deepEqual(await titlesIn(name), expected), `${name} 列表不符`)
const shot = (name) => (shots ? page.screenshot({ path: join(shots, `${name}.png`) }) : undefined)

const steps = {
  'A1 空标题不能添加': async () => {
    await page.getByLabel('快速添加').fill('   ')
    await page.keyboard.press('Enter')
    await page.getByRole('alert').getByText('标题不能为空').waitFor()
    assert.equal(await page.locator('li').count(), 0)
  },
  'A1 只填标题添加，A2 日期默认今天': async () => {
    await add('整理资料')
    await select('整理资料')
    assert.equal(await detail().locator('input[type=date]').inputValue(), plusDays(0))
  },
  'A1 全部字段可编辑，空标题恢复原值，重启后不变': async () => {
    const d = detail()
    await d.getByLabel('标题').fill('')
    await d.getByText('标题不能为空').waitFor()
    await d.getByLabel('细节描述').click()
    assert.equal(await d.getByLabel('标题').inputValue(), '整理资料')
    await d.getByLabel('标题').fill('整理项目资料')
    await d.locator('input[type=time]').fill('14:30')
    await setHigh()
    await d.getByLabel('细节描述').fill('第一行\n第二行')
    await d.getByLabel('完成情况').fill('完成一半')
    await row('整理项目资料').getByText('14:30').waitFor()
    await shot('today')
    await relaunch()
    await select('整理项目资料')
    assert.equal(await detail().locator('input[type=date]').inputValue(), plusDays(0))
    assert.equal(await detail().locator('input[type=time]').inputValue(), '14:30')
    assert.equal(await detail().getByLabel('高', { exact: true }).isChecked(), true)
    assert.equal(await detail().getByLabel('细节描述').inputValue(), '第一行\n第二行')
    assert.equal(await detail().getByLabel('完成情况').inputValue(), '完成一半')
  },
  'A1 键盘输入日期的中间状态不会清掉日期和时间': async () => {
    const date = detail().locator('input[type=date]')
    await date.focus()
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(200)
    await detail().getByLabel('标题').focus()
    assert.equal(await date.inputValue(), plusDays(0))
    assert.equal(await detail().locator('input[type=time]').inputValue(), '14:30')
  },
  'A2 清空日期进入未安排，时间一并清空；只填几点时日期取今天': async () => {
    await detail().getByRole('button', { name: '清空日期' }).click()
    await nav('未来')
    await expectTitles('未安排', ['整理项目资料'])
    await select('整理项目资料')
    assert.equal(await detail().locator('input[type=time]').inputValue(), '')
    await detail().locator('input[type=time]').fill('09:00')
    await nav('今天')
    await expectTitles('今天', ['整理项目资料'])
    await nav('未来')
    await add('无日期事项')
    await add('明天事项')
    await select('明天事项')
    await detail().locator('input[type=date]').fill(plusDays(1))
    await eventually(async () => assert.equal(await page.locator('section').count(), 2), '未来分组不符')
    await shot('future')
  },
  'A5 有时间的在前，拖动和键盘排序持久化，优先级不影响': async () => {
    await nav('今天')
    for (const t of ['甲', '乙', '丙']) await add(t)
    await expectTitles('今天', ['整理项目资料', '甲', '乙', '丙'])
    await row('丙').dragTo(row('甲'))
    await expectTitles('今天', ['整理项目资料', '丙', '甲', '乙'])
    await row('乙').locator('.row-main').focus()
    await page.keyboard.press('Alt+ArrowUp')
    await expectTitles('今天', ['整理项目资料', '丙', '乙', '甲'])
    await select('甲')
    await setHigh()
    await row('甲').locator('.prio').waitFor()
    await relaunch()
    await expectTitles('今天', ['整理项目资料', '丙', '乙', '甲'])
  },
  'A4 勾选进入折叠区，可填或跳过完成情况': async () => {
    await row('甲').getByRole('checkbox').click()
    await page.getByPlaceholder('选填，写日志时会用到').fill('甲已交付')
    await page.locator('.result-bar').getByRole('button', { name: '保存' }).click()
    await row('乙').getByRole('checkbox').click()
    await page.getByRole('button', { name: '跳过' }).click()
    await expectTitles('今天', ['整理项目资料', '丙'])
    await expectTitles('今天已完成', [])
    await group('今天已完成').locator('button.group-title').click()
    await expectTitles('今天已完成', ['乙', '甲'])
    await shot('done-today')
  },
  'A4 取消勾选后完成情况保留': async () => {
    await row('甲').getByRole('checkbox').click()
    await expectTitles('今天已完成', ['乙'])
    await select('甲')
    assert.equal(await detail().getByLabel('完成情况').inputValue(), '甲已交付')
    await row('甲').getByRole('checkbox').click()
    await page.getByRole('button', { name: '跳过' }).click()
    await expectTitles('今天已完成', ['甲', '乙'])
  },
  'A6 删除、恢复、彻底删除需确认': async () => {
    await add('待删')
    await add('误删')
    for (const t of ['待删', '误删']) {
      await select(t)
      await detail().getByRole('button', { name: '移到回收站' }).click()
      await row(t).waitFor({ state: 'detached' })
    }
    await nav('回收站')
    await row('误删').getByRole('button', { name: '恢复' }).click()
    await row('误删').waitFor({ state: 'detached' })
    await row('待删').getByRole('button', { name: '彻底删除' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click()
    await row('待删').waitFor()
    await row('待删').getByRole('button', { name: '彻底删除' }).click()
    await shot('trash')
    await page.getByRole('dialog').getByRole('button', { name: '彻底删除' }).click()
    await row('待删').waitFor({ state: 'detached' })
    await nav('今天')
    await row('误删').waitFor()
  },
  'A3 跨零点无需重启即更新，日期不变；A4 次日只在已完成': async () => {
    const yesterday = plusDays(0)
    const midnight = fakeNow()
    midnight.setHours(24, 0, 0, 0)
    setClock(midnight.getTime() - Date.now() + 2000)
    await expectTitles('已逾期', ['整理项目资料', '丙', '误删'])
    await expectTitles('今天', ['明天事项'])
    assert.equal(await group('今天已完成').count(), 0)
    await shot('overdue')
    await select('丙')
    assert.equal(await detail().locator('input[type=date]').inputValue(), yesterday)
    await nav('已完成')
    await row('甲').waitFor()
    await row('乙').waitFor()
    await nav('今天')
  },
  'A6 满 24 小时清除（运行中与关机期间）': async () => {
    await select('误删')
    await detail().getByRole('button', { name: '移到回收站' }).click()
    await nav('回收站')
    await row('误删').waitFor()
    setClock(offset + 24 * HOUR - 60_000)
    await page.waitForTimeout(2500)
    assert.equal(await row('误删').count(), 1)
    setClock(offset + 61_000)
    await row('误删').waitFor({ state: 'detached' })
    await nav('今天')
    await select('丙')
    await detail().getByRole('button', { name: '移到回收站' }).click()
    await row('丙').waitFor({ state: 'detached' })
    await app.close()
    setClock(offset + 25 * HOUR)
    await launch()
    await nav('回收站')
    assert.equal(await page.locator('li').count(), 0)
  },
  '界面隔离：无 Node 能力，无外部请求，无报错': async () => {
    assert.deepEqual(await page.evaluate(() => [typeof window.require, typeof window.process]), [
      'undefined',
      'undefined'
    ])
    assert.equal(await page.evaluate(() => fetch('https://example.invalid/').then(() => 'ok', () => 'blocked')), 'blocked')
    assert.deepEqual(requests.filter((u) => !/^(file|data|blob):/.test(u) && !u.includes('example.invalid')), [])
    assert.deepEqual(problems.filter((p) => !p.includes('example.invalid') && !p.includes('Content Security Policy')), [])
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
      await shot('failure')
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
if (problems.length) console.log('控制台：', problems)
process.exit(failed ? 1 : 0)
