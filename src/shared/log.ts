import type { LogItem, Todo } from './types'
import { dayKey } from './views'

/** 句末标点：已有则不再补“。” */
const END = /[。！？!?….]$/
/** 末尾的逗号、分号等换成句号 */
const WEAK = /[，、；：,;:]+$/
/** 行末有这些标点时，与下一行直接连接 */
const ANY = /[，、；：。！？,;:.!?…]$/

/** 补齐句末标点。 */
export function sentence(text: string): string {
  const t = text.trim()
  if (!t) return ''
  if (END.test(t)) return t
  return t.replace(WEAK, '') + '。'
}

/** 多行详情并成一行，用“；”连接；行末已有标点的直接连接。 */
export function joinLines(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.reduce((out, line) => (out === '' ? line : ANY.test(out) ? out + line : `${out}；${line}`), '')
}

/** 日志日期，如 11.23（不补零） */
export function logDate(date: string): string {
  const [, m, d] = date.split('-').map(Number)
  return `${m}.${d}`
}

export function formatItem(item: LogItem): string {
  return sentence(item.title.replace(/\s*\r?\n\s*/g, ' ')) + sentence(joinLines(item.detail))
}

/** 拼成日志文字；标题和详情都为空的条目跳过。 */
export function formatLog(date: string, items: LogItem[]): string {
  const lines = items.map(formatItem).filter(Boolean)
  return [logDate(date), ...lines.map((line, i) => `（${i + 1}）${line}`)].join('\n')
}

/** 由待办生成一条：详情优先取完成情况，没有则取细节描述。 */
export const fromTodo = (t: Todo): LogItem => ({
  todoId: t.id,
  title: t.title,
  detail: t.result.trim() ? t.result : t.detail
})

/** 默认条目：这一天勾选完成的待办，按完成先后。 */
export function defaultItems(todos: Todo[], date: string): LogItem[] {
  return todos
    .filter((t) => t.deletedAt === null && t.doneAt !== null && dayKey(t.doneAt) === date)
    .sort((a, b) => a.doneAt! - b.doneAt!)
    .map(fromTodo)
}
