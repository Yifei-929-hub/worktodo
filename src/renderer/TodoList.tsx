import { useRef, useState, type DragEvent } from 'react'
import type { Todo } from '../shared/types'
import { formatDay } from './format'

const PRIORITY_CLASS = ['', 'p-low', 'p-mid', 'p-high']
const PRIORITY_TEXT = ['', '低优先级', '中优先级', '高优先级']

let lastCheck = { id: '', x: 0, y: 0, at: 0 }

/**
 * 勾选后下方的行会移到鼠标下面，双击的第二下会误勾下一项。
 * 行已更换，浏览器不再把它算作双击，因此按位置和时间判断。
 */
function isSlippedClick(id: string, e: Event): boolean {
  if (!(e instanceof MouseEvent) || e.detail === 0) return false // 键盘操作
  const slipped =
    lastCheck.id !== id &&
    e.timeStamp - lastCheck.at < 300 &&
    Math.hypot(e.clientX - lastCheck.x, e.clientY - lastCheck.y) < 5
  if (!slipped) lastCheck = { id, x: e.clientX, y: e.clientY, at: e.timeStamp }
  return slipped
}

export function TodoList(props: {
  title: string
  todos: Todo[]
  today: string
  selectedId: string | null
  tone?: 'late'
  sortable?: boolean
  collapsible?: boolean
  showDate?: boolean
  onSelect: (id: string) => void
  onToggle: (todo: Todo) => void
  onReorder: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(!props.collapsible)
  const [dragId, setDragState] = useState<string | null>(null)
  // 拖放事件可能早于重新渲染，判断以引用为准，状态只用于显示
  const dragRef = useRef<string | null>(null)
  const setDragId = (id: string | null): void => {
    dragRef.current = id
    setDragState(id)
  }
  const [overId, setOverId] = useState<string | null>(null)
  // 只有没有时间的待办可以拖动
  const movable = props.sortable ? props.todos.filter((t) => !t.time).map((t) => t.id) : []

  const move = (id: string, targetIndex: number): void => {
    const from = movable.indexOf(id)
    if (from < 0 || targetIndex < 0 || targetIndex >= movable.length || from === targetIndex) return
    const ids = movable.filter((x) => x !== id)
    ids.splice(targetIndex, 0, id)
    props.onReorder(ids)
  }

  /** 放下后的目标位置：在行上取该行的位置；在行间空隙取上方可拖动行的数量；不可放下时为 -1。 */
  const targetIndex = (e: DragEvent<HTMLUListElement>): number => {
    const id = dragRef.current
    if (id === null || !movable.includes(id)) return -1
    const hit = (e.target as Element).closest('li')
    if (hit) return movable.indexOf(hit.dataset.id ?? '')
    return [...e.currentTarget.querySelectorAll('li')].filter((li) => {
      if (li.dataset.id === id || !movable.includes(li.dataset.id ?? '')) return false
      const box = li.getBoundingClientRect()
      return box.top + box.height / 2 < e.clientY
    }).length
  }

  const endDrag = (): void => {
    setDragId(null)
    setOverId(null)
  }

  return (
    <section className={`group ${props.tone ?? ''}`} aria-label={props.title}>
      {props.collapsible ? (
        <button className="group-title" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} {props.title}（{props.todos.length}）
        </button>
      ) : (
        props.todos.length > 0 && <h2 className="group-title">{props.title}</h2>
      )}
      {open && (
        <ul
          onDragOver={(e) => {
            const index = targetIndex(e)
            setOverId(index < 0 ? null : movable[index])
            if (index >= 0) e.preventDefault()
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverId(null)
          }}
          onDrop={(e) => {
            e.preventDefault()
            const index = targetIndex(e)
            if (dragRef.current !== null) move(dragRef.current, index)
            endDrag()
          }}
        >
          {props.todos.map((t) => {
            const index = movable.indexOf(t.id)
            const draggable = index >= 0 && movable.length > 1
            return (
              <li
                key={t.id}
                data-id={t.id}
                data-todo={t.title}
                className={[
                  'row',
                  PRIORITY_CLASS[t.priority],
                  t.doneAt !== null ? 'is-done' : '',
                  t.id === props.selectedId ? 'is-selected' : '',
                  t.id === overId && dragId !== null && dragId !== t.id
                    ? index > movable.indexOf(dragId)
                      ? 'drop-after'
                      : 'drop-before'
                    : ''
                ].join(' ')}
                draggable={draggable}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', t.id)
                  setDragId(t.id)
                }}
                onDragEnd={endDrag}
              >
                <input
                  type="checkbox"
                  aria-label={`完成：${t.title}`}
                  checked={t.doneAt !== null}
                  onChange={(e) => {
                    if (!isSlippedClick(t.id, e.nativeEvent)) props.onToggle(t)
                  }}
                />
                <button
                  className="row-main"
                  onClick={() => props.onSelect(t.id)}
                  onKeyDown={(e) => {
                    if (!e.altKey || index < 0) return
                    if (e.key === 'ArrowUp') move(t.id, index - 1)
                    else if (e.key === 'ArrowDown') move(t.id, index + 1)
                    else return
                    e.preventDefault()
                  }}
                >
                  <span className="row-title">{t.title}</span>
                  {(t.result || t.detail) && <span className="row-note">{t.result || t.detail}</span>}
                </button>
                {t.priority > 0 && <span className="prio" title={PRIORITY_TEXT[t.priority]} role="img" aria-label={PRIORITY_TEXT[t.priority]} />}
                <span className="when">
                  {props.showDate && t.date ? formatDay(t.date, props.today) + ' ' : ''}
                  {t.time ?? ''}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
