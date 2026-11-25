import { applyPatch, reorderSlots } from '../shared/rules'
import type { Api, AppState, Todo, TodoPatch } from '../shared/types'

type Apply = (state: AppState) => AppState

const mapTodo = (state: AppState, id: string, fn: (t: Todo) => Todo): AppState => ({
  ...state,
  todos: state.todos.map((t) => (t.id === id ? fn(t) : t))
})

const RETRY_MS = 3000

type Field = keyof TodoPatch
/** 保存失败、等待重试的字段；seq 为写入该值的操作序号。 */
type Unsaved = Map<string, Map<Field, { value: unknown; seq: number }>>

interface Failure {
  text: string
  /** 操作本身无效，重试无用 */
  invalid: boolean
}

export function parseError(e: unknown): Failure {
  const raw = e instanceof Error ? e.message : String(e)
  const text = raw.replace(/^Error invoking remote method '[^']*': (?:(\w*Error): )?/, '')
  const invalid = /^Error invoking remote method '[^']*': InputError: /.test(raw)
  return { text: /locked|busy/i.test(text) ? '数据文件正被其他程序占用' : text, invalid }
}

/** sticky 的提示不会被之后成功的操作清掉，由用户关闭。 */
export interface Notice {
  text: string
  sticky: boolean
}

/**
 * 界面数据：显示内容 = 主进程最新状态 + 未能保存的修改 + 尚未返回的操作。
 * 操作立即反映到界面，较早的返回不会覆盖之后的输入。
 * 修改保存失败时保留文字并自动重试；其他操作失败时撤下并报告。
 */
export class Client {
  private server: AppState | null = null
  private pending: { apply: Apply }[] = []
  private unsaved: Unsaved = new Map()
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private seq = 0
  private snapshot: AppState | null = null
  private listeners = new Set<() => void>()

  constructor(
    private readonly api: Api,
    private readonly onNotice: (notice: Notice | null) => void
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): AppState | null => this.snapshot

  hasUnsaved = (): boolean => this.unsaved.size > 0

  find(id: string): Todo | undefined {
    return this.snapshot?.todos.find((t) => t.id === id)
  }

  receive = (state: AppState): void => {
    this.accept(state)
    this.refresh()
  }

  /** 恢复备份后，恢复前未保存的修改不再适用。 */
  private accept(state: AppState): void {
    if (this.server && state.epoch !== this.server.epoch) this.unsaved.clear()
    this.server = state
  }

  load(): Promise<boolean> {
    return this.run((s) => s, () => this.api.getState())
  }

  add(
    title: string,
    date: string | null,
    time: string | null = null,
    endTime: string | null = null
  ): Promise<boolean> {
    return this.run(
      (s) => s,
      () => this.api.add(title, date, time, endTime),
      (e) => ({ ...e, text: e.invalid ? e.text : `未能添加“${title}”：${e.text}` })
    )
  }

  /** 连同该项之前未能保存的字段一起保存。 */
  async update(id: string, patch: TodoPatch): Promise<boolean> {
    const full = this.fullPatch(id, patch)
    const seq = ++this.seq
    const fields = Object.entries(full) as [Field, unknown][]
    return this.run(
      (s) => mapTodo(s, id, (t) => applyPatch(t, full, s.today)),
      () => this.api.update(id, full),
      (e) => {
        if (e.invalid) {
          this.forget(id, fields, seq)
          return e
        }
        const kept = this.unsaved.get(id) ?? new Map()
        for (const [field, value] of fields) {
          if ((kept.get(field)?.seq ?? 0) < seq) kept.set(field, { value, seq })
        }
        this.unsaved.set(id, kept)
        this.scheduleRetry()
        return null // 由“未保存”提示说明
      },
      () => this.forget(id, fields, seq)
    )
  }

  /** 重新保存所有未能保存的修改。 */
  retryUnsaved = (): void => {
    for (const id of [...this.unsaved.keys()]) void this.update(id, {})
  }

  setDone(id: string, done: boolean): Promise<boolean> {
    return this.run(
      (s) => mapTodo(s, id, (t) => ({ ...t, doneAt: done ? (t.doneAt ?? s.now) : null })),
      () => this.api.setDone(id, done)
    )
  }

  reorder(ids: string[]): Promise<boolean> {
    return this.run(
      (s) => {
        const slots = reorderSlots(s.todos, ids)
        return { ...s, todos: s.todos.map((t) => ({ ...t, sort: slots.get(t.id) ?? t.sort })) }
      },
      () => this.api.reorder(ids)
    )
  }

  remove(id: string): Promise<boolean> {
    return this.run(
      (s) => mapTodo(s, id, (t) => ({ ...t, deletedAt: s.now })),
      () => this.api.remove(id)
    )
  }

  restore(id: string): Promise<boolean> {
    return this.run(
      (s) => mapTodo(s, id, (t) => ({ ...t, deletedAt: null })),
      () => this.api.restore(id)
    )
  }

  purge(id: string): Promise<boolean> {
    return this.run(
      (s) => ({ ...s, todos: s.todos.filter((t) => t.id !== id) }),
      () => this.api.purge(id)
    )
  }

  dismissMissed(): Promise<boolean> {
    return this.run((s) => ({ ...s, missed: [] }), () => this.api.dismissMissed())
  }

  restoreBackup(): Promise<boolean> {
    return this.run((s) => s, () => this.api.confirmRestore())
  }

  setFloatOpen(open: boolean): Promise<boolean> {
    return this.run((s) => ({ ...s, float: { ...s.float, open } }), () => this.api.setFloatOpen(open))
  }

  setFloatPinned(pinned: boolean): Promise<boolean> {
    return this.run((s) => ({ ...s, float: { ...s.float, pinned } }), () => this.api.setFloatPinned(pinned))
  }

  private async run(
    apply: Apply,
    call: () => Promise<AppState>,
    onFail: (e: Failure) => Failure | null = (e) => e,
    onDone: () => void = () => {}
  ): Promise<boolean> {
    const op = { apply }
    this.pending.push(op)
    const result = call()
    this.refresh()
    try {
      this.accept(await result)
      onDone()
      this.onNotice(null)
      return true
    } catch (e) {
      const failure = onFail(parseError(e))
      if (failure) this.onNotice({ text: failure.text, sticky: !failure.invalid })
      return false
    } finally {
      this.pending = this.pending.filter((p) => p !== op)
      this.refresh()
    }
  }

  /**
   * 本次修改加上未保存的字段，都取修改后应显示的值：
   * 未保存的字段可能有更新的输入正在保存，不能用旧值覆盖；
   * 日期、开始和结束时间互相影响，涉及其一就一并发送最终结果，不让旧时间恢复已清空的日期。
   */
  private fullPatch(id: string, patch: TodoPatch): TodoPatch {
    const todo = this.find(id)
    if (!todo || !this.snapshot) return patch
    const target = applyPatch(todo, patch, this.snapshot.today)
    const fields = new Set<Field>([
      ...(this.unsaved.get(id)?.keys() ?? []),
      ...(Object.keys(patch) as Field[])
    ])
    const moment: Field[] = ['date', 'time', 'endTime']
    if (moment.some((f) => fields.has(f))) moment.forEach((f) => fields.add(f))
    return Object.fromEntries([...fields].map((field) => [field, target[field]])) as TodoPatch
  }
  private unsavedPatch(id: string): TodoPatch {
    const fields = [...(this.unsaved.get(id) ?? [])].map(([field, { value }]) => [field, value])
    return Object.fromEntries(fields) as TodoPatch
  }

  /** 去掉不晚于 seq 的未保存字段；之后的输入不受影响。 */
  private forget(id: string, fields: [Field, unknown][], seq: number): void {
    const kept = this.unsaved.get(id)
    if (!kept) return
    for (const [field] of fields) if ((kept.get(field)?.seq ?? Infinity) <= seq) kept.delete(field)
    if (kept.size === 0) this.unsaved.delete(id)
  }

  private scheduleRetry(): void {
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(this.retryUnsaved, RETRY_MS)
  }

  private refresh(): void {
    if (this.server) {
      let state = this.server
      for (const id of this.unsaved.keys()) {
        state = mapTodo(state, id, (t) => applyPatch(t, this.unsavedPatch(id), state.today))
      }
      this.snapshot = this.pending.reduce((s, p) => p.apply(s), { ...state })
    }
    this.listeners.forEach((l) => l())
  }
}