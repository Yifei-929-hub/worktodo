// 在真实 Electron 窗口中检查工作日志（C1–C4）。内容均为虚构。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const dir = mkdtempSync(join(tmpdir(), 'worktodo-e2e-'))
const clockFile = join(dir, 'clock.txt')
const crashFile = join(dir, 'crash.txt')
const shots = process.env.WORKTODO_SHOTS
if (shots) mkdirSync(shots, { recursive: true })
const env = { ...process.env, WORKTODO_USER_DATA: join(dir, 'user-data'), WORKTODO_TEST_CLOCK: clockFile, WORKTODO_TEST_NOTIFY: '1' }
delete env.ELECTRON_RUN_AS_NODE

// 固定在某月 5 日上午 10 点，前一天是 4 日
const start = new Date()
start.setDate(5)
start.setHours(10, 0, 0, 0)
let offset = start.getTime() - Date.now()
writeFileSync(clockFile, String(offset))
const advance = (ms) => {
  offset += ms
  writeFileSync(clockFile, String(offset))
}
const M = start.getMonth() + 1
const key = (d) => `${start.getFullYear()}-${String(M).padStart(2, '0')}-${String(d).padStart(2, '0')}`

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
const nav = (name) => page.locator('.nav-item', { hasText: name }).first().click()
const row = (title) => page.locator(`li[data-todo="${title}"]`)
const detail = () => page.locator('.detail')
const preview = () => page.getByLabel('日志预览').innerText()
const logRow = (title) => page.locator(`.log-row[data-log="${title}"]`)
const clip = () => app.evaluate(({ clipboard }) => clipboard.readText())
const shot = (name) => (shots ? page.screenshot({ path: join(shots, `${name}.png`) }) : undefined)
async function add(title, detailText, result) {
  await page.getByLabel('快速添加').fill(title)
  await page.keyboard.press('Enter')
  await row(title).waitFor()
  if (detailText || result) {
    await row(title).locator('.row-main').click()
    if (detailText) await detail().getByLabel('细节描述').fill(detailText)
    if (result) await detail().getByLabel('完成情况').fill(result)
    await detail().getByRole('button', { name: '关闭' }).click()
  }
}
async function done(title) {
  await row(title).getByRole('checkbox').click()
  await page.getByRole('button', { name: '跳过' }).click()
  await page.waitForTimeout(350)
}
const expectPreview = (text) => eventually(async () => assert.equal(await preview(), text), '预览不符')

const steps = {
  'C1 默认只含当天勾选完成的，按完成先后，详情依次取完成情况、细节描述': async () => {
    await add('整理会议纪要', '汇总意见', '汇总意见，发给项目组')
    await add('参加产品培训', '学习产品历史；了解各模块\n熟悉岗位规范')
    await add('只有标题')
    await add('还没做完', '写到一半')
    await add('忘记勾选')
    // 昨天完成的不算
    advance(-86_400_000)
    await page.waitForTimeout(1500)
    await add('昨天完成')
    await done('昨天完成')
    advance(86_400_000)
    await page.waitForTimeout(1500)
    for (const t of ['参加产品培训', '整理会议纪要', '只有标题']) await done(t)
    await page.getByRole('button', { name: '生成今日日志' }).click()
    await expectPreview(`${M}.5\n（1）参加产品培训。学习产品历史；了解各模块；熟悉岗位规范。\n（2）整理会议纪要。汇总意见，发给项目组。\n（3）只有标题。`)
    await shot('log-new')
  },
  'C3 取舍、排序、改字、加入未完成待办、临时补条，复制与预览一致': async () => {
    await logRow('只有标题').getByRole('checkbox').uncheck()
    await logRow('整理会议纪要').getByRole('button', { name: '上移' }).click()
    await logRow('参加产品培训').getByLabel('条目详情').fill('学习产品历史')
    await page.getByLabel('加入未完成的待办').selectOption({ label: '还没做完（' + (await page.getByLabel('加入未完成的待办').locator('option', { hasText: '还没做完' }).innerText()).split('（')[1] })
    await page.getByRole('button', { name: '加入', exact: true }).click()
    await logRow('还没做完').getByLabel('条目详情').fill('完成初稿，待评审')
    await page.getByRole('button', { name: '临时补一条' }).click()
    const last = page.locator('.log-row').last()
    await last.getByLabel('条目标题').fill('临时处理客户咨询')
    await last.getByLabel('条目详情').fill('电话答复两次,')
    const expected = `${M}.5\n（1）整理会议纪要。汇总意见，发给项目组。\n（2）参加产品培训。学习产品历史。\n（3）还没做完。完成初稿，待评审。\n（4）临时处理客户咨询。电话答复两次。`
    await expectPreview(expected)
    await page.getByRole('button', { name: '复制' }).click()
    await page.getByText('已复制').waitFor()
    assert.equal((await clip()).replaceAll('\r\n', '\n'), expected)
    assert.ok((await clip()).includes('\r\n'))
    await shot('log-edit')
  },
  'C3 切换页面后未保存的编辑仍在': async () => {
    await nav('今天')
    await nav('工作日志')
    await expectPreview(`${M}.5\n（1）整理会议纪要。汇总意见，发给项目组。\n（2）参加产品培训。学习产品历史。\n（3）还没做完。完成初稿，待评审。\n（4）临时处理客户咨询。电话答复两次。`)
  },
  'C4 保存后按日期可查，待办变化不改动已存日志，重启后不变': async () => {
    await page.getByRole('button', { name: '保存' }).click()
    await page.getByText('已保存。').first().waitFor()
    const savedText = await preview()
    await nav('已完成')
    await row('整理会议纪要').locator('.row-main').click()
    await detail().getByLabel('标题').fill('改了标题')
    await detail().getByRole('button', { name: '移到回收站' }).click()
    await app.close()
    await launch()
    await nav('工作日志')
    assert.equal(await preview(), savedText)
    await page.getByLabel('已保存的日志').getByRole('button', { name: /5日/ }).waitFor()
  },
  'C4 修改已保存的日志；重新生成先确认，取消不变': async () => {
    await page.getByRole('button', { name: '修改' }).click()
    await logRow('临时处理客户咨询').getByLabel('条目标题').fill('处理客户咨询')
    await page.getByRole('button', { name: '保存' }).click()
    await eventually(async () => assert.match(await preview(), /（4）处理客户咨询。/), '修改未保存')
    await page.getByRole('button', { name: '重新生成' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click()
    assert.match(await preview(), /处理客户咨询/)
    await page.getByRole('button', { name: '重新生成' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '重新生成' }).click()
    await expectPreview(`${M}.5\n（1）参加产品培训。学习产品历史；了解各模块；熟悉岗位规范。\n（2）只有标题。`)
    await page.getByRole('button', { name: '放弃修改' }).click()
    assert.match(await preview(), /处理客户咨询/)
  },
  'C4 补写过去的日期；没有完成的也可手动补充': async () => {
    await page.getByLabel('日期').fill(key(4))
    await expectPreview(`${M}.4\n（1）昨天完成。`)
    await page.getByRole('button', { name: '保存' }).click()
    await page.getByText('已保存。').first().waitFor()
    await page.getByLabel('日期').fill(key(3))
    await page.getByText('当天没有完成的待办').waitFor()
    await expectPreview(`${M}.3`)
    await page.getByRole('button', { name: '临时补一条' }).click()
    await page.locator('.log-row').last().getByLabel('条目标题').fill('补写的工作')
    await page.getByRole('button', { name: '保存' }).click()
    await page.getByText('已保存。').first().waitFor()
    const dates = await page.getByLabel('已保存的日志').locator('li').allInnerTexts()
    assert.equal(dates.length, 3)
    assert.ok(dates[0].includes('5日') && dates[2].includes('3日'), dates.join())
    assert.equal(await page.getByLabel('日期').getAttribute('max'), key(5))
  },
  'P29 日志有未保存的修改时不能导出或恢复；放弃或保存后恢复可用': async () => {
    const exportButton = () => page.getByRole('button', { name: '导出备份' })
    await page.getByLabel('日期').fill(key(5))
    await page.getByRole('button', { name: '修改' }).click()
    await page.locator('.log-row').first().getByLabel('条目标题').fill('未保存的改动')
    await nav('备份与恢复')
    await page.getByText('工作日志有未保存的修改').waitFor()
    assert.equal(await exportButton().isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: '从文件恢复' }).isDisabled(), true)
    await nav('工作日志')
    await page.getByRole('button', { name: '放弃修改' }).click()
    await nav('备份与恢复')
    assert.equal(await exportButton().isDisabled(), false)
    // 没保存过的日期：改了以后也能放弃
    await nav('工作日志')
    await page.getByLabel('日期').fill(key(2))
    await page.getByRole('button', { name: '临时补一条' }).click()
    await nav('备份与恢复')
    assert.equal(await exportButton().isDisabled(), true)
    await page.getByText(/工作日志有未保存的修改（.*2日/).waitFor()
    await nav('工作日志')
    assert.equal(await page.getByLabel('日期').inputValue(), key(2)) // 回到上次看的那天
    await page.getByRole('button', { name: '放弃修改' }).click()
    await expectPreview(`${M}.2`)
    await nav('备份与恢复')
    assert.equal(await exportButton().isDisabled(), false)
  },
  '无报错': async () => {
    await app.close()
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
      await shot('failure-log')?.catch(() => {})
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
