import { copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readSync, closeSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BackupInfo, BackupPreview } from '../shared/types'
import { dayKey } from '../shared/views'
import { InputError, SCHEMA_VERSION, TodoStore, type Clock } from './store'

export const BACKUP_EXT = 'worktodo-backup'
const KEEP = 7
const NAME = /^(auto-\d{4}-\d{2}-\d{2}|before-restore-\d{8}-\d{6})\.worktodo-backup$/
const pad = (n: number): string => String(n).padStart(2, '0')

/** 本地时间 YYYYMMDD-HHMMSS */
export function stamp(ms: number): string {
  const d = new Date(ms)
  return `${dayKey(ms).replaceAll('-', '')}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function removeDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true })
}

/** 先写到临时文件再改名，不留下写了一半的备份，也不破坏原有文件。 */
function writeBackup(dest: string, write: (temp: string) => void): void {
  const temp = `${dest}.part`
  removeDb(temp)
  try {
    write(temp)
    try {
      renameSync(temp, dest)
    } catch (e) {
      // 个别环境会重定向数据目录，同目录改名也报跨设备，改为复制
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
      copyFileSync(temp, dest)
      removeDb(temp)
    }
  } catch (e) {
    removeDb(temp)
    throw e
  }
}

function isSqlite(path: string): boolean {
  const head = Buffer.alloc(16)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, head, 0, 16, 0)
  } finally {
    closeSync(fd)
  }
  return head.toString('latin1') === 'SQLite format 3\0'
}

/** 检查一份数据文件是否可恢复；不修改它。 */
function checkFile(path: string): void {
  if (!isSqlite(path)) throw new InputError('备份文件无效')
  const db = new DatabaseSync(path)
  try {
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (version > SCHEMA_VERSION) throw new InputError('备份由更新版本的软件创建，请升级软件后再恢复')
    const items = db.prepare('SELECT type, name FROM sqlite_master').all() as { type: string; name: string }[]
    const ok =
      version >= 1 &&
      items.some((i) => i.type === 'table' && i.name === 'todos') &&
      !items.some((i) => i.type === 'trigger' || i.type === 'view')
    const { integrity_check: integrity } = db.prepare('PRAGMA integrity_check').get() as {
      integrity_check: string
    }
    if (!ok || integrity !== 'ok') throw new InputError('备份文件无效')
  } finally {
    db.close()
  }
}

export class Backups {
  private readonly temp: string
  private pending = false

  constructor(
    readonly dir: string,
    private readonly now: Clock
  ) {
    mkdirSync(dir, { recursive: true })
    this.temp = join(dir, 'restoring.tmp')
    removeDb(this.temp)
  }

  /** 当天还没有自动备份时备份一份，并删除较旧的；返回是否新建。 */
  auto(dbPath: string): boolean {
    const dest = join(this.dir, `auto-${dayKey(this.now())}.${BACKUP_EXT}`)
    if (existsSync(dest) || !existsSync(dbPath)) return false
    writeBackup(dest, (temp) => {
      const db = new DatabaseSync(dbPath, { timeout: 200 })
      try {
        db.prepare('VACUUM INTO ?').run(temp)
      } finally {
        db.close()
      }
    })
    this.prune('auto-')
    return true
  }

  list(): BackupInfo[] {
    return readdirSync(this.dir)
      .filter((name) => NAME.test(name))
      .map((name): BackupInfo => {
        const s = statSync(join(this.dir, name))
        return { name, kind: name.startsWith('auto-') ? 'auto' : 'before-restore', time: s.mtimeMs }
      })
      .sort((a, b) => b.time - a.time || (a.name < b.name ? 1 : -1))
  }

  /** 导出到用户选择的位置；不允许放进数据目录，以免卸载时被一并删除。 */
  export(store: TodoStore, dest: string, dataRoot: string): void {
    const rel = relative(dataRoot, dest)
    if (!rel.startsWith('..') && !isAbsolute(rel)) {
      throw new InputError('请保存到软件数据目录以外的位置，卸载时数据目录可能被删除')
    }
    writeBackup(dest, (temp) => store.exportTo(temp))
  }

  /** 把要恢复的文件复制一份并校验，之后的恢复只用这份副本。 */
  prepare(source: { name: string } | { path: string }): BackupPreview {
    this.cancel()
    let path: string
    if ('name' in source) {
      if (!NAME.test(source.name)) throw new InputError('备份文件无效')
      path = join(this.dir, source.name)
    } else path = source.path
    try {
      const time = statSync(path).mtimeMs
      copyFileSync(path, this.temp)
      checkFile(this.temp)
      const copy = new TodoStore(this.temp, this.now)
      try {
        try {
          copy.assertValid()
        } catch (e) {
          console.warn('备份内容校验失败', e)
          throw new InputError('备份文件无效')
        }
        this.pending = true
        return { count: copy.state().todos.filter((t) => t.deletedAt === null).length, time }
      } finally {
        copy.close()
      }
    } catch (e) {
      this.cancel()
      if (e instanceof InputError) throw e
      console.warn('备份文件校验失败', e)
      throw new InputError('备份文件无效')
    }
  }

  cancel(): void {
    this.pending = false
    removeDb(this.temp)
  }

  /** 先保存一份当前数据，再整体替换；任何一步失败都不改动当前数据。 */
  restore(store: TodoStore): void {
    if (!this.pending) throw new InputError('没有待恢复的备份')
    const dest = join(this.dir, `before-restore-${stamp(this.now())}.${BACKUP_EXT}`)
    writeBackup(dest, (temp) => store.exportTo(temp))
    store.replaceFrom(this.temp)
    this.cancel()
    this.prune('before-restore-')
  }

  private prune(prefix: string): void {
    const names = readdirSync(this.dir).filter((n) => NAME.test(n) && n.startsWith(prefix))
    for (const name of names.sort().slice(0, -KEEP)) rmSync(join(this.dir, name), { force: true })
  }
}
