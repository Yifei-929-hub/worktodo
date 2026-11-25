import { applyPatch, reorderSlots } from '../shared/rules'
import type { Api, AppState, Todo, TodoPatch } from '../shared/types'

type Apply = (state: AppState) => AppState

const mapTodo = (state: AppState, id: string, fn: (t: Todo) => Todo): AppState => ({
  ...state,
  todos: state.todos.map((t) => (t.id === id ? fn(t) : t))
})

function errorText(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e)
  return text.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
}

/**
 * 界面数据：显示内容 = 主进程最新状态 + 尚未返回的操作。
 * 操作立即反映到界面；较早的返回不会覆盖之后的输入；失败的操作被撤下并报告。
 */
export class Client {
  private server: AppState | null = null
  private pending: { apply: Apply }[] = []
  private snapshot: AppState | null = null
  private listeners = new Set<() => void>()

  constructor(
    private readonly api: Api,
    private readonly onError: (text: string) => void
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): AppState | null => this.snapshot

  find(id: string): Todo | undefined {
    return this.snapshot?.todos.find((t) => t.id === id)
  }

  receive = (state: AppState): void => {
    this.server = state
    this.refresh()
  }

  load(): Promise<boolean> {
    return this.run((s) => s, () => this.api.getState())
  }

  add(title: string, date: string | null): Promise<boolean> {
    return this.run((s) => s, () => this.api.add(title, date))
  }

  update(id: string, patch: TodoPatch): Promise<boolean> {
    return this.run(
      (s) => mapTodo(s, id, (t) => applyPatch(t, patch, s.today)),
      () => this.api.update(id, patch)
    )
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

  private async run(apply: Apply, call: () => Promise<AppState>): Promise<boolean> {
    const op = { apply }
    this.pending.push(op)
    const result = call()
    this.refresh()
    try {
      this.server = await result
      this.onError('')
      return true
    } catch (e) {
      this.onError(errorText(e))
      return false
    } finally {
      this.pending = this.pending.filter((p) => p !== op)
      this.refresh()
    }
  }

  private refresh(): void {
    this.snapshot = this.server && this.pending.reduce((s, p) => p.apply(s), this.server)
    this.listeners.forEach((l) => l())
  }
}
