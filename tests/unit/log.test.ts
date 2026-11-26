import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Backups } from '../../src/main/backup'
import { TodoStore } from '../../src/main/store'
import { defaultItems, formatLog, joinLines, logDate, sentence } from '../../src/shared/log'
import type { LogItem } from '../../src/shared/types'

const item = (title: string, detail = '', todoId: string | null = null): LogItem => ({ todoId, title, detail })

describe('C2 文字格式', () => {
  it('与示例结构一致（虚构内容）', () => {
    expect(
      formatLog('2030-11-03', [
        item('整理会议纪要', '汇总意见，发给项目组'),
        item('参加产品培训', '学习产品历史、产品介绍；了解各模块\n熟悉岗位规范')
      ])
    ).toBe(
      '11.3\n（1）整理会议纪要。汇总意见，发给项目组。\n（2）参加产品培训。学习产品历史、产品介绍；了解各模块；熟悉岗位规范。'
    )
  })
  it('日期不补零', () => {
    expect(logDate('2030-01-05')).toBe('1.5')
    expect(logDate('2030-12-31')).toBe('12.31')
  })
  it('句末标点已有不重复；逗号、分号结尾换成句号', () => {
    expect(sentence('完成')).toBe('完成。')
    for (const s of ['完成。', '完成！', '完成？', '完成…', 'Done.', 'Done!']) expect(sentence(s)).toBe(s)
    expect(sentence('完成，')).toBe('完成。')
    expect(sentence('完成；')).toBe('完成。')
    expect(sentence('  ')).toBe('')
  })
  it('多行详情用“；”连接，行末已有标点的直接连接，空行忽略', () => {
    expect(joinLines('甲\n乙\n\n丙')).toBe('甲；乙；丙')
    expect(joinLines('甲。\n乙，\n丙')).toBe('甲。乙，丙')
    expect(joinLines('甲\r\n  乙  ')).toBe('甲；乙')
  })
  it('只有标题、空条目跳过、编号连续', () => {
    expect(formatLog('2030-03-10', [item('甲'), item(' ', ' '), item('乙', '细节')])).toBe(
      '3.10\n（1）甲。\n（2）乙。细节。'
    )
    expect(formatLog('2030-03-10', [])).toBe('3.10')
  })
})

describe('C1 C4 数据', () => {
  let dir: string
  let path: string
  let now: number
  let store: TodoStore
  const at = (d: number, h: number, m = 0) => new Date(2030, 2, d, h, m).getTime()
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'worktodo-test-'))
    path = join(dir, 'data.db')
    now = at(10, 9)
    store = new TodoStore(path, () => now)
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('默认只含这一天勾选完成的，按完成先后；详情依次取完成情况、细节描述', () => {
    const a = store.add('后完成', '2030-03-09')
    const b = store.add('先完成', null)
    const c = store.add('昨天完成', '2030-03-10')
    const d = store.add('未完成', '2030-03-10')
    const e = store.add('已删除', '2030-03-10')
    store.update(a, { detail: '细节', result: '结果' })
    store.update(b, { detail: '只有细节' })
    store.update(d, { result: '进展' })
    now = at(9, 18)
    store.setDone(c, true)
    now = at(10, 10)
    store.setDone(b, true)
    store.setDone(e, true)
    store.remove(e)
    now = at(10, 11)
    store.setDone(a, true)
    expect(defaultItems(store.state().todos, '2030-03-10')).toEqual([
      { todoId: b, title: '先完成', detail: '只有细节' },
      { todoId: a, title: '后完成', detail: '结果' }
    ])
    expect(defaultItems(store.state().todos, '2030-03-09').map((i) => i.title)).toEqual(['昨天完成'])
    expect(defaultItems(store.state().todos, '2030-03-11')).toEqual([])
  })
  it('按日期保存可查，覆盖保存，重启后不变；待办变化不改动已存日志', () => {
    const a = store.add('甲', null)
    store.saveLog('2030-03-10', [item('甲', '结果', a)])
    store.saveLog('2030-03-08', [item('补写', '')])
    store.update(a, { title: '改名' })
    store.remove(a)
    store.purge(a)
    store.close()
    store = new TodoStore(path, () => now)
    expect(store.listLogs().map((l) => l.date)).toEqual(['2030-03-10', '2030-03-08'])
    expect(store.getLog('2030-03-10')!.items).toEqual([item('甲', '结果', a)])
    store.saveLog('2030-03-10', [item('新')])
    expect(store.getLog('2030-03-10')!.items).toEqual([item('新')])
    expect(store.getLog('2030-03-11')).toBeNull()
  })
  it('拒绝无效的日期和内容', () => {
    expect(() => store.saveLog('2030-02-30', [])).toThrow('日期无效')
    expect(() => store.saveLog('2030-03-10', 'x')).toThrow('日志内容无效')
    expect(() => store.saveLog('2030-03-10', [{ title: 1, detail: '' }])).toThrow('日志内容无效')
    expect(() => store.saveLog('2030-03-10', [item('x'.repeat(5001))])).toThrow('日志内容无效')
    expect(store.listLogs()).toEqual([])
  })
  it('日志随备份导出和恢复；旧版本数据升级后可写日志', () => {
    const backups = new Backups(join(dir, 'b'), () => now)
    store.saveLog('2030-03-10', [item('甲')])
    backups.export(store, join(dir, 'out'), join(dir, 'u'))
    store.saveLog('2030-03-10', [item('乙')])
    store.saveLog('2030-03-11', [item('丙')])
    backups.prepare({ path: join(dir, 'out') })
    backups.restore(store)
    expect(store.listLogs().map((l) => l.date)).toEqual(['2030-03-10'])
    expect(store.getLog('2030-03-10')!.items).toEqual([item('甲')])
    store.close()
    const db = new DatabaseSync(path)
    db.exec('DROP TABLE logs; PRAGMA user_version = 5;')
    db.close()
    store = new TodoStore(path, () => now)
    store.saveLog('2030-03-12', [item('升级后')])
    expect(store.listLogs()).toHaveLength(1)
  })
  it('内容被改坏的备份不能恢复', () => {
    const backups = new Backups(join(dir, 'b'), () => now)
    store.saveLog('2030-03-10', [item('甲')])
    backups.export(store, join(dir, 'out'), join(dir, 'u'))
    const db = new DatabaseSync(join(dir, 'out'))
    db.exec(`UPDATE logs SET items = '{"x":1}'`)
    db.close()
    expect(() => backups.prepare({ path: join(dir, 'out') })).toThrow('备份文件无效')
  })
})
