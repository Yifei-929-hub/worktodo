import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TodoStore } from '../../src/main/store'
import { addDays, addMonths, itemsByDay, layoutDay, monthDays, page, weekDays } from '../../src/shared/calendar'
import { shiftEnd, toTime } from '../../src/shared/rules'
import type { Todo } from '../../src/shared/types'

const todo = (title: string, time: string | null, endTime: string | null = null, patch: Partial<Todo> = {}): Todo => ({
  id: title, title, date: '2030-03-10', time, endTime, detail: '', result: '', priority: 0, remind: 0,
  sort: 1, createdAt: 0, doneAt: null, deletedAt: null, ...patch
})

describe('E1 结束时间', () => {
  let dir: string
  let path: string
  let now: number
  let store: TodoStore
  const get = (id: string) => store.state().todos.find((t) => t.id === id)!
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'worktodo-test-'))
    path = join(dir, 'test.db')
    now = new Date(2030, 2, 10, 9).getTime()
    store = new TodoStore(path, () => now)
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('可填、改、清空，重新打开后不变', () => {
    const id = store.add('甲', '2030-03-10', '14:00', '15:30')
    store.close()
    store = new TodoStore(path, () => now)
    expect(get(id)).toMatchObject({ time: '14:00', endTime: '15:30' })
    store.update(id, { endTime: '16:00' })
    expect(get(id).endTime).toBe('16:00')
    store.update(id, { endTime: null })
    expect(get(id)).toMatchObject({ time: '14:00', endTime: null })
  })
  it('必须有开始且晚于开始，不符合的不保存', () => {
    const id = store.add('甲', '2030-03-10', '14:00')
    for (const endTime of ['14:00', '13:59', '24:00']) {
      expect(() => store.update(id, { endTime })).toThrow()
    }
    expect(get(id).endTime).toBeNull()
    const b = store.add('乙', '2030-03-10')
    store.update(b, { endTime: '10:00' })
    expect(get(b).endTime).toBeNull()
    expect(() => store.add('丙', '2030-03-10', '10:00', '09:00')).toThrow('晚于')
    expect(() => store.add('丁', '2030-03-10', null, '09:00')).toThrow('晚于')
    expect(() => store.add('戊', null, '09:00')).toThrow()
    expect(store.state().todos).toHaveLength(2)
  })
  it('改开始保持时长，超过当天截到 23:59；清空开始或日期一并清空', () => {
    const id = store.add('甲', '2030-03-10', '14:00', '15:30')
    store.update(id, { time: '10:00' })
    expect(get(id).endTime).toBe('11:30')
    store.update(id, { date: '2030-03-12' })
    expect(get(id)).toMatchObject({ time: '10:00', endTime: '11:30' })
    store.update(id, { time: '23:00' })
    expect(get(id).endTime).toBe('23:59')
    store.update(id, { time: null })
    expect(get(id).endTime).toBeNull()
    const b = store.add('乙', '2030-03-10', '14:00', '15:30')
    store.update(b, { date: null })
    expect(get(b)).toMatchObject({ time: null, endTime: null })
    expect(shiftEnd({ time: '10:00', endTime: '11:00' }, '23:59')).toBeNull()
    expect(toTime(1440)).toBe('23:59')
  })
  it('E7 改时间只按新时间提醒；新建在已过时刻的不弹；改结束时间不影响提醒', () => {
    store.add('已过', '2030-03-10', '08:00')
    const id = store.add('会议', '2030-03-10', '10:00', '11:00')
    store.update(id, { date: '2030-03-10', time: '11:00', endTime: '12:00' })
    now = new Date(2030, 2, 10, 10).getTime()
    expect(store.collectDue()).toEqual([])
    now = new Date(2030, 2, 10, 11).getTime()
    expect(store.collectDue().map((d) => d.todo.title)).toEqual(['会议'])
    store.update(id, { endTime: '13:00' })
    expect(store.collectDue()).toEqual([])
  })
  it('版本 4 的数据升级后保留，没有结束时间', () => {
    const id = store.add('旧', '2030-03-10', '10:00')
    store.close()
    const db = new DatabaseSync(path)
    db.exec('ALTER TABLE todos DROP COLUMN end_time; PRAGMA user_version = 4;')
    db.close()
    store = new TodoStore(path, () => now)
    expect(get(id)).toMatchObject({ title: '旧', time: '10:00', endTime: null })
  })
})

describe('E2 日期', () => {
  it('周从周一开始，跨月跨年', () => {
    expect(weekDays('2030-01-01')).toEqual([
      '2029-12-31', '2030-01-01', '2030-01-02', '2030-01-03', '2030-01-04', '2030-01-05', '2030-01-06'
    ])
    expect(weekDays('2030-03-10')[0]).toBe('2030-03-04') // 周日属于前一周
  })
  it('月视图为完整星期，含闰年二月', () => {
    const feb = monthDays('2028-02-15')
    expect(feb[0]).toBe('2028-01-31')
    expect(feb).toContain('2028-02-29')
    expect(feb.length % 7).toBe(0)
    expect(monthDays('2027-02-01')).toHaveLength(28) // 周一开始的 28 天
  })
  it('翻页：月末取目标月最后一天，跨年', () => {
    expect(addMonths('2030-01-31', 1)).toBe('2030-02-28')
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29')
    expect(page('2029-12-31', 'month', 1)).toBe('2030-01-31')
    expect(page('2029-12-29', 'week', 1)).toBe('2030-01-05')
    expect(page('2030-01-01', 'day', -1)).toBe('2029-12-31')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
  })
  it('按自己的日期归类，含已完成，不含无日期和回收站', () => {
    const map = itemsByDay(
      [
        todo('全天', null), todo('定时', '10:00'), todo('完成', '09:00', null, { doneAt: 1 }),
        todo('无日期', null, null, { date: null }), todo('删除', '10:00', null, { deletedAt: 1 }),
        todo('别的天', '10:00', null, { date: '2030-03-11' })
      ],
      ['2030-03-10']
    )
    expect(map.get('2030-03-10')!.allDay.map((t) => t.title)).toEqual(['全天'])
    expect(map.get('2030-03-10')!.timed.map((t) => t.title)).toEqual(['完成', '定时'])
  })
})

describe('E3 E4 布局', () => {
  const layout = (...list: Todo[]) =>
    Object.fromEntries(layoutDay(list).map((b) => [b.todo.title, [b.start, b.end, b.column, b.columns]]))
  it('没有结束时间的按 30 分钟，午夜前截断', () => {
    expect(layout(todo('a', '10:00'))).toEqual({ a: [600, 630, 0, 1] })
    expect(layout(todo('a', '23:45'))).toEqual({ a: [1425, 1440, 0, 1] })
    expect(layout(todo('a', '10:00', '11:15'))).toEqual({ a: [600, 675, 0, 1] })
  })
  it('首尾相接的不算重叠', () => {
    expect(layout(todo('a', '10:00', '11:00'), todo('b', '11:00', '12:00'))).toEqual({
      a: [600, 660, 0, 1], b: [660, 720, 0, 1]
    })
  })
  it('重叠的并排，连锁重叠的同宽，空出的列可复用', () => {
    expect(
      layout(todo('a', '10:00', '12:00'), todo('b', '10:30', '11:00'), todo('c', '11:00', '13:00'), todo('d', '13:00', '14:00'))
    ).toEqual({ a: [600, 720, 0, 2], b: [630, 660, 1, 2], c: [660, 780, 1, 2], d: [780, 840, 0, 1] })
  })
  it('随机组合中，同列的不重叠，列号有效', () => {
    let seed = 7
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n
    for (let round = 0; round < 500; round++) {
      const list = Array.from({ length: 1 + rnd(12) }, (_, i) => {
        const start = rnd(1400)
        return todo(`t${i}`, toTime(start), rnd(3) ? toTime(start + 1 + rnd(1439 - start)) : null)
      })
      const blocks = layoutDay(list)
      expect(blocks).toHaveLength(list.length)
      blocks.forEach((a, i) => {
        expect(a.column).toBeLessThan(a.columns)
        for (const b of blocks.slice(i + 1)) {
          if (a.start < b.end && b.start < a.end) {
            expect(a.column).not.toBe(b.column)
            expect(a.columns).toBe(b.columns)
          }
        }
      })
    }
  })
})