import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TodoStore } from '../../src/main/store'
import type { TodoPatch } from '../../src/shared/types'

const at = (d: number, h: number, min = 0): number => new Date(2030, 2, d, h, min).getTime()
const MIN = 60_000

let dir: string
let path: string
let now: number
let store: TodoStore

const add = (title: string, patch: TodoPatch): string => {
  const id = store.add(title, '2030-03-10')
  store.update(id, patch)
  return id
}
const due = (): string[] => store.collectDue().map((d) => d.todo.title)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'worktodo-test-'))
  path = join(dir, 'test.db')
  now = at(10, 9)
  store = new TodoStore(path, () => now)
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('B1 提醒时刻', () => {
  it('默认到点提醒，只提醒一次', () => {
    add('会议', { time: '10:00' })
    now = at(10, 10) - 1
    expect(due()).toEqual([])
    now = at(10, 10)
    expect(due()).toEqual(['会议'])
    expect(due()).toEqual([])
  })
  it.each([5, 15, 30] as const)('提前 %i 分钟', (remind) => {
    add('会议', { time: '10:00', remind })
    now = at(10, 10) - remind * MIN - 1
    expect(due()).toEqual([])
    now += 1
    expect(due()).toEqual(['会议'])
    now = at(10, 10)
    expect(due()).toEqual([])
  })
  it('不提醒、只填日期的不提醒', () => {
    add('不提醒', { time: '10:00', remind: null })
    add('只有日期', {})
    now = at(11, 10)
    expect(due()).toEqual([])
  })
  it('跨零点的提前提醒', () => {
    add('凌晨', { date: '2030-03-11', time: '00:10', remind: 30 })
    now = at(10, 23, 40)
    expect(due()).toEqual(['凌晨'])
  })
  it('拒绝无效的提醒方式', () => {
    const id = add('甲', {})
    expect(() => store.update(id, { remind: 7 as never })).toThrow('提醒方式无效')
  })
})

describe('B3 重新打开', () => {
  it('错过的在重新打开后取出一次，再次打开不重复', () => {
    add('乙', { time: '11:00' })
    add('甲', { time: '10:00' })
    for (const expected of [['甲', '乙'], []]) {
      store.close()
      now = at(10, 12)
      store = new TodoStore(path, () => now)
      expect(due()).toEqual(expected)
    }
  })
})

describe('B4 完成、删除与修改', () => {
  it('已完成、已删除的不提醒；过点后取消勾选或恢复不补弹', () => {
    const a = add('甲', { time: '10:00' })
    const b = add('乙', { time: '10:00' })
    store.setDone(a, true)
    store.remove(b)
    now = at(10, 10)
    expect(due()).toEqual([])
    store.setDone(a, false)
    store.restore(b)
    expect(due()).toEqual([])
  })
  it('未过点时取消勾选或恢复，仍会提醒', () => {
    const a = add('甲', { time: '10:00' })
    store.setDone(a, true)
    store.setDone(a, false)
    store.remove(a)
    store.restore(a)
    now = at(10, 10)
    expect(due()).toEqual(['甲'])
  })
  it('改时间后只按新时间提醒，提醒过的改到将来会再提醒', () => {
    const id = add('甲', { time: '10:00' })
    store.update(id, { time: '11:00' })
    now = at(10, 10)
    expect(due()).toEqual([])
    now = at(10, 11)
    expect(due()).toEqual(['甲'])
    store.update(id, { time: '12:00' })
    now = at(10, 12)
    expect(due()).toEqual(['甲'])
  })
  it('改成已过的时刻不补弹；只改文字不影响即将到来的提醒', () => {
    const id = add('甲', { time: '10:00' })
    now = at(10, 10)
    store.update(id, { title: '改名' })
    expect(due()).toEqual(['改名'])
    store.update(id, { time: '09:30' })
    expect(due()).toEqual([])
  })
})

describe('提醒时刻已过、待办时刻未到', () => {
  beforeEach(() => (now = at(10, 9, 50)))

  it('设置时已过提前量，改在到点提醒一次', () => {
    add('会议', { time: '10:00', remind: 30 })
    expect(due()).toEqual([])
    now = at(10, 10) - 1
    expect(due()).toEqual([])
    now += 1
    expect(due()).toEqual(['会议'])
    expect(due()).toEqual([])
  })
  it('到点前改为不提醒、改时间或改提前量，按新值', () => {
    const a = add('不提醒', { time: '10:00', remind: 30 })
    const b = add('改时间', { time: '10:00', remind: 30 })
    const c = add('改提前量', { time: '10:00', remind: 30 })
    store.update(a, { remind: null })
    store.update(b, { time: '11:00' })
    store.update(c, { remind: 5 })
    now = at(10, 9, 55)
    expect(due()).toEqual(['改提前量'])
    now = at(10, 10)
    expect(due()).toEqual([])
    now = at(10, 10, 30)
    expect(due()).toEqual(['改时间'])
  })
  it('提醒时刻不变但待办时刻变了，到新时刻提醒', () => {
    const id = add('甲', { time: '10:00', remind: 30 })
    store.update(id, { time: '09:55', remind: null })
    store.update(id, { time: '10:00', remind: 30 })
    store.update(id, { title: '改名' })
    now = at(10, 10)
    expect(due()).toEqual(['改名'])
  })
  it('已提前弹过的，取消勾选或恢复后到点不重复弹', () => {
    const id = add('甲', { time: '11:00', remind: 30 })
    now = at(10, 10, 30)
    expect(due()).toEqual(['甲'])
    store.setDone(id, true)
    store.setDone(id, false)
    store.remove(id)
    store.restore(id)
    now = at(10, 11)
    expect(due()).toEqual([])
  })
  it('完成期间错过提前量，取消勾选后到点提醒；过点才取消的不弹', () => {
    const a = add('甲', { time: '11:00', remind: 30 })
    const b = add('乙', { time: '11:00', remind: 30 })
    store.setDone(a, true)
    store.setDone(b, true)
    now = at(10, 10, 45)
    store.setDone(a, false)
    now = at(10, 11)
    expect(due()).toEqual(['甲'])
    store.setDone(b, false)
    expect(due()).toEqual([])
  })
  it('到点时程序未运行，重新打开后取出', () => {
    add('会议', { time: '10:00', remind: 30 })
    store.close()
    now = at(10, 12)
    store = new TodoStore(path, () => now)
    expect(due()).toEqual(['会议'])
    expect(due()).toEqual([])
  })
})

describe('数据升级', () => {
  it('阶段 A 的数据升级后保留，默认到点提醒', () => {
    const old = join(dir, 'old.db')
    const db = new DatabaseSync(old)
    db.exec(`CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, date TEXT, time TEXT,
      detail TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL DEFAULT 0,
      sort INTEGER NOT NULL, created_at INTEGER NOT NULL, done_at INTEGER, deleted_at INTEGER);
      INSERT INTO todos (id, title, sort, created_at) VALUES ('x', '旧待办', 1, 1); PRAGMA user_version = 1;`)
    db.close()
    const s = new TodoStore(old, () => now)
    expect(s.state().todos).toMatchObject([{ title: '旧待办', remind: 0 }])
    s.setSetting('k', '1')
    s.setSetting('k', '2')
    expect(s.getSetting('k')).toBe('2')
    s.close()
  })
})