import { useEffect, useRef, useState } from 'react'
import type { Todo } from '../shared/types'
import { TRASH_MS } from '../shared/views'

function remaining(todo: Todo, now: number): string {
  const minutes = Math.max(1, Math.ceil((todo.deletedAt! + TRASH_MS - now) / 60_000))
  return minutes >= 60 ? `约 ${Math.ceil(minutes / 60)} 小时后清除` : `${minutes} 分钟后清除`
}

export function TrashView(props: {
  todos: Todo[]
  now: number
  onRefresh: () => void
  onRestore: (id: string) => void
  onPurge: (id: string) => void
}) {
  const [asking, setAsking] = useState<Todo | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const { onRefresh } = props

  useEffect(() => {
    onRefresh()
    const timer = setInterval(onRefresh, 60_000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (asking) dialog.current?.showModal()
    else dialog.current?.close()
  }, [asking])

  return (
    <>
      <p className="hint">删除的待办保留 1 天，之后自动清除。</p>
      {props.todos.length === 0 && <p className="empty">回收站是空的。</p>}
      <ul>
        {props.todos.map((t) => (
          <li key={t.id} className="row" data-todo={t.title}>
            <div className="row-main">
              <span className="row-title">{t.title}</span>
              <span className="row-note">{remaining(t, props.now)}</span>
            </div>
            <button className="plain" onClick={() => props.onRestore(t.id)}>
              恢复
            </button>
            <button className="plain warn" onClick={() => setAsking(t)}>
              彻底删除
            </button>
          </li>
        ))}
      </ul>
      <dialog ref={dialog} onClose={() => setAsking(null)} aria-label="确认彻底删除">
        <p>彻底删除“{asking?.title}”？此操作无法撤销。</p>
        <div className="dialog-actions">
          <button className="plain" autoFocus onClick={() => setAsking(null)}>
            取消
          </button>
          <button
            className="danger"
            onClick={() => {
              if (asking) props.onPurge(asking.id)
              setAsking(null)
            }}
          >
            彻底删除
          </button>
        </div>
      </dialog>
    </>
  )
}
