import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { applyPatch, reorderSlots } from '../shared/rules'
import { remindAt } from '../shared/reminders'
import type { Priority, Remind, Todo, TodoPatch, TodoState } from '../shared/types'
import { dayKey, isValidDate, isValidTime, TRASH_MS } from '../shared/views'

const SCHEMA_VERSION = 2

/** 操作本身无效，重试也不会成功；名称会随错误传到界面。 */
export class InputError extends Error {
  override name = 'InputError'
}

/** 数据库被其他程序占用时，每次写入最多等待的毫秒数。等待会阻塞输入，因此很短；失败由界面保留并重试。 */
const BUSY_TIMEOUT = 200

export type Clock = () => number

type Row = Record<string, string | number | null>

const toTodo = (r: Row): Todo => ({
  id: r.id as string,
  title: r.title as string,
  date: r.date as string | null,
  time: r.time as string | null,
  detail: r.detail as string,
  result: r.result as string,
  priority: r.priority as Priority,
  remind: r.remind as Remind,
  sort: r.sort as number,
  createdAt: r.created_at as number,
  doneAt: r.done_at as number | null,
  deletedAt: r.deleted_at as number | null
})

function cleanTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.trim() : ''
  if (!title) throw new InputError('标题不能为空')
  return title
}

function cleanText(value: unknown): string {
  if (typeof value !== 'string') throw new InputError('文字内容无效')
  return value
}

function cleanDate(value: unknown): string | null {
  if (value === null || value === '') return null
  if (typeof value !== 'string' || !isValidDate(value)) throw new InputError('日期无效')
  return value
}

function cleanTime(value: unknown): string | null {
  if (value === null || value === '') return null
  if (typeof value !== 'string' || !isValidTime(value)) throw new InputError('时间无效')
  return value
}

function cleanPriority(value: unknown): Priority {
  if (value !== 0 && value !== 1 && value !== 2 && value !== 3) throw new InputError('优先级无效')
  return value
}

function cleanRemind(value: unknown): Remind {
  if (value !== null && value !== 0 && value !== 5 && value !== 15 && value !== 30) {
    throw new InputError('提醒方式无效')
  }
  return value
}

export class TodoStore {
  private readonly db: DatabaseSync

  constructor(
    path: string,
    private readonly now: Clock = Date.now
  ) {
    this.db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT })
    try {
      this.db.exec('PRAGMA journal_mode = WAL')
      this.migrate()
    } catch (e) {
      this.db.close()
      throw e
    }
  }

  close(): void {
    this.db.close()
  }

  state(): TodoState {
    const now = this.now()
    const rows = this.db.prepare('SELECT * FROM todos').all() as Row[]
    return { now, today: dayKey(now), todos: rows.map(toTodo) }
  }

  add(title: string, date: string | null): string {
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO todos (id, title, date, sort, created_at)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM todos), ?)`
      )
      .run(id, cleanTitle(title), cleanDate(date), this.now())
    return id
  }

  update(id: string, patch: TodoPatch): void {
    const t = this.live(id)
    // 只取允许修改的字段，并逐项校验
    const clean: TodoPatch = {}
    if (patch.title !== undefined) clean.title = cleanTitle(patch.title)
    if (patch.detail !== undefined) clean.detail = cleanText(patch.detail)
    if (patch.result !== undefined) clean.result = cleanText(patch.result)
    if (patch.priority !== undefined) clean.priority = cleanPriority(patch.priority)
    if (patch.date !== undefined) clean.date = cleanDate(patch.date)
    if (patch.time !== undefined) clean.time = cleanTime(patch.time)
    if (patch.remind !== undefined) clean.remind = cleanRemind(patch.remind)
    const n = applyPatch(t, clean, dayKey(this.now()))
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE todos SET title = ?, date = ?, time = ?, detail = ?, result = ?, priority = ?,
           remind = ? WHERE id = ?`
        )
        .run(n.title, n.date, n.time, n.detail, n.result, n.priority, n.remind, id)
      if (remindAt(n) !== remindAt(t)) this.skipPast(n)
    })
  }

  setDone(id: string, done: boolean): void {
    const t = this.live(id)
    if ((t.doneAt !== null) === done) return
    this.transaction(() => {
      this.db.prepare('UPDATE todos SET done_at = ? WHERE id = ?').run(done ? this.now() : null, id)
      if (!done) this.skipPast(t)
    })
  }

  /** 在给定待办之间重新分配它们原有的排序值，不影响其他待办。 */
  reorder(ids: string[]): void {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw new InputError('排序数据无效')
    const slots = reorderSlots(ids.map((id) => this.live(id)), ids)
    this.transaction(() => {
      const stmt = this.db.prepare('UPDATE todos SET sort = ? WHERE id = ?')
      slots.forEach((sort, id) => stmt.run(sort, id))
    })
  }

  remove(id: string): void {
    this.live(id)
    this.db.prepare('UPDATE todos SET deleted_at = ? WHERE id = ?').run(this.now(), id)
  }

  restore(id: string): void {
    const t = this.trashed(id)
    this.transaction(() => {
      this.db.prepare('UPDATE todos SET deleted_at = NULL WHERE id = ?').run(id)
      this.skipPast(t)
    })
  }

  purge(id: string): void {
    this.trashed(id)
    this.db.prepare('DELETE FROM todos WHERE id = ?').run(id)
  }

  /** 清除在回收站中满 24 小时的待办，返回清除数量。 */
  purgeExpired(): number {
    const before = this.now() - TRASH_MS
    // 没有到期项时只读不写，避免每秒争用写锁
    const due = this.db
      .prepare('SELECT 1 FROM todos WHERE deleted_at IS NOT NULL AND deleted_at <= ? LIMIT 1')
      .get(before)
    if (!due) return 0
    const result = this.db
      .prepare('DELETE FROM todos WHERE deleted_at IS NOT NULL AND deleted_at <= ?')
      .run(before)
    return Number(result.changes)
  }

  /** 取出到时未提醒的待办并记为已提醒；同一时刻的提醒只会取出一次。 */
  collectDue(): { todo: Todo; at: number }[] {
    const now = this.now()
    const rows = this.db
      .prepare(
        `SELECT * FROM todos WHERE time IS NOT NULL AND remind IS NOT NULL
         AND done_at IS NULL AND deleted_at IS NULL`
      )
      .all() as Row[]
    const due = rows.flatMap((r) => {
      const todo = toTodo(r)
      const at = remindAt(todo)
      return at !== null && at <= now && r.reminded_at !== at ? [{ todo, at }] : []
    })
    if (due.length > 0) {
      this.transaction(() => due.forEach(({ todo, at }) => this.markReminded(todo.id, at)))
    }
    return due.sort((a, b) => a.at - b.at)
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
    return row ? (row.value as string) : null
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  /** 修改或恢复后提醒时刻已过的，不再补弹。 */
  private skipPast(t: Todo): void {
    const at = remindAt(t)
    if (at !== null && at <= this.now()) this.markReminded(t.id, at)
  }

  private markReminded(id: string, at: number): void {
    this.db.prepare('UPDATE todos SET reminded_at = ? WHERE id = ?').run(at, id)
  }

  private find(id: string): Todo {
    const row = typeof id === 'string' ? this.db.prepare('SELECT * FROM todos WHERE id = ?').get(id) : undefined
    if (!row) throw new InputError('待办不存在')
    return toTodo(row as Row)
  }

  private live(id: string): Todo {
    const t = this.find(id)
    if (t.deletedAt !== null) throw new InputError('待办已在回收站中')
    return t
  }

  private trashed(id: string): Todo {
    const t = this.find(id)
    if (t.deletedAt === null) throw new InputError('待办不在回收站中')
    return t
  }

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  private migrate(): void {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number
    }
    if (version > SCHEMA_VERSION) throw new Error('数据由更新版本的软件创建，请升级软件后再打开')
    if (version < 1) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE todos (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            date TEXT,
            time TEXT,
            detail TEXT NOT NULL DEFAULT '',
            result TEXT NOT NULL DEFAULT '',
            priority INTEGER NOT NULL DEFAULT 0,
            sort INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            done_at INTEGER,
            deleted_at INTEGER
          );
          PRAGMA user_version = 1;
        `)
      })
    }
    if (version < 2) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE todos ADD COLUMN remind INTEGER DEFAULT 0;
          ALTER TABLE todos ADD COLUMN reminded_at INTEGER;
          CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          PRAGMA user_version = 2;
        `)
      })
    }
  }
}
