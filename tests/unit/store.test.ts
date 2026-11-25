import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TodoStore } from '../../src/main/store'
import { buildViews, isValidDate, isValidTime } from '../../src/shared/views'

const at = (y: number, m: number, d: number, h = 9, min = 0): number =>
  new Date(y, m - 1, d, h, min).getTime()
const HOUR = 3600_000

let dir: string
let path: string
let now: number
let store: TodoStore

const open = (): TodoStore => new TodoStore(path, () => now)
const get = (id: string) => store.state().todos.find((t) => t.id === id)!
const views = () => {
  const s = store.state()
  return buildViews(s.todos, s.today)
}
const titles = (list: { title: string }[]): string[] => list.map((t) => t.title)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'worktodo-test-'))
  path = join(dir, 'test.db')
  now = at(2030, 3, 10)
  store = open()
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('A1 添加与编辑', () => {
  it('只填标题即可添加，首尾空格去除，默认值正确', () => {
    const t = get(store.add('  写周会材料 ', null))
    expect(t).toMatchObject({
      title: '写周会材料', date: null, time: null, detail: '', result: '', priority: 0, doneAt: null
    })
  })
  it('空标题不能添加或保存', () => {
    expect(() => store.add(' \n ', null)).toThrow('标题不能为空')
    const id = store.add('甲', null)
    expect(() => store.update(id, { title: '  ', detail: 'x' })).toThrow('标题不能为空')
    expect(get(id)).toMatchObject({ title: '甲', detail: '' })
  })
  it('全部字段可编辑，重新打开后不变', () => {
    const id = store.add('甲', null)
    const patch = {
      title: '乙', date: '2030-03-12', time: '14:30', detail: '行1\n行2', result: "做完 '了'", priority: 3 as const
    }
    store.update(id, patch)
    store.close()
    store = open()
    expect(get(id)).toMatchObject(patch)
  })
  it('拒绝无效的日期、时间和优先级', () => {
    const id = store.add('甲', null)
    expect(() => store.update(id, { date: '2030-02-30' })).toThrow('日期无效')
    expect(() => store.update(id, { time: '24:00' })).toThrow('时间无效')
    expect(() => store.update(id, { priority: 9 as never })).toThrow('优先级无效')
    expect(isValidDate('2028-02-29')).toBe(true)
    expect(isValidTime('00:00')).toBe(true)
  })
  it('只填几点时日期取今天；清空日期时一并清空时间', () => {
    const id = store.add('甲', null)
    store.update(id, { time: '10:00' })
    expect(get(id)).toMatchObject({ date: '2030-03-10', time: '10:00' })
    store.update(id, { date: null })
    expect(get(id)).toMatchObject({ date: null, time: null })
  })
  it('拒绝打开更新版本创建的数据', () => {
    const other = join(dir, 'newer.db')
    const db = new DatabaseSync(other)
    db.exec('PRAGMA user_version = 99')
    db.close()
    expect(() => new TodoStore(other)).toThrow('升级软件')
  })
})

describe('A2 A3 视图归属', () => {
  it('今天、未来、未安排分别归类，未来按日期分组', () => {
    store.add('今', '2030-03-10')
    store.add('后天', '2030-03-12')
    store.add('明天', '2030-03-11')
    store.add('无日期', null)
    const v = views()
    expect(titles(v.today)).toEqual(['今'])
    expect(v.future.map((g) => g.key)).toEqual(['2030-03-11', '2030-03-12'])
    expect(titles(v.unscheduled)).toEqual(['无日期'])
  })
  it('当天已过时间不算逾期，跨零点后进入已逾期且日期不变', () => {
    const id = store.add('会议', '2030-03-10')
    store.update(id, { time: '09:30' })
    now = at(2030, 3, 10, 23, 59)
    expect(titles(views().today)).toEqual(['会议'])
    now = at(2030, 3, 11, 0, 0)
    expect(titles(views().overdue)).toEqual(['会议'])
    expect(get(id).date).toBe('2030-03-10')
  })
})

describe('A4 完成', () => {
  it('当天在今天的完成区，次日只在已完成', () => {
    const id = store.add('甲', '2030-03-08')
    store.setDone(id, true)
    expect(titles(views().doneToday)).toEqual(['甲'])
    expect(views().overdue).toEqual([])
    now = at(2030, 3, 11)
    expect(views().doneToday).toEqual([])
    expect(views().done).toMatchObject([{ key: '2030-03-10', todos: [{ title: '甲' }] }])
  })
  it('取消勾选后完成情况保留；重复勾选不改变完成时间', () => {
    const id = store.add('甲', '2030-03-10')
    store.setDone(id, true)
    const first = get(id).doneAt
    store.update(id, { result: '已交付' })
    now += HOUR
    store.setDone(id, true)
    expect(get(id).doneAt).toBe(first)
    store.setDone(id, false)
    expect(get(id)).toMatchObject({ doneAt: null, result: '已交付' })
    expect(titles(views().today)).toEqual(['甲'])
  })
})

describe('A5 排序', () => {
  it('有时间的按时间在前，无时间的按拖动顺序并持久化，优先级不影响', () => {
    const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map((t) => store.add(t, '2030-03-10'))
    store.update(d, { time: '15:00' })
    store.update(e, { time: '09:00' })
    expect(titles(views().today)).toEqual(['e', 'd', 'a', 'b', 'c'])
    store.reorder([c, a, b])
    store.update(b, { priority: 3 })
    store.close()
    store = open()
    expect(titles(views().today)).toEqual(['e', 'd', 'c', 'a', 'b'])
  })
  it('重排不影响其他待办，重复或未知的 id 被拒绝且顺序不变', () => {
    const [a, b, x] = ['a', 'b', 'x'].map((t) => store.add(t, null))
    store.reorder([b, a])
    expect(titles(views().unscheduled)).toEqual(['b', 'a', 'x'])
    expect(() => store.reorder([a, a])).toThrow()
    expect(() => store.reorder([x, a, 'none'])).toThrow()
    expect(titles(views().unscheduled)).toEqual(['b', 'a', 'x'])
  })
})

describe('A6 回收站', () => {
  it('删除后只在回收站，可恢复并保留内容', () => {
    const id = store.add('甲', '2030-03-10')
    store.update(id, { detail: '说明' })
    store.remove(id)
    expect(views().today).toEqual([])
    expect(titles(views().trash)).toEqual(['甲'])
    expect(() => store.update(id, { title: '乙' })).toThrow()
    store.restore(id)
    expect(get(id)).toMatchObject({ detail: '说明', deletedAt: null })
  })
  it('未满 24 小时保留，满 24 小时清除，重新打开后同样生效', () => {
    store.add('保留', null)
    const id = store.add('甲', null)
    store.remove(id)
    now += 24 * HOUR - 1
    expect(store.purgeExpired()).toBe(0)
    store.close()
    now += 1
    store = open()
    expect(store.purgeExpired()).toBe(1)
    expect(titles(store.state().todos)).toEqual(['保留'])
  })
  it('只能彻底删除回收站中的待办', () => {
    const id = store.add('甲', null)
    expect(() => store.purge(id)).toThrow()
    store.remove(id)
    store.purge(id)
    expect(store.state().todos).toEqual([])
  })
})
