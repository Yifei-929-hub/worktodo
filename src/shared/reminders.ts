import type { Remind, Todo } from './types'

export const REMIND_OPTIONS: [Remind, string][] = [
  [0, '到点提醒'],
  [5, '提前 5 分钟'],
  [15, '提前 15 分钟'],
  [30, '提前 30 分钟'],
  [null, '不提醒']
]

/** 提醒时刻和待办时刻（毫秒）；没有具体时间或不提醒时为 null。 */
export function remindTimes(
  t: Pick<Todo, 'date' | 'time' | 'remind'>
): { at: number; start: number } | null {
  if (!t.date || !t.time || t.remind === null) return null
  const [y, m, d] = t.date.split('-').map(Number)
  const [h, min] = t.time.split(':').map(Number)
  const start = new Date(y, m - 1, d, h, min).getTime()
  return { at: start - t.remind * 60_000, start }
}
