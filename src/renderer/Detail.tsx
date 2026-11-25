import { useEffect, useRef, useState } from 'react'
import { REMIND_OPTIONS } from '../shared/reminders'
import { shiftEnd, toMinutes, toTime } from '../shared/rules'
import type { Priority, Todo, TodoPatch } from '../shared/types'

const PRIORITIES: [Priority, string][] = [
  [0, '无'],
  [3, '高'],
  [2, '中'],
  [1, '低']
]

/** 修改即时保存，不需要保存按钮。 */
export function Detail(props: {
  todo: Todo
  /** 变大时把光标移到完成情况 */
  focusResult: number
  onChange: (patch: TodoPatch) => Promise<boolean>
  onToggle: () => void
  onRemove: () => void
  onClose: () => void
}) {
  const { todo, onChange } = props
  // 只在输入标题时保留草稿（可能暂时为空），其余字段直接显示当前数据
  const [draft, setDraft] = useState<string | null>(null)
  const emptyTitle = draft !== null && draft.trim() === ''
  const resultRef = useRef<HTMLTextAreaElement>(null)
  const { focusResult } = props
  const focusSeen = useRef(focusResult)
  // 键盘输入开始时间会经过中间值（可能被截到 23:59），只要没有从别处改过，就以最初的时长为准
  type Moment = Pick<Todo, 'time' | 'endTime'>
  const timeBase = useRef<{ base: Moment; last: Moment } | null>(null)
  const changeTime = (time: string): Promise<boolean> => {
    const kept = timeBase.current
    const same = kept && kept.last.time === todo.time && kept.last.endTime === todo.endTime
    const base = same ? kept.base : { time: todo.time, endTime: todo.endTime }
    if (!base.endTime) return onChange({ time })
    const last = { time, endTime: shiftEnd(base, time) }
    timeBase.current = { base, last }
    return onChange(last)
  }
  useEffect(() => {
    if (focusResult === focusSeen.current) return
    focusSeen.current = focusResult
    resultRef.current?.focus()
  }, [focusResult])
  return (
    <aside className="detail" aria-label="待办详情">
      <div className="detail-top">
        <label className="check">
          <input type="checkbox" checked={todo.doneAt !== null} onChange={props.onToggle} />
          {todo.doneAt !== null ? '已完成' : '未完成'}
        </label>
        <button className="plain" onClick={props.onClose}>
          关闭
        </button>
      </div>

      <label className="field">
        <span>标题</span>
        <input
          value={draft ?? todo.title}
          aria-invalid={emptyTitle}
          onChange={(e) => {
            setDraft(e.target.value)
            if (e.target.value.trim()) void onChange({ title: e.target.value })
          }}
          onBlur={() => setDraft(null)}
        />
        {emptyTitle && <em>标题不能为空，离开后将恢复原标题</em>}
      </label>

      <div className="pair">
        <label className="field">
          <span>日期</span>
          <MomentInput type="date" value={todo.date} onCommit={(date) => onChange({ date })} />
        </label>
        <label className="field">
          <span>时间</span>
          <MomentInput
            type="time"
            value={todo.time}
            onCommit={changeTime}
          />
        </label>
      </div>
      {todo.time && todo.time < '23:59' && (
        <label className="field">
          <span>结束时间</span>
          <MomentInput
            type="time"
            value={todo.endTime}
            min={toTime(toMinutes(todo.time) + 1)}
            hint="结束时间要晚于开始时间，离开后将恢复原值"
            onCommit={(endTime) => onChange({ endTime })}
          />
        </label>
      )}
      <div className="clear">
        {todo.date && (
          <button className="plain" onClick={() => void onChange({ date: null })}>
            清空日期
          </button>
        )}
        {todo.time && (
          <button className="plain" onClick={() => void onChange({ time: null })}>
            清空时间
          </button>
        )}
        {todo.endTime && (
          <button className="plain" onClick={() => void onChange({ endTime: null })}>
            清空结束时间
          </button>
        )}
      </div>

      {todo.time && (
        <label className="field">
          <span>提醒</span>
          <select
            value={String(todo.remind)}
            onChange={(e) => {
              const option = REMIND_OPTIONS.find(([value]) => String(value) === e.target.value)
              if (option) void onChange({ remind: option[0] })
            }}
          >
            {REMIND_OPTIONS.map(([value, label]) => (
              <option key={label} value={String(value)}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}

      <fieldset className="field">
        <legend>优先级</legend>
        <div className="seg">
          {PRIORITIES.map(([value, label]) => (
            <label key={value}>
              <input
                type="radio"
                name="priority"
                checked={todo.priority === value}
                onChange={() => void onChange({ priority: value })}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="field">
        <span>细节描述</span>
        <textarea
          rows={5}
          placeholder="计划做什么"
          value={todo.detail}
          onChange={(e) => void onChange({ detail: e.target.value })}
        />
      </label>
      <label className="field">
        <span>完成情况</span>
        <textarea
          rows={5}
          placeholder="实际做了什么，写日志时优先使用"
          ref={resultRef}
          value={todo.result}
          onChange={(e) => void onChange({ result: e.target.value })}
        />
      </label>

      <button className="danger" onClick={props.onRemove}>
        移到回收站
      </button>
    </aside>
  )
}

/** 键盘输入日期时间会经过不完整的中间状态，因此只保存完整的值；清空由专门的按钮完成。 */
function MomentInput(props: {
  type: 'date' | 'time'
  value: string | null
  min?: string
  /** 内容超出范围时的说明 */
  hint?: string
  onCommit: (value: string) => Promise<boolean>
}) {
  const [bad, setBad] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  const stored = props.value ?? ''
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current) ref.current.value = stored
  }, [stored])
  return (
    <>
    <input
      ref={ref}
      type={props.type}
      min={props.type === 'date' ? '2000-01-01' : props.min}
      max={props.type === 'date' ? '9999-12-31' : undefined}
      defaultValue={stored}
      onChange={(e) => {
        const valid = e.target.value !== '' && e.target.validity.valid
        setBad(e.target.value !== '' && !valid)
        if (valid) void props.onCommit(e.target.value)
      }}
      onBlur={(e) => {
        setBad(false)
        if (!e.target.value || !e.target.validity.valid) {
          // 仅重设 value 无法清除不完整的输入，先置空再还原
          e.target.value = ''
          e.target.value = stored
        }
      }}
    />
    {bad && props.hint && <em>{props.hint}</em>}
    </>
  )
}