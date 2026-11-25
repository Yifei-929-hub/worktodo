import { beforeEach, describe, expect, it } from 'vitest'
import { Client, type Notice } from '../../src/renderer/client'
import type { Api, AppState, Todo } from '../../src/shared/types'

const todo = (id: string, sort: number): Todo => ({
  id, title: id, date: null, time: null, endTime: null, detail: '', result: '', priority: 0, remind: 0, sort,
  createdAt: 0, doneAt: null, deletedAt: null
})
const base = (patch: Partial<Todo> = {}): AppState => ({
  now: 1000, today: '2030-03-10', todos: [{ ...todo('a', 1), ...patch }, todo('b', 2)],
  missed: [], float: { open: false, pinned: true }, epoch: 0
})

// 每次调用都挂起，由测试决定何时、以什么结果返回
let calls: { args: unknown[]; resolve: (s: AppState) => void; reject: (e: Error) => void }[]
let notices: (Notice | null)[]
let client: Client
const call = (...args: unknown[]) =>
  new Promise<AppState>((resolve, reject) => calls.push({ args, resolve, reject }))
const locked = () => new Error("Error invoking remote method 'x': Error: database is locked")

beforeEach(() => {
  calls = []
  notices = []
  const api = new Proxy({}, { get: () => call }) as Api
  client = new Client(api, (n) => notices.push(n))
  client.receive(base())
})

describe('界面立即更新', () => {
  it('P3 较早的保存返回不覆盖之后的输入', async () => {
    const first = client.update('a', { result: '一' })
    const second = client.update('a', { result: '一二' })
    expect(client.find('a')!.result).toBe('一二')
    calls[0].resolve(base({ result: '一' }))
    await first
    expect(client.find('a')!.result).toBe('一二')
    calls[1].resolve(base({ result: '一二' }))
    await second
    expect(client.find('a')!.result).toBe('一二')
  })
  it('主进程主动推送时保留未返回的输入', () => {
    void client.update('a', { title: '新标题' })
    client.receive({ ...base(), today: '2030-03-11' })
    expect(client.find('a')!.title).toBe('新标题')
    expect(client.getSnapshot()!.today).toBe('2030-03-11')
  })
  it('P7 勾选立即生效，可据此连续切换', () => {
    void client.setDone('a', true)
    expect(client.find('a')!.doneAt).not.toBeNull()
    void client.setDone('a', false)
    expect(client.find('a')!.doneAt).toBeNull()
  })
  it('P8 重排立即生效', () => {
    void client.reorder(['b', 'a'])
    expect([client.find('b')!.sort, client.find('a')!.sort]).toEqual([1, 2])
  })
  it('无效的操作被撤下并报告，其余未返回的操作保留', async () => {
    const bad = client.update('a', { title: '坏' })
    void client.update('a', { detail: '留' })
    calls[0].reject(new Error("Error invoking remote method 'todo:update': InputError: 出错了"))
    expect(await bad).toBe(false)
    expect(notices.at(-1)).toEqual({ text: '出错了', sticky: false })
    expect(client.find('a')).toMatchObject({ title: 'a', detail: '留' })
  })
  it('日期时间规则与主进程一致', () => {
    void client.update('a', { time: '10:00' })
    expect(client.find('a')).toMatchObject({ date: '2030-03-10', time: '10:00' })
    void client.update('a', { date: null })
    expect(client.find('a')).toMatchObject({ date: null, time: null })
  })
})

describe('P10 写入失败', () => {
  it('修改保存失败时保留文字，后续成功时一并保存', async () => {
    const first = client.update('a', { result: '一' })
    calls[0].reject(locked())
    expect(await first).toBe(false)
    expect(client.find('a')!.result).toBe('一')
    expect(client.hasUnsaved()).toBe(true)
    const second = client.update('a', { title: '新' })
    expect(calls[1].args).toEqual(['a', { result: '一', title: '新' }])
    calls[1].resolve(base({ result: '一', title: '新' }))
    await second
    expect(client.hasUnsaved()).toBe(false)
  })
  it('重试不会用旧文字覆盖正在保存的新文字', async () => {
    const first = client.update('a', { result: '一' })
    const second = client.update('a', { result: '一二' })
    calls[0].reject(locked())
    await first
    client.retryUnsaved()
    expect(calls[2].args).toEqual(['a', { result: '一二' }])
    calls[1].resolve(base({ result: '一二' }))
    await second
    expect(client.find('a')!.result).toBe('一二')
    expect(client.hasUnsaved()).toBe(false)
  })
  it('连续失败后重试保存最新文字', async () => {
    for (const text of ['一', '一二']) void client.update('a', { result: text })
    calls.forEach((c) => c.reject(locked()))
    await new Promise((r) => setTimeout(r))
    expect(client.find('a')!.result).toBe('一二')
    client.retryUnsaved()
    expect(calls[2].args).toEqual(['a', { result: '一二' }])
  })
  it('其他操作失败时撤下，提示需用户关闭', async () => {
    const done = client.setDone('a', true)
    calls[0].reject(locked())
    expect(await done).toBe(false)
    expect(client.find('a')!.doneAt).toBeNull()
    expect(notices.at(-1)).toEqual({ text: '数据文件正被其他程序占用', sticky: true })
  })
})
describe('P12 未保存的时间不恢复已清空的日期', () => {
  const start = { date: '2030-03-12', time: '09:00' }
  const cleared = { date: null, time: null, endTime: null }
  beforeEach(() => client.receive(base(start)))

  it('改时间失败后清空日期，发送和显示的都是无日期无时间', async () => {
    const first = client.update('a', { time: '10:00' })
    calls[0].reject(locked())
    await first
    const second = client.update('a', { date: null })
    expect(calls[1].args).toEqual(['a', cleared])
    expect(client.find('a')).toMatchObject(cleared)
    calls[1].resolve(base(cleared))
    await second
    expect(client.find('a')).toMatchObject(cleared)
    expect(client.hasUnsaved()).toBe(false)
  })
  it('清空日期发出后，较早的改时间才失败，也不恢复', async () => {
    const first = client.update('a', { time: '10:00' })
    const second = client.update('a', { date: null })
    calls[0].reject(locked())
    await first
    calls[1].resolve(base(cleared))
    await second
    expect(client.find('a')).toMatchObject(cleared)
    expect(client.hasUnsaved()).toBe(false)
  })
  it('两次都失败后重试，仍为清空', async () => {
    void client.update('a', { time: '10:00' })
    void client.update('a', { date: null })
    calls.forEach((c) => c.reject(locked()))
    await new Promise((r) => setTimeout(r))
    expect(client.find('a')).toMatchObject(cleared)
    client.retryUnsaved()
    expect(calls[2].args).toEqual(['a', cleared])
  })
  it('清空失败后再填时间，日期取今天', async () => {
    const first = client.update('a', { date: null })
    calls[0].reject(locked())
    await first
    void client.update('a', { time: '11:00' })
    expect(calls[1].args).toEqual(['a', { date: '2030-03-10', time: '11:00', endTime: null }])
  })
})
describe('结束时间', () => {
  beforeEach(() => client.receive(base({ date: '2030-03-12', time: '09:00', endTime: '10:30' })))

  it('改开始时间保持时长，发送最终结果', () => {
    void client.update('a', { time: '14:00' })
    expect(calls[0].args).toEqual(['a', { date: '2030-03-12', time: '14:00', endTime: '15:30' }])
    expect(client.find('a')).toMatchObject({ time: '14:00', endTime: '15:30' })
  })
  it('改开始失败后清空时间，结束时间一并清空，重试不恢复', async () => {
    void client.update('a', { time: '14:00' })
    void client.update('a', { time: null })
    calls.forEach((c) => c.reject(locked()))
    await new Promise((r) => setTimeout(r))
    expect(client.find('a')).toMatchObject({ date: '2030-03-12', time: null, endTime: null })
    client.retryUnsaved()
    expect(calls[2].args).toEqual(['a', { date: '2030-03-12', time: null, endTime: null }])
  })
})