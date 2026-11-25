import { beforeEach, describe, expect, it } from 'vitest'
import { Client } from '../../src/renderer/client'
import type { Api, AppState, Todo } from '../../src/shared/types'

const todo = (id: string, sort: number): Todo => ({
  id, title: id, date: null, time: null, detail: '', result: '', priority: 0, sort,
  createdAt: 0, doneAt: null, deletedAt: null
})
const base = (patch: Partial<Todo> = {}): AppState => ({
  now: 1000, today: '2030-03-10', todos: [{ ...todo('a', 1), ...patch }, todo('b', 2)]
})

// 每次调用都挂起，由测试决定何时、以什么结果返回
let calls: { resolve: (s: AppState) => void; reject: (e: Error) => void }[]
let errors: string[]
let client: Client
const call = () => new Promise<AppState>((resolve, reject) => calls.push({ resolve, reject }))

beforeEach(() => {
  calls = []
  errors = []
  const api = new Proxy({}, { get: () => call }) as Api
  client = new Client(api, (e) => errors.push(e))
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
  it('失败的操作被撤下并报告，其余未返回的操作保留', async () => {
    const bad = client.update('a', { title: '坏' })
    void client.update('a', { detail: '留' })
    calls[0].reject(new Error("Error invoking remote method 'todo:update': Error: 出错了"))
    expect(await bad).toBe(false)
    expect(errors.at(-1)).toBe('出错了')
    expect(client.find('a')).toMatchObject({ title: 'a', detail: '留' })
  })
  it('日期时间规则与主进程一致', () => {
    void client.update('a', { time: '10:00' })
    expect(client.find('a')).toMatchObject({ date: '2030-03-10', time: '10:00' })
    void client.update('a', { date: null })
    expect(client.find('a')).toMatchObject({ date: null, time: null })
  })
})
