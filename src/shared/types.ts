export type Priority = 0 | 1 | 2 | 3 // 无 / 低 / 中 / 高

export interface Todo {
  id: string
  title: string
  /** 本地日期 YYYY-MM-DD */
  date: string | null
  /** 本地时间 HH:MM；有时间必有日期 */
  time: string | null
  detail: string
  result: string
  priority: Priority
  sort: number
  createdAt: number
  doneAt: number | null
  deletedAt: number | null
}

export type TodoPatch = Partial<
  Pick<Todo, 'title' | 'date' | 'time' | 'detail' | 'result' | 'priority'>
>

export interface AppState {
  now: number
  today: string
  todos: Todo[]
}

export interface Api {
  getState(): Promise<AppState>
  add(title: string, date: string | null): Promise<AppState>
  update(id: string, patch: TodoPatch): Promise<AppState>
  setDone(id: string, done: boolean): Promise<AppState>
  reorder(ids: string[]): Promise<AppState>
  remove(id: string): Promise<AppState>
  restore(id: string): Promise<AppState>
  purge(id: string): Promise<AppState>
  onState(listener: (state: AppState) => void): () => void
}
