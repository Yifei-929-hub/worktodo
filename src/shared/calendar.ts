import { toMinutes } from './rules'
import type { Todo } from './types'
import { compareTodos, dayKey } from './views'

export type CalendarMode = 'month' | 'week' | 'day'

export const DAY_MINUTES = 24 * 60
/** 没有结束时间的显示时长 */
export const DEFAULT_MINUTES = 30
export const STEP = 15
/** 显示时的最短时长，保证短的和贴近午夜的也能点到 */
export const MIN_SHOWN = 15

const toDate = (key: string): Date => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function addDays(key: string, n: number): string {
  const d = toDate(key)
  return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime())
}

/** 月份加减；目标月没有这一天时取月末。 */
export function addMonths(key: string, n: number): string {
  const d = toDate(key)
  const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate()
  return dayKey(new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last)).getTime())
}

/** 所在周的周一 */
export const weekStart = (key: string): string => addDays(key, -((toDate(key).getDay() + 6) % 7))

export const weekDays = (key: string): string[] =>
  Array.from({ length: 7 }, (_, i) => addDays(weekStart(key), i))

/** 覆盖整个月的完整星期 */
export function monthDays(key: string): string[] {
  const first = `${key.slice(0, 8)}01`
  const start = weekStart(first)
  const end = addDays(weekStart(addDays(addMonths(first, 1), -1)), 6)
  const days: string[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d)
  return days
}

export function page(key: string, mode: CalendarMode, n: number): string {
  if (mode === 'month') return addMonths(key, n)
  return addDays(key, mode === 'week' ? n * 7 : n)
}

export interface DayItems {
  allDay: Todo[]
  timed: Todo[]
}

/** 按待办自己的日期归类，含已完成；没有日期的和回收站中的不显示。 */
export function itemsByDay(todos: Todo[], days: string[]): Map<string, DayItems> {
  const map = new Map<string, DayItems>(days.map((d) => [d, { allDay: [], timed: [] }]))
  for (const t of [...todos].sort(compareTodos)) {
    if (t.deletedAt !== null || t.date === null) continue
    const day = map.get(t.date)
    if (day) (t.time ? day.timed : day.allDay).push(t)
  }
  return map
}

export interface Block {
  todo: Todo
  /** 显示的起止，短的和贴近午夜的会与实际略有不同 */
  start: number
  end: number
  /** 重叠时并排：第几列、共几列 */
  column: number
  columns: number
}

/** 显示的起止：不足最短时长的补足，超过午夜的往上移。 */
export function shownSpan(t: Todo): { start: number; end: number } {
  const { start, end } = span(t)
  const top = Math.min(start, DAY_MINUTES - MIN_SHOWN)
  return { start: top, end: Math.max(end, top + MIN_SHOWN) }
}

export function span(t: Todo): { start: number; end: number } {
  const start = toMinutes(t.time!)
  const end = t.endTime ? toMinutes(t.endTime) : Math.min(start + DEFAULT_MINUTES, DAY_MINUTES)
  return { start, end }
}

/** 计算一天内各项的位置；首尾相接的不算重叠。 */
export function layoutDay(timed: Todo[]): Block[] {
  const blocks: Block[] = timed
    .map((todo) => ({ todo, ...shownSpan(todo), column: 0, columns: 1 }))
    .sort((a, b) => a.start - b.start || b.end - a.end || a.todo.sort - b.todo.sort)
  let cluster: Block[] = []
  let columnEnds: number[] = []
  const close = (): void => {
    for (const b of cluster) b.columns = columnEnds.length
    cluster = []
    columnEnds = []
  }
  for (const b of blocks) {
    if (cluster.length > 0 && columnEnds.every((end) => end <= b.start)) close()
    const free = columnEnds.findIndex((end) => end <= b.start)
    b.column = free < 0 ? columnEnds.length : free
    columnEnds[b.column] = b.end
    cluster.push(b)
  }
  close()
  return blocks
}
