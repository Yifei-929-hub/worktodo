import type { Todo } from './types'

export const TRASH_MS = 24 * 60 * 60 * 1000

const pad = (n: number): string => String(n).padStart(2, '0')

export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function isValidDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return false
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return dayKey(d.getTime()) === value
}

export const isValidTime = (value: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)

/** 有时间的按时间在前，没有时间的按拖动顺序；优先级不参与。 */
export function compareTodos(a: Todo, b: Todo): number {
  if (a.time && b.time) {
    const ka = `${a.date} ${a.time}`
    const kb = `${b.date} ${b.time}`
    return ka === kb ? a.sort - b.sort : ka < kb ? -1 : 1
  }
  if (a.time) return -1
  if (b.time) return 1
  return a.sort - b.sort
}

export interface Group {
  key: string
  todos: Todo[]
}

export interface Views {
  overdue: Todo[]
  today: Todo[]
  doneToday: Todo[]
  future: Group[]
  unscheduled: Todo[]
  done: Group[]
  trash: Todo[]
}

function groupBy(todos: Todo[], key: (t: Todo) => string): Group[] {
  const map = new Map<string, Todo[]>()
  for (const t of todos) {
    const k = key(t)
    const list = map.get(k)
    if (list) list.push(t)
    else map.set(k, [t])
  }
  return [...map].map(([k, list]) => ({ key: k, todos: list }))
}

export function buildViews(all: Todo[], today: string): Views {
  const live = all.filter((t) => t.deletedAt === null)
  const open = live.filter((t) => t.doneAt === null).sort(compareTodos)
  const done = live.filter((t) => t.doneAt !== null).sort((a, b) => b.doneAt! - a.doneAt!)
  return {
    overdue: open.filter((t) => t.date !== null && t.date < today),
    today: open.filter((t) => t.date === today),
    doneToday: done.filter((t) => dayKey(t.doneAt!) === today),
    future: groupBy(
      open.filter((t) => t.date !== null && t.date > today),
      (t) => t.date!
    ).sort((a, b) => (a.key < b.key ? -1 : 1)),
    unscheduled: open.filter((t) => t.date === null),
    done: groupBy(done, (t) => dayKey(t.doneAt!)),
    trash: all.filter((t) => t.deletedAt !== null).sort((a, b) => b.deletedAt! - a.deletedAt!)
  }
}
