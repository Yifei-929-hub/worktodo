import { app, Notification } from 'electron'

interface Sent {
  title: string
  body: string
  click: () => void
}

// 测试时只记录、不弹出；对安装后的程序无效
const recorded: Sent[] | null = !app.isPackaged && process.env.WORKTODO_TEST_NOTIFY ? [] : null
if (recorded) (globalThis as Record<string, unknown>).testNotifications = recorded

// 保留引用，避免通知在点击前被回收
const active = new Set<Notification>()

export function notify(title: string, body: string, click: () => void): void {
  if (recorded) {
    recorded.push({ title, body, click })
    return
  }
  const n = new Notification({ title, body })
  active.add(n)
  n.on('click', () => {
    active.delete(n)
    click()
  })
  n.on('failed', (_event, error) => {
    active.delete(n)
    console.warn('通知未能显示', error)
  })
  n.show()
}
