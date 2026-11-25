import type { Todo, TodoPatch } from './types'

/** 合并修改：标题去首尾空格；只填几点时日期取今天；清空日期时一并清空时间。 */
export function applyPatch(todo: Todo, patch: TodoPatch, today: string): Todo {
  const next: Todo = { ...todo, ...patch }
  next.title = next.title.trim()
  if (next.time && !next.date) {
    if (patch.time) next.date = today
    else next.time = null
  }
  return next
}

/** 在给定待办之间重新分配它们原有的排序值。 */
export function reorderSlots(todos: Todo[], ids: string[]): Map<string, number> {
  const sortOf = new Map(todos.map((t) => [t.id, t.sort]))
  const slots = ids.map((id) => sortOf.get(id) ?? 0).sort((a, b) => a - b)
  return new Map(ids.map((id, i) => [id, slots[i]]))
}
