export type Priority = 0 | 1 | 2 | 3 // 无 / 低 / 中 / 高

/** 提前的分钟数；null 为不提醒 */
export type Remind = 0 | 5 | 15 | 30 | null

export interface Todo {
  id: string
  title: string
  /** 本地日期 YYYY-MM-DD */
  date: string | null
  /** 本地时间 HH:MM；有时间必有日期 */
  time: string | null
  /** 结束时间 HH:MM；晚于开始，同一天 */
  endTime: string | null
  detail: string
  result: string
  priority: Priority
  remind: Remind
  sort: number
  createdAt: number
  doneAt: number | null
  deletedAt: number | null
}

export type TodoPatch = Partial<
  Pick<Todo, 'title' | 'date' | 'time' | 'endTime' | 'detail' | 'result' | 'priority' | 'remind'>
>

export interface TodoState {
  now: number
  today: string
  todos: Todo[]
}

export interface MissedReminder {
  id: string
  title: string
  date: string
  time: string
}

export interface AppState extends TodoState {
  /** 程序未运行时错过的提醒，用户关闭提示前保留 */
  missed: MissedReminder[]
  float: { open: boolean; pinned: boolean }
  /** 每次恢复备份加一；变化时界面丢弃未保存的修改 */
  epoch: number
}

export interface BackupInfo {
  name: string
  kind: 'auto' | 'before-restore'
  time: number
}

export interface BackupPreview {
  /** 未删除的待办数量 */
  count: number
  time: number
}

export interface Api {
  getState(): Promise<AppState>
  add(title: string, date: string | null, time?: string | null, endTime?: string | null): Promise<AppState>
  update(id: string, patch: TodoPatch): Promise<AppState>
  setDone(id: string, done: boolean): Promise<AppState>
  reorder(ids: string[]): Promise<AppState>
  remove(id: string): Promise<AppState>
  restore(id: string): Promise<AppState>
  purge(id: string): Promise<AppState>
  dismissMissed(): Promise<AppState>
  setFloatOpen(open: boolean): Promise<AppState>
  setFloatPinned(pinned: boolean): Promise<AppState>
  /** 显示主窗口；给出 id 时定位到该待办 */
  openMain(id: string | null): Promise<AppState>
  /** 取走等待定位的待办 */
  takeFocus(): Promise<string | null>
  onFocus(listener: (id: string) => void): () => void
  listBackups(): Promise<BackupInfo[]>
  /** 返回保存的位置；取消时为 null */
  exportBackup(): Promise<string | null>
  /** name 为空时由用户选择文件；取消时为 null */
  prepareRestore(name: string | null): Promise<BackupPreview | null>
  cancelRestore(): Promise<void>
  confirmRestore(): Promise<AppState>
  openBackupFolder(): Promise<void>
  onState(listener: (state: AppState) => void): () => void
}
