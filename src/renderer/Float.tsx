import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { Todo } from '../shared/types'
import { buildViews } from '../shared/views'
import { Client, type Notice } from './client'
import { formatDay } from './format'
import { QuickAdd } from './QuickAdd'
import { TodoList } from './TodoList'

/** 悬浮窗：只显示今天和逾期的待办。 */
export function Float() {
  const [notice, setNotice] = useState<Notice | null>(null)
  const [client] = useState(
    () => new Client(window.worktodo, (n) => setNotice((old) => n ?? (old?.sticky ? old : null)))
  )
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot)
  useEffect(() => {
    void client.load()
    return window.worktodo.onState(client.receive)
  }, [client])
  const views = useMemo(() => (state ? buildViews(state.todos, state.today) : null), [state])
  if (!state || !views) return <div className="loading">{notice?.text ?? '正在打开…'}</div>

  const listProps = {
    today: state.today,
    selectedId: null,
    onSelect: (id: string) => void window.worktodo.openMain(id),
    onToggle: (t: Todo) => void client.setDone(t.id, true),
    onReorder: () => {}
  }
  const { pinned } = state.float

  return (
    <div className="float">
      <header className="float-head">
        <strong>今天</strong>
        <span className="sub">{formatDay(state.today, state.today)}</span>
        <button
          className="plain icon"
          aria-pressed={pinned}
          aria-label="置顶"
          title={pinned ? '取消置顶' : '置顶'}
          onClick={() => void client.setFloatPinned(!pinned)}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M5 2h6l-.8 4.2L13 9v1.2H8.7V14L8 15l-.7-1v-3.8H3V9l2.8-2.8z"
              fill={pinned ? 'currentColor' : 'none'}
              stroke="currentColor"
            />
          </svg>
        </button>
        <button
          className="plain icon"
          aria-label="关闭悬浮窗"
          title="关闭悬浮窗"
          onClick={() => void client.setFloatOpen(false)}
        >
          ×
        </button>
      </header>
      <QuickAdd hint="添加今天的待办" onAdd={(title) => client.add(title, state.today)} />
      <div className="scroll">
        {views.overdue.length > 0 && (
          <TodoList {...listProps} title="已逾期" tone="late" todos={views.overdue} />
        )}
        {views.today.length > 0 && <TodoList {...listProps} title="今天" todos={views.today} />}
        {views.overdue.length + views.today.length === 0 && <p className="empty">今天没有待办的事项。</p>}
      </div>
      {notice && (
        <div className="error" role="alert">
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)}>知道了</button>
        </div>
      )}
    </div>
  )
}
