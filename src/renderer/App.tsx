import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppState, Todo } from '../shared/types'
import { buildViews } from '../shared/views'
import { Detail } from './Detail'
import { formatDay } from './format'
import { TodoList } from './TodoList'
import { TrashView } from './TrashView'

type View = 'today' | 'future' | 'done' | 'log' | 'trash'

const NAV: [View, string][] = [
  ['today', '今天'],
  ['future', '未来'],
  ['done', '已完成'],
  ['log', '工作日志'],
  ['trash', '回收站']
]

const api = window.worktodo

export function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [view, setView] = useState<View>('today')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [justDone, setJustDone] = useState<string | null>(null)
  const [error, setError] = useState('')

  const run = useCallback(async (action: Promise<AppState>): Promise<boolean> => {
    try {
      setState(await action)
      setError('')
      return true
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e)
      setError(text.replace(/^Error invoking remote method '[^']*': (Error: )?/, ''))
      return false
    }
  }, [])

  useEffect(() => {
    void run(api.getState())
    return api.onState(setState)
  }, [run])

  const views = useMemo(() => (state ? buildViews(state.todos, state.today) : null), [state])
  if (!state || !views) return <div className="loading">{error || '正在打开…'}</div>

  const live = (id: string | null): Todo | undefined =>
    state.todos.find((t) => t.id === id && t.deletedAt === null)
  const selected = live(selectedId)
  const doneTodo = live(justDone)

  const go = (next: View): void => {
    setView(next)
    setSelectedId(null)
  }

  const toggle = async (t: Todo): Promise<void> => {
    const done = t.doneAt === null
    if (await run(api.setDone(t.id, done))) setJustDone(done ? t.id : null)
  }

  const listProps = {
    today: state.today,
    selectedId,
    onSelect: setSelectedId,
    onToggle: (t: Todo) => void toggle(t),
    onReorder: (ids: string[]) => void run(api.reorder(ids))
  }

  const counts: Partial<Record<View, number>> = {
    today: views.overdue.length + views.today.length,
    future: views.unscheduled.length + views.future.reduce((n, g) => n + g.todos.length, 0),
    trash: views.trash.length
  }

  return (
    <div className="app">
      <nav className="nav" aria-label="主导航">
        <div className="brand">WorkTodo</div>
        {NAV.map(([key, label]) => (
          <button
            key={key}
            className="nav-item"
            aria-current={view === key ? 'page' : undefined}
            onClick={() => go(key)}
          >
            <span>{label}</span>
            {counts[key] ? <span className="count">{counts[key]}</span> : null}
          </button>
        ))}
      </nav>

      <main className="main">
        <header className="head">
          <h1>{NAV.find(([k]) => k === view)![1]}</h1>
          {view === 'today' && <span className="sub">{formatDay(state.today, state.today)}</span>}
        </header>

        {(view === 'today' || view === 'future') && (
          <QuickAdd
            key={view}
            hint={view === 'today' ? '添加今天的待办，按回车保存' : '添加到“未安排”，按回车保存'}
            onAdd={(title) => run(api.add(title, view === 'today' ? state.today : null))}
          />
        )}

        <div className="scroll">
          {view === 'today' && (
            <>
              {views.overdue.length > 0 && (
                <TodoList {...listProps} title="已逾期" tone="late" todos={views.overdue} sortable showDate />
              )}
              <TodoList {...listProps} title="今天" todos={views.today} sortable />
              {views.overdue.length + views.today.length === 0 && (
                <p className="empty">今天没有待办的事项。</p>
              )}
              {views.doneToday.length > 0 && (
                <TodoList {...listProps} title="今天已完成" todos={views.doneToday} collapsible />
              )}
            </>
          )}
          {view === 'future' && (
            <>
              {views.future.map((g) => (
                <TodoList
                  {...listProps}
                  key={g.key}
                  title={formatDay(g.key, state.today)}
                  todos={g.todos}
                  sortable
                />
              ))}
              {views.unscheduled.length > 0 && (
                <TodoList {...listProps} title="未安排" todos={views.unscheduled} sortable />
              )}
              {counts.future === 0 && <p className="empty">之后还没有安排。</p>}
            </>
          )}
          {view === 'done' &&
            (views.done.length ? (
              views.done.map((g) => (
                <TodoList {...listProps} key={g.key} title={formatDay(g.key, state.today)} todos={g.todos} />
              ))
            ) : (
              <p className="empty">完成的待办会出现在这里。</p>
            ))}
          {view === 'log' && <p className="empty">工作日志将在阶段 C 提供。</p>}
          {view === 'trash' && (
            <TrashView
              todos={views.trash}
              now={state.now}
              onRefresh={() => void run(api.getState())}
              onRestore={(id) => void run(api.restore(id))}
              onPurge={(id) => void run(api.purge(id))}
            />
          )}
        </div>

        {doneTodo && doneTodo.doneAt !== null && (
          <ResultBar
            key={doneTodo.id}
            todo={doneTodo}
            onSave={(result) => run(api.update(doneTodo.id, { result }))}
            onClose={() => setJustDone(null)}
          />
        )}
        {error && (
          <div className="error" role="alert">
            <span>{error}</span>
            <button onClick={() => setError('')}>知道了</button>
          </div>
        )}
      </main>

      {selected && (
        <Detail
          key={selected.id}
          todo={selected}
          onChange={(patch) => run(api.update(selected.id, patch))}
          onToggle={() => void toggle(selected)}
          onRemove={() => void run(api.remove(selected.id))}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  )
}

function QuickAdd(props: { hint: string; onAdd: (title: string) => Promise<boolean> }) {
  const [text, setText] = useState('')
  return (
    <form
      className="quick"
      onSubmit={(e) => {
        e.preventDefault()
        const value = text
        void props.onAdd(value).then((ok) => {
          if (ok) setText((current) => (current === value ? '' : current))
        })
      }}
    >
      <input
        aria-label="快速添加"
        placeholder={props.hint}
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit">添加</button>
    </form>
  )
}

function ResultBar(props: {
  todo: Todo
  onSave: (result: string) => Promise<boolean>
  onClose: () => void
}) {
  const [text, setText] = useState(props.todo.result)
  return (
    <form
      className="result-bar"
      onSubmit={(e) => {
        e.preventDefault()
        void props.onSave(text).then((ok) => ok && props.onClose())
      }}
    >
      <label htmlFor="result-input">已完成“{props.todo.title}”，完成情况如何？</label>
      <div>
        <input
          id="result-input"
          placeholder="选填，写日志时会用到"
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !e.nativeEvent.isComposing) props.onClose()
          }}
        />
        <button type="submit">保存</button>
        <button type="button" className="plain" onClick={props.onClose}>
          跳过
        </button>
      </div>
    </form>
  )
}
