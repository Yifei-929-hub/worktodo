import { useEffect, useMemo, useRef, useState } from 'react'
import {
  itemsByDay,
  layoutDay,
  monthDays,
  page,
  shownSpan,
  span,
  STEP,
  weekDays,
  type CalendarMode
} from '../shared/calendar'
import { LAST_MINUTE, shiftEnd, toMinutes, toTime } from '../shared/rules'
import type { Todo, TodoPatch } from '../shared/types'
import { dayKey } from '../shared/views'
import { formatDay } from './format'

/** 每小时的高度（像素） */
const HOUR = 72
const MONTH_MAX = 3
const MOVE_THRESHOLD = 4
const MODES: [CalendarMode, string][] = [
  ['month', '月'],
  ['week', '周'],
  ['day', '日']
]
const PRIORITY_CLASS = ['', 'p-low', 'p-mid', 'p-high']
const MODE_KEY = 'calendarMode'

function savedMode(): CalendarMode {
  try {
    const value = localStorage.getItem(MODE_KEY)
    return MODES.find(([m]) => m === value)?.[0] ?? 'week'
  } catch {
    return 'week'
  }
}

const px = (minutes: number): number => (minutes / 60) * HOUR
const snap = (minutes: number): number => Math.round(minutes / STEP) * STEP
const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n))

/** 鼠标所在的日期；minutes 为 null 表示全天区或月视图的格子 */
interface Spot {
  day: string
  minutes: number | null
}

interface Draft {
  day: string
  time: string | null
  endTime: string | null
}

/** outside：鼠标在日历外，此时松开即取消 */
type Gesture = { moved: boolean; outside: boolean } & (
  | { kind: 'create'; from: Spot; to: Spot }
  | { kind: 'move'; todo: Todo; grab: Spot; patch: TodoPatch | null }
  | { kind: 'resize'; todo: Todo; endTime: string | null }
)


interface Props {
  todos: Todo[]
  today: string
  now: number
  selectedId: string | null
  onSelect: (id: string) => void
  onUpdate: (id: string, patch: TodoPatch) => void
  onAdd: (title: string, draft: Draft) => Promise<boolean>
}

export function Calendar(props: Props) {
  const { today } = props
  const [mode, setModeState] = useState(savedMode)
  const [anchor, setAnchor] = useState(today)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [gesture, setGestureState] = useState<Gesture | null>(null)
  // 鼠标事件可能早于重新渲染，判断以引用为准，状态只用于显示
  const gestureRef = useRef<Gesture | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  const suppressClick = useRef(false)
  const draftText = useRef('')
  const root = useRef<HTMLDivElement>(null)

  const setGesture = (g: Gesture | null): void => {
    gestureRef.current = g
    setGestureState(g)
  }
  const setMode = (m: CalendarMode): void => {
    setModeState(m)
    try {
      localStorage.setItem(MODE_KEY, m)
    } catch {
      // 只影响下次打开时的视图
    }
  }

  // 跨零点时，停留在“今天”的视图随之前进
  const lastToday = useRef(today)
  useEffect(() => {
    if (lastToday.current !== today) {
      setAnchor((a) => (a === lastToday.current ? today : a))
      lastToday.current = today
    }
  }, [today])
  useEffect(() => () => stopRef.current?.(), [])

  const days = mode === 'month' ? monthDays(anchor) : mode === 'week' ? weekDays(anchor) : [anchor]

  // 拖动中显示预览后的结果
  const shown = useMemo(() => {
    if (!gesture || gesture.kind === 'create' || !gesture.moved || gesture.outside) return props.todos
    const patch = gesture.kind === 'move' ? gesture.patch : { endTime: gesture.endTime }
    return props.todos.map((t) => (t.id === gesture.todo.id && patch ? { ...t, ...patch } : t))
  }, [props.todos, gesture])
  const items = useMemo(() => itemsByDay(shown, days), [shown, days.join()])

  /** 由坐标找到日期和分钟；全天区和月视图的格子优先。不在日历的可见区内时为 null。 */
  const locate = (x: number, y: number): Spot | null => {
    const area = root.current?.querySelector('.cal-scroll, .month')?.getBoundingClientRect()
    if (!area || x < area.left || x >= area.right || y < area.top || y >= area.bottom) return null
    for (const el of root.current!.querySelectorAll<HTMLElement>('[data-cell]')) {
      const r = el.getBoundingClientRect()
      if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return { day: el.dataset.cell!, minutes: null }
    }
    // 顶部的日期栏盖在时间轴上，不算时间轴
    const header = root.current!.querySelector('.cal-top')?.getBoundingClientRect()
    if (!header || y < header.bottom) return null
    const columns = [...root.current!.querySelectorAll<HTMLElement>('[data-column]')]
    // 在小时标签或滚动条上时取最近的一天
    const gap = (el: HTMLElement): number => {
      const r = el.getBoundingClientRect()
      return Math.max(r.left - x, x - r.right, 0)
    }
    const el = columns.reduce((best, c) => (gap(c) < gap(best) ? c : best))
    const minutes = ((y - el.getBoundingClientRect().top) / HOUR) * 60
    return { day: el.dataset.column!, minutes: clamp(minutes, 0, LAST_MINUTE) }
  }

  const headerBottom = (): number =>
    root.current?.querySelector('.cal-top')?.getBoundingClientRect().bottom ?? 0

  const begin = (e: React.PointerEvent, start: Gesture): void => {
    if (e.button !== 0 || gestureRef.current) return
    const origin = { x: e.clientX, y: e.clientY }
    suppressClick.current = false
    setGesture(start)
    const onMove = (ev: PointerEvent): void => {
      const g = gestureRef.current
      if (!g) return
      const moved = g.moved || Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) >= MOVE_THRESHOLD
      if (!moved) return
      const spot = locate(ev.clientX, ev.clientY)
      const scroll = root.current?.querySelector('.cal-scroll')
      if (spot && scroll) {
        const r = scroll.getBoundingClientRect()
        if (ev.clientY > r.bottom - 24) scroll.scrollTop += 12
        else if (spot.minutes !== null && ev.clientY < headerBottom() + 24) scroll.scrollTop -= 12
      }
      const next = { ...g, moved, outside: spot === null }
      setGesture(spot ? advance(next, spot) : next)
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', onKey, true)
      stopRef.current = null
      setGesture(null)
    }
    // 松开后紧接着的点击不算；之后的点击（含键盘）恢复正常
    const clearLater = (): void => {
      setTimeout(() => (suppressClick.current = false))
    }
    const cancel = (): void => {
      suppressClick.current = true
      window.addEventListener('pointerup', clearLater, { once: true })
      stop()
    }
    const onUp = (): void => {
      const g = gestureRef.current
      stop()
      if (!g) return
      suppressClick.current = g.moved
      clearLater()
      finish(g)
    }
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      cancel()
    }
    stopRef.current = stop
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', onKey, true)
  }

  const advance = (g: Gesture, spot: Spot): Gesture => {
    if (g.kind === 'create') {
      // 拖选只在起点所在的那天
      return spot.minutes === null || g.from.minutes === null ? g : { ...g, to: { ...spot, day: g.from.day } }
    }
    if (g.kind === 'resize') {
      if (spot.minutes === null) return g
      const start = toMinutes(g.todo.time!)
      const end = clamp(Math.max(snap(spot.minutes), start + STEP), 0, LAST_MINUTE)
      return end > start ? { ...g, endTime: toTime(end) } : g
    }
    return { ...g, patch: movePatch(g.todo, g.grab, spot) }
  }

  /** 移动的结果；没有变化时为 null。 */
  const movePatch = (t: Todo, grab: Spot, spot: Spot): TodoPatch | null => {
    if (mode === 'month') return spot.day === t.date ? null : { date: spot.day }
    if (spot.minutes === null) {
      if (!t.time) return spot.day === t.date ? null : { date: spot.day }
      return { date: spot.day, time: null, endTime: null }
    }
    if (!t.time || grab.minutes === null) {
      return { date: spot.day, time: toTime(clamp(snap(spot.minutes), 0, 24 * 60 - STEP)), endTime: null }
    }
    const delta = snap(spot.minutes - grab.minutes)
    const start = toMinutes(t.time)
    const next = delta === 0 ? start : clamp(start + delta, 0, 24 * 60 - STEP)
    if (next === start && spot.day === t.date) return null
    const time = toTime(next)
    return { date: spot.day, time, endTime: next === start ? t.endTime : shiftEnd(t, time) }
  }

  const finish = (g: Gesture): void => {
    if (g.outside) return
    if (g.kind === 'create') {
      // 看得见的新建框里写了字时不替换它；翻页后看不见的，文字带到新的位置
      const visible = draft && days.includes(draft.day) && (mode !== 'month' || draft.time === null)
      if (visible && draftText.current.trim()) return
      const { day, minutes } = g.from
      if (minutes === null) setDraft({ day, time: null, endTime: null })
      else if (!g.moved) {
        setDraft({ day, time: toTime(clamp(Math.round(minutes / 30) * 30, 0, 23 * 60 + 30)), endTime: null })
      } else setDraft({ day, ...selection(minutes, g.to.minutes ?? minutes) })
      return
    }
    if (!g.moved) {
      // 在改时长的边缘上只是点一下，也打开详情
      if (g.kind === 'resize') props.onSelect(g.todo.id)
      return
    }
    if (g.kind === 'resize') {
      if (g.endTime && g.endTime !== g.todo.endTime) props.onUpdate(g.todo.id, { endTime: g.endTime })
    } else if (g.patch) props.onUpdate(g.todo.id, g.patch)
  }

  const selection = (a: number, b: number): { time: string; endTime: string } => {
    const start = clamp(snap(Math.min(a, b)), 0, 24 * 60 - STEP)
    const end = Math.max(snap(Math.max(a, b)), start + STEP)
    return { time: toTime(start), endTime: toTime(end) }
  }

  const openItem = (id: string): void => {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    props.onSelect(id)
  }

  const startMove = (e: React.PointerEvent, todo: Todo): void => {
    e.stopPropagation()
    suppressClick.current = false
    const grab = locate(e.clientX, e.clientY)
    if (todo.doneAt !== null || !grab) return
    begin(e, { kind: 'move', todo, grab, patch: null, moved: false, outside: false })
  }

  const startCreate = (e: React.PointerEvent, cell: string | null): void => {
    const spot = cell ? { day: cell, minutes: null } : locate(e.clientX, e.clientY)
    if (spot) begin(e, { kind: 'create', from: spot, to: spot, moved: false, outside: false })
  }

  const itemClass = (t: Todo): string =>
    [
      PRIORITY_CLASS[t.priority],
      t.doneAt !== null ? 'is-done' : '',
      t.id === props.selectedId ? 'is-selected' : '',
      gesture?.moved && gesture.kind !== 'create' && gesture.todo.id === t.id ? 'is-dragging' : ''
    ].join(' ')

  const draftForm = (day: string, allDay: boolean) =>
    draft && draft.day === day && (draft.time === null) === allDay ? (
      <DraftForm
        key={`${day}${draft.time}${draft.endTime}`}
        draft={draft}
        initial={draftText.current}
        onText={(text) => (draftText.current = text)}
        onSave={(title) => props.onAdd(title, draft)}
        onClose={() => {
          draftText.current = ''
          setDraft(null)
        }}
      />
    ) : null

  const chip = (t: Todo, withTime: boolean) => (
    <button
      key={t.id}
      data-item={t.title}
      className={`cal-chip ${itemClass(t)}`}
      title={t.title}
      onPointerDown={(e) => startMove(e, t)}
      onClick={() => openItem(t.id)}
    >
      {withTime && t.time && <span className="when">{t.time}</span>}
      <span className="cal-title">{t.title}</span>
    </button>
  )

  const title =
    mode === 'day'
      ? formatDay(anchor, today)
      : mode === 'month'
        ? `${Number(anchor.slice(0, 4))}年${Number(anchor.slice(5, 7))}月`
        : `${formatDay(days[0], today)} – ${formatDay(days[6], today)}`

  return (
    <div className="cal" ref={root}>
      <div className="cal-bar">
        <button className="plain" aria-label="上一页" onClick={() => setAnchor(page(anchor, mode, -1))}>
          ‹
        </button>
        <button className="plain" onClick={() => setAnchor(today)}>
          今天
        </button>
        <button className="plain" aria-label="下一页" onClick={() => setAnchor(page(anchor, mode, 1))}>
          ›
        </button>
        <strong className="cal-range">{title}</strong>
        <div className="seg" role="group" aria-label="视图">
          {MODES.map(([m, label]) => (
            <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {mode === 'month' ? (
        <div className="month">
          {days.slice(0, 7).map((d) => (
            <div key={d} className="month-week">
              {formatDay(d, today).slice(-2)}
            </div>
          ))}
          {days.map((d) => {
            const { allDay, timed } = items.get(d)!
            const all = [...allDay, ...timed]
            const rest = all.length - MONTH_MAX
            return (
              <div
                key={d}
                data-cell={d}
                className={`month-cell ${d === today ? 'is-today' : ''} ${d.slice(0, 7) === anchor.slice(0, 7) ? '' : 'is-other'}`}
                onPointerDown={(e) => startCreate(e, d)}
              >
                <span className="month-day">{Number(d.slice(8))}</span>
                {all.slice(0, MONTH_MAX).map((t) => chip(t, true))}
                {rest > 0 && (
                  <button
                    className="plain month-more"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      setAnchor(d)
                      setMode('day')
                    }}
                  >
                    还有 {rest} 项
                  </button>
                )}
                {draftForm(d, true)}
              </div>
            )
          })}
        </div>
      ) : (
        <TimeGrid key={mode} days={days} today={today} now={props.now}>
          {{
            allDay: (d) => (
              <div key={d} data-cell={d} className="allday-cell" onPointerDown={(e) => startCreate(e, d)}>
                {items.get(d)!.allDay.map((t) => chip(t, false))}
                {draftForm(d, true)}
              </div>
            ),
            column: (d) => (
              <div
                key={d}
                data-column={d}
                style={{ gridColumn: days.indexOf(d) + 2 }}
                className={`cal-column ${d === today ? 'is-today' : ''}`}
                onPointerDown={(e) => startCreate(e, null)}
              >
                {layoutDay(items.get(d)!.timed).map((b) => (
                  <div
                    key={b.todo.id}
                    data-item={b.todo.title}
                    className={`cal-block ${itemClass(b.todo)}`}
                    style={{
                      top: px(b.start),
                      height: px(b.end - b.start),
                      left: `${(b.column / b.columns) * 100}%`,
                      width: `${100 / b.columns}%`
                    }}
                  >
                    <button
                      className="cal-open"
                      title={b.todo.title}
                      onPointerDown={(e) => startMove(e, b.todo)}
                      onClick={() => openItem(b.todo.id)}
                    >
                      <span className="cal-title">{b.todo.title}</span>
                      <span className="when">
                        {b.todo.time}
                        {b.todo.endTime ? `–${b.todo.endTime}` : ''}
                      </span>
                    </button>
                    {b.todo.doneAt === null && b.start === span(b.todo).start && (
                      <span
                        className="cal-handle"
                        style={{ height: px(b.end - b.start) < 24 ? 4 : 6 }}
                        onPointerDown={(e) => {
                          e.stopPropagation()
                          begin(e, { kind: 'resize', todo: b.todo, endTime: b.todo.endTime, moved: false, outside: false })
                        }}
                      />
                    )}
                  </div>
                ))}
                {gesture?.kind === 'create' && gesture.moved && !gesture.outside && gesture.from.day === d && gesture.from.minutes !== null && (
                  <Selection {...selection(gesture.from.minutes, gesture.to.minutes ?? gesture.from.minutes)} />
                )}
                {draft?.day === d && draft.time && (
                  <div
                    className="cal-draft"
                    style={{
                      top: px(shownSpan({ time: draft.time, endTime: draft.endTime } as Todo).start),
                      minHeight: px(
                        span({ time: draft.time, endTime: draft.endTime } as Todo).end - toMinutes(draft.time)
                      )
                    }}
                  >
                    {draftForm(d, false)}
                  </div>
                )}
              </div>
            )
          }}
        </TimeGrid>
      )}
    </div>
  )
}

function Selection(props: { time: string; endTime: string }) {
  const top = px(toMinutes(props.time))
  return (
    <div className="cal-select" style={{ top, height: px(toMinutes(props.endTime)) - top }}>
      {props.time}–{props.endTime}
    </div>
  )
}

function TimeGrid(props: {
  days: string[]
  today: string
  now: number
  children: { allDay: (day: string) => React.ReactNode; column: (day: string) => React.ReactNode }
}) {
  // 主进程时钟与本窗口时钟的差，用来推算当前时间
  const skew = useMemo(() => props.now - Date.now(), [props.now])
  const [tick, setTick] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  const current = new Date(Math.max(tick + skew, props.now))
  const nowMinutes = current.getHours() * 60 + current.getMinutes()
  const nowDay = dayKey(current.getTime())

  const scroll = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!scroll.current) return
    const focus = props.days.includes(nowDay) ? nowMinutes - 60 : 8 * 60
    scroll.current.scrollTop = Math.max(0, px(focus))
    // 只在打开时滚动，翻页时保持位置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 窗口很窄时横向滚动，不把每天压得看不清
  const columns = {
    gridTemplateColumns: `48px repeat(${props.days.length}, minmax(0, 1fr))`,
    minWidth: props.days.length > 1 ? 48 + props.days.length * 72 : undefined
  }
  return (
    <div className="cal-scroll" ref={scroll}>
      <div className="cal-top" style={{ minWidth: columns.minWidth }}>
        <div className="cal-row" style={columns}>
          <span />
          {props.days.map((d) => (
            <span key={d} className={`cal-day ${d === props.today ? 'is-today' : ''}`}>
              {formatDay(d, d)}
            </span>
          ))}
        </div>
        <div className="cal-row" style={columns}>
          <span className="cal-hour">全天</span>
          {props.days.map(props.children.allDay)}
        </div>
      </div>
      <div className="cal-row cal-body" style={{ ...columns, height: HOUR * 24 }}>
        <div className="cal-hours">
          {Array.from({ length: 23 }, (_, i) => (
            <span key={i} className="cal-hour" style={{ top: px((i + 1) * 60) }}>
              {i + 1}:00
            </span>
          ))}
        </div>
        {props.days.map(props.children.column)}
        {props.days.includes(nowDay) && (
          <div
            className="cal-now"
            style={{
              top: px(nowMinutes),
              gridColumn: props.days.indexOf(nowDay) + 2
            }}
          />
        )}
      </div>
    </div>
  )
}

function DraftForm(props: {
  draft: Draft
  initial: string
  onText: (text: string) => void
  onSave: (title: string) => Promise<boolean>
  onClose: () => void
}) {
  const [text, setText] = useState(props.initial)
  const saving = useRef(false)
  return (
    <form
      className="cal-form"
      onPointerDown={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault()
        if (!text.trim() || saving.current) return
        saving.current = true
        // 失败时保留文字，由提示说明原因
        void props.onSave(text).then((ok) => {
          saving.current = false
          if (ok) props.onClose()
        })
      }}
    >
      <input
        aria-label="新建待办标题"
        placeholder="标题，回车保存"
        value={text}
        autoFocus
        onChange={(e) => {
          setText(e.target.value)
          props.onText(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.nativeEvent.isComposing) props.onClose()
        }}
        onBlur={() => {
          if (!text.trim()) props.onClose()
        }}
      />
      {props.draft.time && (
        <span className="when">
          {props.draft.time}
          {props.draft.endTime ? `–${props.draft.endTime}` : ''}
        </span>
      )}
    </form>
  )
}
