import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Backups } from '../../src/main/backup'
import { TodoStore } from '../../src/main/store'

const DAY = 86_400_000
let dir: string
let path: string
let now: number
let store: TodoStore
let backups: Backups
const at = (d: number, h = 9, m = 0) => new Date(2030, 2, d, h, m).getTime()
const titles = () => store.state().todos.map((t) => t.title).sort()
const files = () => readdirSync(join(dir, 'backups')).sort()
const file = (name: string) => join(dir, name)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'worktodo-test-'))
  path = join(dir, 'data.db')
  now = at(10)
  store = new TodoStore(path, () => now)
  backups = new Backups(join(dir, 'backups'), () => now)
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('D1 导出与恢复', () => {
  it('恢复后与导出时一致，恢复前的数据另存一份', () => {
    const id = store.add('甲', '2030-03-11', '10:00', '11:00')
    store.update(id, { detail: '细节', result: '结果', priority: 2, remind: 15 })
    store.setSetting('floatPinned', '0')
    const before = store.state().todos
    const dest = file('out.worktodo-backup')
    backups.export(store, dest, join(dir, 'userdata'))
    store.update(id, { title: '改过', date: null })
    store.add('乙', null)
    store.setSetting('floatPinned', '1')
    expect(backups.prepare({ path: dest })).toMatchObject({ count: 1 })
    expect(titles()).toEqual(['乙', '改过']) // 确认前不变
    backups.restore(store)
    expect(store.state().todos).toEqual(before)
    expect(store.getSetting('floatPinned')).toBe('0')
    const saved = files().find((f) => f.startsWith('before-restore-'))!
    backups.prepare({ name: saved })
    backups.restore(store)
    expect(titles()).toEqual(['乙', '改过'])
    expect(files().some((f) => /tmp|part|wal|shm/.test(f))).toBe(false)
  })
  it('无效文件被拒绝，数据和原文件不变', () => {
    store.add('甲', null)
    const make = (name: string, sql: string) => {
      const db = new DatabaseSync(file(name))
      db.exec(sql)
      db.close()
    }
    writeFileSync(file('text'), '不是备份')
    writeFileSync(file('empty'), '')
    make('blank', 'CREATE TABLE x (a)')
    make('versionOnly', 'CREATE TABLE x (a); PRAGMA user_version = 5')
    make('wrongColumns', 'CREATE TABLE todos (a); INSERT INTO todos VALUES (1); PRAGMA user_version = 5')
    backups.export(store, file('good'), join(dir, 'u'))
    const good = readFileSync(file('good'))
    writeFileSync(file('truncated'), good.subarray(0, good.length - 4096))
    const broken = Buffer.from(good)
    broken.fill(0x5a, 4096, 4096 + 600)
    writeFileSync(file('broken'), broken)
    for (const [name, sql] of [
      ['badTitle', "UPDATE todos SET title = ''"],
      ['badDate', "UPDATE todos SET date = '2030-02-31'"],
      ['badEnd', "UPDATE todos SET date = '2030-03-01', time = '10:00', end_time = '09:00'"],
      ['trigger', 'CREATE TRIGGER t AFTER DELETE ON todos BEGIN SELECT 1; END']
    ]) {
      writeFileSync(file(name), good)
      make(name, sql)
    }
    for (const name of ['text', 'empty', 'blank', 'versionOnly', 'wrongColumns', 'truncated', 'broken', 'badTitle', 'badDate', 'badEnd', 'trigger', 'missing']) {
      expect(() => backups.prepare({ path: file(name) }), name).toThrow('备份文件无效')
      expect(() => backups.restore(store), name).toThrow('没有待恢复的备份')
    }
    expect(() => backups.prepare({ name: '../data.db' })).toThrow('备份文件无效')
    writeFileSync(file('newer'), good)
    make('newer', 'PRAGMA user_version = 99')
    expect(() => backups.prepare({ path: file('newer') })).toThrow('更新版本')
    expect(titles()).toEqual(['甲'])
    expect(readFileSync(file('good')).equals(good)).toBe(true)
    expect(files()).toEqual([])
  })
  it('旧版本的备份可以恢复', () => {
    const db = new DatabaseSync(file('v1'))
    db.exec(`CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, date TEXT, time TEXT,
      detail TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL DEFAULT 0,
      sort INTEGER NOT NULL, created_at INTEGER NOT NULL, done_at INTEGER, deleted_at INTEGER);
      INSERT INTO todos (id, title, sort, created_at) VALUES ('x', '旧', 1, 1); PRAGMA user_version = 1;`)
    db.close()
    const bytes = readFileSync(file('v1'))
    backups.prepare({ path: file('v1') })
    backups.restore(store)
    expect(titles()).toEqual(['旧'])
    expect(readFileSync(file('v1')).equals(bytes)).toBe(true)
  })
  it('数据库被占用时恢复失败，数据不变，之后可重试', () => {
    store.add('甲', null)
    backups.export(store, file('b'), join(dir, 'u'))
    store.add('乙', null)
    backups.prepare({ path: file('b') })
    const lock = new DatabaseSync(path)
    lock.exec('BEGIN IMMEDIATE')
    expect(() => backups.restore(store)).toThrow('locked')
    lock.exec('ROLLBACK')
    lock.close()
    expect(titles()).toEqual(['乙', '甲'])
    backups.restore(store)
    expect(titles()).toEqual(['甲'])
  })
  it('取消后不能恢复；不能导出到数据目录；导出失败不破坏原有文件', () => {
    backups.export(store, file('b'), join(dir, 'u'))
    backups.prepare({ path: file('b') })
    backups.cancel()
    expect(() => backups.restore(store)).toThrow('没有待恢复')
    expect(() => backups.export(store, join(dir, 'u', 'x'), join(dir, 'u'))).toThrow('数据目录')
    const old = readFileSync(file('b'))
    expect(() => backups.export(store, join(dir, 'none', 'b'), join(dir, 'u'))).toThrow()
    expect(readFileSync(file('b')).equals(old)).toBe(true)
  })
  it('恢复后过时刻的提醒不补弹，将来的照常，已弹过的不重弹', () => {
    const a = store.add('过点', '2030-03-10', '10:00')
    store.add('将来', '2030-03-10', '15:00')
    const c = store.add('来不及提前', '2030-03-10', '12:10')
    store.update(c, { remind: 30 })
    backups.export(store, file('b'), join(dir, 'u'))
    store.remove(a)
    now = at(10, 12)
    backups.prepare({ path: file('b') })
    backups.restore(store)
    expect(store.collectDue()).toEqual([])
    now = at(10, 12, 10)
    expect(store.collectDue().map((d) => d.todo.title)).toEqual(['来不及提前'])
    now = at(10, 15)
    expect(store.collectDue().map((d) => d.todo.title)).toEqual(['将来'])
  })
})

describe('D2 自动备份', () => {
  it('每天一份，只留最近 7 份，不动其他文件', () => {
    store.add('甲', null)
    writeFileSync(join(dir, 'backups', '用户文件.txt'), 'x')
    for (let i = 0; i < 10; i++) {
      expect(backups.auto(path)).toBe(true)
      expect(backups.auto(path)).toBe(false)
      now += DAY
    }
    const auto = files().filter((f) => f.startsWith('auto-'))
    expect(auto).toHaveLength(7)
    expect(auto[0]).toBe('auto-2030-03-13.worktodo-backup')
    expect(auto[6]).toBe('auto-2030-03-19.worktodo-backup')
    expect(existsSync(join(dir, 'backups', '用户文件.txt'))).toBe(true)
    expect(backups.list()).toHaveLength(7)
  })
  it('内容是当时的数据，可恢复', () => {
    store.add('甲', null)
    backups.auto(path)
    store.add('乙', null)
    backups.prepare({ name: 'auto-2030-03-10.worktodo-backup' })
    backups.restore(store)
    expect(titles()).toEqual(['甲'])
  })
  it('还没有数据文件时不备份', () => {
    expect(backups.auto(join(dir, 'none.db'))).toBe(false)
    expect(existsSync(join(dir, 'none.db'))).toBe(false)
  })
})
