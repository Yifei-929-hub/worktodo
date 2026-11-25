import type { Todo, TodoPatch } from './types'

export const LAST_MINUTE = 23 * 60 + 59

export function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

export function toTime(minutes: number): string {
  const m = Math.max(0, Math.min(LAST_MINUTE, Math.round(minutes)))
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** 开始改到 time 后保持原时长的结束时间；超过当天的截到 23:59，截后不晚于开始的则没有结束时间。 */
export function shiftEnd(from: Pick<Todo, 'time' | 'endTime'>, time: string): string | null {
  if (!from.time || !from.endTime) return null
  const end = toTime(toMinutes(time) + toMinutes(from.endTime) - toMinutes(from.time))
  return end > time ? end : null
}

/** 结束时间必须有开始时间，且晚于开始。 */
export const isEndValid = (t: Pick<Todo, 'time' | 'endTime'>): boolean =>
  t.endTime === null || (t.time !== null && t.endTime > t.time)

/**
 * 合并修改：标题去首尾空格；只填几点时日期取今天；清空日期时一并清空时间；
 * 清空时间时一并清空结束时间；只改开始时间时保持时长。
 */
export function applyPatch(todo: Todo, patch: TodoPatch, today: string): Todo {
  const next: Todo = { ...todo, ...patch }
  next.title = next.title.trim()
  if (next.time && !next.date) {
    if (patch.time) next.date = today
    else next.time = null
  }
  if (!next.time) next.endTime = null
  else if (patch.time && patch.endTime === undefined && next.time !== todo.time) {
    next.endTime = shiftEnd(todo, next.time)
  }
  return next
}

/** 在给定待办之间重新分配它们原有的排序值。 */
export function reorderSlots(todos: Todo[], ids: string[]): Map<string, number> {
  const sortOf = new Map(todos.map((t) => [t.id, t.sort]))
  const slots = ids.map((id) => sortOf.get(id) ?? 0).sort((a, b) => a - b)
  return new Map(ids.map((id, i) => [id, slots[i]]))
}
