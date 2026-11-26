import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defaultItems, formatLog, fromTodo } from '../shared/log'
import type { LogItem, SavedLog, Todo } from '../shared/types'
import { compareTodos } from '../shared/views'
import { parseError } from './client'
import { formatDay } from './format'

const api = window.worktodo

interface Row extends LogItem {
  key: number
  include: boolean
}

let nextKey = 1
const toRows = (items: LogItem[]): Row[] => items.map((i) => ({ ...i, key: nextKey++, include: true }))
/** 未保存的编辑按日期暂存，切换页面后回来仍在（程序关闭后不保留） */
const drafts = new Map<string, Row[]>()
let draftEpoch = 0

/** 有未保存修改的日期 */
export const logDraftDates = (): string[] => [...drafts.keys()].sort()
/** 上次查看的日期，回到日志页时接着看 */
let lastDate: string | null = null

/** date：从“生成今日日志”进入时指定的日期 */
export function LogView(props: { todos: Todo[]; today: string; date: string | null; epoch: number }) {
  const { todos, today, epoch } = props
  if (epoch !== draftEpoch) {
    // 恢复备份后，之前的编辑不再适用
    drafts.clear()
    draftEpoch = epoch
  }
  const [date, setDate] = useState(props.date ?? lastDate ?? today)
  lastDate = date
  const [list, setList] = useState<{ date: string; savedAt: number }[]>([])
  const [saved, setSaved] = useState<SavedLog | null>(null)
  const [rows, setRowsState] = useState<Row[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState('')
  const [asking, setAsking] = useState(false)
  const [pick, setPick] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)

  const setRows = useCallback(
    (next: Row[] | null) => {
      setRowsState(next)
      if (next) drafts.set(date, next)
      else drafts.delete(date)
    },
    [date]
  )

  const report = (e: unknown): void => setFailed(parseError(e).text)

  const load = useCallback(async () => {
    setLoading(true)
    setMessage('')
    setFailed('')
    try {
      const [all, log] = await Promise.all([api.listLogs(), api.getLog(date)])
      setList(all)
      setSaved(log)
      // 有暂存的编辑先接着编辑；没保存过的直接生成预览
      setRowsState(drafts.get(date) ?? (log ? null : toRows(defaultItems(todos, date))))
    } catch (e) {
      report(e)
    } finally {
      setLoading(false)
    }
    // 只在换日期或恢复备份时重新读取，待办的变化不改动已生成的预览
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, epoch])
  useEffect(() => void load(), [load])
  useEffect(() => {
    if (props.date) setDate(props.date)
  }, [props.date])
  useEffect(() => {
    if (asking) dialog.current?.showModal()
    else dialog.current?.close()
  }, [asking])

  const included = (rows ?? []).filter((r) => r.include)
  const items = (list: LogItem[]): LogItem[] => list.map(({ todoId, title, detail }) => ({ todoId, title, detail }))
  const text = rows ? formatLog(date, items(included)) : saved ? formatLog(date, saved.items) : ''

  const candidates = useMemo(() => {
    const used = new Set((rows ?? []).map((r) => r.todoId))
    return todos
      .filter((t) => t.deletedAt === null && t.doneAt === null && !used.has(t.id) && (t.date === null || t.date <= date))
      .sort(compareTodos)
  }, [todos, rows, date])

  const update = (key: number, patch: Partial<Row>): void =>
    setRows(rows!.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const move = (index: number, by: number): void => {
    const next = [...rows!]
    const [row] = next.splice(index, 1)
    next.splice(index + by, 0, row)
    setRows(next)
  }

  const copy = async (): Promise<void> => {
    try {
      await api.copyText(text)
      setMessage('已复制，可直接粘贴发送。')
    } catch (e) {
      report(e)
    }
  }
  const save = async (): Promise<void> => {
    setFailed('')
    try {
      const log = await api.saveLog(date, items(included))
      setSaved(log)
      setRows(null)
      setList(await api.listLogs())
      setMessage('已保存。')
    } catch (e) {
      report(e)
    }
  }

  return (
    <div className="logs">
      <aside className="log-list" aria-label="已保存的日志">
        <label className="field">
          <span>日期</span>
          <input
            type="date"
            value={date}
            max={today}
            onChange={(e) => e.target.value && e.target.value <= today && setDate(e.target.value)}
          />
        </label>
        <button className="plain" disabled={date === today} onClick={() => setDate(today)}>
          回到今天
        </button>
        <h2 className="group-title">已保存</h2>
        {list.length === 0 && <p className="hint">还没有保存过日志。</p>}
        <ul>
          {list.map((l) => (
            <li key={l.date}>
              <button className="nav-item" aria-current={l.date === date ? 'page' : undefined} onClick={() => setDate(l.date)}>
                {formatDay(l.date, today)}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="log-main" aria-label={`${formatDay(date, today)}的日志`}>
        {loading ? (
          <p className="hint">正在读取…</p>
        ) : rows ? (
          <>
            <p className="hint">
              {saved ? '正在修改已保存的日志，保存后覆盖。' : '默认列出当天勾选完成的待办。'}
              可取消勾选、调整顺序和修改文字。
            </p>
            {rows.length === 0 && <p className="empty">当天没有完成的待办，可从下方加入或临时补一条。</p>}
            <ol className="log-rows">
              {rows.map((r, i) => (
                <li key={r.key} className={`log-row ${r.include ? '' : 'is-off'}`} data-log={r.title}>
                  <input
                    type="checkbox"
                    aria-label={`写入：${r.title || '新条目'}`}
                    checked={r.include}
                    onChange={() => update(r.key, { include: !r.include })}
                  />
                  <div className="log-fields">
                    <input
                      aria-label="条目标题"
                      placeholder="简短标题"
                      value={r.title}
                      onChange={(e) => update(r.key, { title: e.target.value })}
                    />
                    <textarea
                      aria-label="条目详情"
                      placeholder="简短工作详情（选填）"
                      rows={2}
                      value={r.detail}
                      onChange={(e) => update(r.key, { detail: e.target.value })}
                    />
                  </div>
                  <div className="log-actions">
                    <button className="plain" aria-label="上移" disabled={i === 0} onClick={() => move(i, -1)}>
                      ↑
                    </button>
                    <button className="plain" aria-label="下移" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
                      ↓
                    </button>
                    {r.todoId === null && (
                      <button className="plain warn" onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>
                        移除
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ol>
            <div className="log-add">
              <select aria-label="加入未完成的待办" value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">加入未完成或忘记勾选的待办…</option>
                {candidates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                    {t.date ? `（${formatDay(t.date, today)}）` : ''}
                  </option>
                ))}
              </select>
              <button
                className="plain"
                disabled={!pick}
                onClick={() => {
                  const t = todos.find((x) => x.id === pick)
                  if (t) setRows([...rows, ...toRows([fromTodo(t)])])
                  setPick('')
                }}
              >
                加入
              </button>
              <button className="plain" onClick={() => setRows([...rows, ...toRows([{ todoId: null, title: '', detail: '' }])])}>
                临时补一条
              </button>
            </div>
            <Preview text={text} />
            <div className="log-buttons">
              <button className="primary" onClick={() => void save()}>
                保存
              </button>
              <button className="plain" onClick={() => void copy()}>
                复制
              </button>
              {(saved || drafts.has(date)) && (
                <button
                  className="plain"
                  onClick={() => {
                    // 没保存过的回到默认生成的内容
                    setRows(null)
                    if (!saved) setRowsState(toRows(defaultItems(todos, date)))
                  }}
                >
                  放弃修改
                </button>
              )}
            </div>
          </>
        ) : saved ? (
          <>
            <p className="hint">已保存。之后待办的变化不会改动这份日志。</p>
            <Preview text={text} />
            <div className="log-buttons">
              <button className="primary" onClick={() => void copy()}>
                复制
              </button>
              <button className="plain" onClick={() => setRows(toRows(saved.items))}>
                修改
              </button>
              <button className="plain" onClick={() => setAsking(true)}>
                重新生成
              </button>
            </div>
          </>
        ) : null}
        {message && <p role="status">{message}</p>}
        {failed && (
          <p className="warn" role="alert">
            {failed}
          </p>
        )}
      </section>

      <dialog ref={dialog} onClose={() => setAsking(false)} aria-label="确认重新生成">
        <p>按当天完成的待办重新生成，保存后会覆盖已保存的日志。继续吗？</p>
        <div className="dialog-actions">
          <button className="plain" autoFocus onClick={() => setAsking(false)}>
            取消
          </button>
          <button
            className="danger"
            onClick={() => {
              setRows(toRows(defaultItems(todos, date)))
              setAsking(false)
            }}
          >
            重新生成
          </button>
        </div>
      </dialog>
    </div>
  )
}

function Preview(props: { text: string }) {
  return (
    <figure className="log-preview">
      <figcaption className="group-title">预览</figcaption>
      <pre aria-label="日志预览">{props.text}</pre>
    </figure>
  )
}
