import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Todo } from '../shared/types'
import { buildViews } from '../shared/views'
import { Calendar } from './Calendar'
import { Client, type Notice } from './client'
import { Detail } from './Detail'
import { formatDay } from './format'
import { QuickAdd } from './QuickAdd'
import { TodoList } from './TodoList'
import { TrashView } from './TrashView'

type View = 'today' | 'future' | 'calendar' | 'done' | 'log' | 'trash'

const NAV: [View, string][] = [
  ['today', '今天'],
  ['future', '未来'],
  ['calendar', '日历'],
  ['done', '已完成'],
  ['log', '工作日志'],
  ['trash', '回收站']
]

/** 完成后的输入条；draft 为 null 表示还没有改动过文字。 */
interface Bar {
  id: string
  draft: string | null
}

export function App() {
  const [notice, setNotice] = useState<Notice | null>(null)
  // 成功的操作只清掉普通提示，不清掉需要用户看到的失败提示
  const [client] = useState(
    () => new Client(window.worktodo, (n) => setNotice((old) => n ?? (old?.sticky ? old : null)))
  )
  const error = notice?.text ?? ''
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot)
  const [view, setView] = useState<View>('today')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusResult, setFocusResult] = useState(0)
  // 连续操作可能早于重新渲染，判断以引用为准，状态只用于显示
  const [bar, setBarState] = useState<Bar | null>(null)
  const barRef = useRef<Bar | null>(null)
  const setBar = useCallback((next: Bar | null) => {
    barRef.current = next
    setBarState(next)
  }, [])

  /** 保存输入条里已写的文字并关闭。 */
  const commitBar = useCallback(() => {
    const current = barRef.current
    setBar(null)
    if (current && current.draft !== null) void client.update(current.id, { result: current.draft })
  }, [client, setBar])

  useEffect(() => {
    void client.load()
    const off = window.worktodo.onState(client.receive)
    const onClose = (): void => {
      commitBar()
      client.retryUnsaved()
    }
    window.addEventListener('beforeunload', onClose)
    return () => {
      off()
      window.removeEventListener('beforeunload', onClose)
    }
  }, [client, commitBar])

  // 等数据加载后再定位；期间收到的定位由主进程保留
  const locateRef = useRef<(id: string) => void>(() => {})
  const loaded = state !== null
  useEffect(() => {
    if (!loaded) return
    const go = (id: string): void => locateRef.current(id)
    const off = window.worktodo.onFocus(go)
    void window.worktodo.takeFocus().then((id) => {
      if (id) go(id)
    })
    return off
  }, [loaded])

  const views = useMemo(() => (state ? buildViews(state.todos, state.today) : null), [state])
  if (!state || !views) return <div className="loading">{error || '正在打开…'}</div>

  const live = (id: string | undefined | null): Todo | undefined =>
    state.todos.find((t) => t.id === id && t.deletedAt === null)
  const selected = live(selectedId)
  const barTodo = live(bar?.id)

  const go = (next: View): void => {
    setView(next)
    setSelectedId(null)
  }

  /** 从通知、悬浮窗或错过提醒定位到某项。 */
  const locate = (id: string): void => {
    const todo = client.find(id)
    if (!todo || todo.deletedAt !== null) return
    if (todo.doneAt !== null) setView('done')
    else setView(todo.date !== null && todo.date <= state.today ? 'today' : 'future')
    select(id)
  }
  locateRef.current = locate

  const select = (id: string): void => {
    // 同一项的完成情况只在一处编辑：打开详情时先保存输入条
    if (barRef.current?.id === id) commitBar()
    setSelectedId(id)
  }

  const toggle = (id: string): void => {
    const todo = client.find(id)
    if (!todo) return
    const done = todo.doneAt === null
    commitBar()
    void client.setDone(id, done).then((ok) => {
      // 勾选失败时收起输入条，已写的文字仍保存
      if (!ok && barRef.current?.id === id) commitBar()
    })
    if (!done) return
    if (id === selected?.id) setFocusResult((n) => n + 1)
    else setBar({ id, draft: null })
  }
  const listProps = {
    today: state.today,
    selectedId,
    onSelect: select,
    onToggle: (t: Todo) => toggle(t.id),
    onReorder: (ids: string[]) => void client.reorder(ids)
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
        <button
          className="nav-item nav-float"
          aria-pressed={state.float.open}
          onClick={() => void client.setFloatOpen(!state.float.open)}
        >
          <span>悬浮窗</span>
          <span className="count">{state.float.open ? '已打开' : '未打开'}</span>
        </button>
      </nav>

      <main className="main">
        <header className="head">
          <h1>{NAV.find(([k]) => k === view)![1]}</h1>
          {view === 'today' && <span className="sub">{formatDay(state.today, state.today)}</span>}
        </header>

        {state.missed.length > 0 && (
          <section className="missed" aria-label="错过的提醒">
            <div>
              <strong>程序未运行时，错过了 {state.missed.length} 项提醒</strong>
              <button className="plain" onClick={() => void client.dismissMissed()}>
                知道了
              </button>
            </div>
            <ul>
              {state.missed.map((m) => (
                <li key={m.id}>
                  <button className="plain" onClick={() => locate(m.id)}>
                    {m.title}
                  </button>
                  <span className="when">
                    {formatDay(m.date, state.today)} {m.time}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {(view === 'today' || view === 'future') && (
          <QuickAdd
            key={view}
            hint={view === 'today' ? '添加今天的待办，按回车保存' : '添加到“未安排”，按回车保存'}
            onAdd={(title) => client.add(title, view === 'today' ? state.today : null)}
          />
        )}

        {view === 'calendar' && (
          <Calendar
            todos={state.todos}
            today={state.today}
            now={state.now}
            selectedId={selectedId}
            onSelect={select}
            onUpdate={(id, patch) => void client.update(id, patch)}
            onAdd={(title, d) => client.add(title, d.day, d.time, d.endTime)}
          />
        )}
        <div className="scroll" hidden={view === 'calendar'}>
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
              onRefresh={() => void client.load()}
              onRestore={(id) => void client.restore(id)}
              onPurge={(id) => void client.purge(id)}
            />
          )}
        </div>

        {bar && barTodo && (
          <ResultBar
            key={bar.id}
            title={barTodo.title}
            text={bar.draft ?? barTodo.result}
            onText={(draft) => setBar({ id: bar.id, draft })}
            onSave={commitBar}
            onSkip={() => setBar(null)}
          />
        )}
        {client.hasUnsaved() && (
          <div className="error" role="status">
            <span>有修改尚未保存，文字已保留，正在自动重试。</span>
            <button onClick={client.retryUnsaved}>立即保存</button>
          </div>
        )}
        {error && (
          <div className="error" role="alert">
            <span>{error}</span>
            <button onClick={() => setNotice(null)}>知道了</button>
          </div>
        )}
      </main>

      {selected && (
        <Detail
          key={selected.id}
          todo={selected}
          focusResult={focusResult}
          onChange={(patch) => client.update(selected.id, patch)}
          onToggle={() => toggle(selected.id)}
          onRemove={() => void client.remove(selected.id)}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  )
}

function ResultBar(props: {
  title: string
  text: string
  onText: (text: string) => void
  onSave: () => void
  onSkip: () => void
}) {
  return (
    <form
      className="result-bar"
      onSubmit={(e) => {
        e.preventDefault()
        props.onSave()
      }}
    >
      <label htmlFor="result-input">已完成“{props.title}”，完成情况如何？</label>
      <div>
        <input
          id="result-input"
          placeholder="选填，写日志时会用到"
          value={props.text}
          autoFocus
          onChange={(e) => props.onText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !e.nativeEvent.isComposing) props.onSkip()
          }}
        />
        <button type="submit">保存</button>
        <button type="button" className="plain" onClick={props.onSkip}>
          跳过
        </button>
      </div>
    </form>
  )
}