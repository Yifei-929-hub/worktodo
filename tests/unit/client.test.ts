import { beforeEach, describe, expect, it } from 'vitest'
import { Client, type Notice } from '../../src/renderer/client'
import type { Api, AppState, Todo } from '../../src/shared/types'

const todo = (id: string, sort: number): Todo => ({
  id, title: id, date: null, time: null, detail: '', result: '', priority: 0, sort,
  createdAt: 0, doneAt: null, deletedAt: null
})
const base = (patch: Partial<Todo> = {}): AppState => ({
  now: 1000, today: '2030-03-10', todos: [{ ...todo('a', 1), ...patch }, todo('b', 2)]
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