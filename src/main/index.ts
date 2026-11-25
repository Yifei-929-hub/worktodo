import { app, BrowserWindow, dialog, ipcMain, Menu, session } from 'electron'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppState, TodoPatch } from '../shared/types'
import { dayKey } from '../shared/views'
import { TodoStore, type Clock } from './store'

// 开发和测试数据与正式用户数据分开；以下环境变量对安装后的程序无效。
if (!app.isPackaged) {
  app.setPath('userData', process.env.WORKTODO_USER_DATA ?? join(app.getAppPath(), 'user-data'))
}
const devUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
const clockFile = app.isPackaged ? undefined : process.env.WORKTODO_TEST_CLOCK

/** 测试时从文件读取相对真实时间的偏移毫秒数。 */
const clock: Clock = () => {
  if (!clockFile) return Date.now()
  try {
    return Date.now() + (Number(readFileSync(clockFile, 'utf8')) || 0)
  } catch {
    return Date.now()
  }
}

let win: BrowserWindow | null = null
let store: TodoStore

function broadcast(): void {
  win?.webContents.send('state', store.state())
}

function registerIpc(): void {
  const handle = (channel: string, action: (...args: never[]) => void): void => {
    ipcMain.handle(channel, (event, ...args): AppState => {
      if (!win || event.senderFrame !== win.webContents.mainFrame) throw new Error('来源无效')
      action(...(args as never[]))
      return store.state()
    })
  }
  handle('state:get', () => {})
  handle('todo:add', (title: string, date: string | null) => void store.add(title, date))
  handle('todo:update', (id: string, patch: TodoPatch) => store.update(id, patch))
  handle('todo:done', (id: string, done: boolean) => store.setDone(id, done))
  handle('todo:reorder', (ids: string[]) => store.reorder(ids))
  handle('todo:remove', (id: string) => store.remove(id))
  handle('todo:restore', (id: string) => store.restore(id))
  handle('todo:purge', (id: string) => store.purge(id))
}

/** 每秒检查跨日和回收站到期，变化时通知界面。 */
function startTicker(): void {
  let day = dayKey(clock())
  setInterval(() => {
    const today = dayKey(clock())
    const purged = store.purgeExpired()
    if (today !== day || purged > 0) {
      day = today
      broadcast()
    }
  }, 1000)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'WorkTodo',
    backgroundColor: '#f6f5f1',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => (win = null))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  app.on('window-all-closed', () => app.quit())
  app.on('will-quit', () => store?.close())

  void app.whenReady().then(() => {
    try {
      const dir = join(app.getPath('userData'), 'data')
      mkdirSync(dir, { recursive: true })
      store = new TodoStore(join(dir, 'worktodo.db'), clock)
    } catch (e) {
      dialog.showErrorBox('无法打开数据', e instanceof Error ? e.message : String(e))
      app.exit(1)
      return
    }
    Menu.setApplicationMenu(null)
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    // 运行时不发起外部网络请求（开发服务器除外）
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const local = /^(file|devtools|data|blob):/.test(details.url)
      const dev = devUrl !== undefined && new URL(details.url).host === new URL(devUrl).host
      callback({ cancel: !local && !dev })
    })
    store.purgeExpired()
    registerIpc()
    startTicker()
    createWindow()
  })
}
