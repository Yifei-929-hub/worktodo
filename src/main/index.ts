import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, session, Tray } from 'electron'
import type { Rectangle } from 'electron'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import icon256 from '../../resources/icon-256.png?asset'
import icon32 from '../../resources/icon-32.png?asset'
import type { AppState, MissedReminder, TodoPatch } from '../shared/types'
import { dayKey } from '../shared/views'
import { notify } from './notify'
import { TodoStore, type Clock } from './store'

const APP_NAME = 'WorkTodo'
const FLOAT_SIZE = { width: 300, height: 420 }
/** 迟到超过这一时长的提醒（例如休眠唤醒后）合并成一条 */
const LATE_MS = 60_000

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
let floatWin: BrowserWindow | null = null
let tray: Tray | null = null
let store: TodoStore
let ticker: NodeJS.Timeout | undefined
let quitting = false
let missed: MissedReminder[] = []
let pendingFocus: string | null = null

const floatSettings = (): AppState['float'] => ({
  open: store.getSetting('floatOpen') === '1',
  pinned: store.getSetting('floatPinned') !== '0'
})

const state = (): AppState => ({ ...store.state(), missed, float: floatSettings() })

function broadcast(except?: Electron.WebContents): void {
  const s = state()
  for (const w of [win, floatWin]) {
    if (w && w.webContents !== except) w.webContents.send('state', s)
  }
}

function warn(text: string, action: () => void): void {
  try {
    action()
  } catch (e) {
    console.warn(text, e)
  }
}

// ---- 窗口 ----

function newWindow(options: Electron.BrowserWindowConstructorOptions, hash: string): BrowserWindow {
  const w = new BrowserWindow({
    ...options,
    show: false,
    title: APP_NAME,
    icon: icon256,
    backgroundColor: '#f6f5f1',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('will-navigate', (event) => event.preventDefault())
  // 关机或注销时不拦截关闭
  w.on('query-session-end', () => (quitting = true))
  if (devUrl) void w.loadURL(`${devUrl}#${hash}`)
  else void w.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  return w
}

function createMain(): void {
  win = newWindow({ width: 1120, height: 740, minWidth: 760, minHeight: 520 }, 'main')
  win.once('ready-to-show', () => win?.show())
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    win?.hide()
    warn('托盘提示失败', () => {
      if (store.getSetting('trayHintShown')) return
      store.setSetting('trayHintShown', '1')
      notify(`${APP_NAME} 仍在运行`, '已收到系统托盘，会继续提醒。要退出请用托盘菜单。', () => showMain(null))
    })
  })
  win.on('closed', () => (win = null))
}

function showMain(focusId: string | null): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  if (focusId) {
    pendingFocus = focusId
    win.webContents.send('focus')
  }
}

/** 恢复上次的位置；上次的位置已不在任何屏幕内时放到主屏右下角。 */
function floatBounds(): Rectangle {
  try {
    const b = JSON.parse(store.getSetting('floatBounds') ?? '') as Rectangle
    const visible = screen.getAllDisplays().some(({ workArea: a }) => {
      const overlap = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x)
      return overlap >= 80 && b.y >= a.y - 5 && b.y <= a.y + a.height - 40
    })
    if (visible) return b
  } catch {
    // 没有保存过，或内容无效
  }
  const a = screen.getPrimaryDisplay().workArea
  return {
    ...FLOAT_SIZE,
    x: a.x + a.width - FLOAT_SIZE.width - 24,
    y: a.y + a.height - FLOAT_SIZE.height - 24
  }
}

function createFloat(activate: boolean): void {
  if (floatWin) return
  const w = newWindow(
    {
      ...floatBounds(),
      minWidth: 240,
      minHeight: 200,
      frame: false,
      skipTaskbar: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      alwaysOnTop: floatSettings().pinned
    },
    'float'
  )
  floatWin = w
  let timer: NodeJS.Timeout | undefined
  const save = (): void => {
    clearTimeout(timer)
    timer = undefined
    warn('悬浮窗位置未能保存', () => store.setSetting('floatBounds', JSON.stringify(w.getBounds())))
  }
  const later = (): void => {
    clearTimeout(timer)
    timer = setTimeout(save, 300)
  }
  w.on('move', later)
  w.on('resize', later)
  w.once('ready-to-show', () => (activate ? w.show() : w.showInactive()))
  w.on('close', () => {
    if (timer) save()
    if (quitting) return
    warn('悬浮窗状态未能保存', () => store.setSetting('floatOpen', '0'))
  })
  w.on('closed', () => {
    floatWin = null
    if (quitting) return
    refreshTray()
    broadcast()
  })
}

function setFloatOpen(open: boolean): void {
  if (open) {
    store.setSetting('floatOpen', '1')
    if (floatWin) floatWin.show()
    else createFloat(true)
  } else if (floatWin) {
    floatWin.close()
  } else {
    store.setSetting('floatOpen', '0')
  }
  refreshTray()
}

function setFloatPinned(pinned: boolean): void {
  store.setSetting('floatPinned', pinned ? '1' : '0')
  floatWin?.setAlwaysOnTop(pinned)
}

// ---- 托盘 ----

function trayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => showMain(null) },
    {
      label: '悬浮窗',
      type: 'checkbox',
      checked: floatWin !== null,
      click: () => {
        warn('悬浮窗切换失败', () => setFloatOpen(floatWin === null))
        refreshTray()
        broadcast()
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ])
}

// 测试时供自动化调用托盘菜单；对安装后的程序无效
if (!app.isPackaged && process.env.WORKTODO_TEST_NOTIFY) {
  ;(globalThis as Record<string, unknown>).testTrayMenu = trayMenu
}

function refreshTray(): void {
  tray?.setContextMenu(trayMenu())
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(icon32))
  tray.setToolTip(APP_NAME)
  tray.on('click', () => showMain(null))
  refreshTray()
}

// ---- 提醒 ----

/** 启动时取出程序未运行期间错过的提醒；数据库被占用时稍后再取。 */
let startupCollected = false

function checkReminders(): boolean {
  const due = store.collectDue()
  if (!startupCollected) {
    startupCollected = true
    missed = due.map(({ todo }) => ({
      id: todo.id,
      title: todo.title,
      date: todo.date!,
      time: todo.time!
    }))
    return missed.length > 0
  }
  const late = due.filter(({ at }) => clock() - at > LATE_MS)
  const merged = late.length > 1 ? late : []
  for (const item of due) {
    if (merged.includes(item)) continue
    const { todo } = item
    const lead = todo.remind ? `（提前 ${todo.remind} 分钟提醒）` : ''
    notify(todo.title, `${todo.date === dayKey(clock()) ? '今天' : todo.date} ${todo.time}${lead}`, () =>
      showMain(todo.id)
    )
  }
  if (merged.length > 0) {
    const names = merged.slice(0, 5).map(({ todo }) => todo.title)
    notify(
      `有 ${merged.length} 项提醒已过时间`,
      names.join('、') + (merged.length > names.length ? ' 等' : ''),
      () => showMain(null)
    )
  }
  return false
}

/** 每秒检查跨日、回收站到期和提醒，变化时通知界面。 */
function startTicker(): void {
  let day = dayKey(clock())
  ticker = setInterval(() => {
    const today = dayKey(clock())
    let changed = today !== day
    warn('清理回收站失败，下一秒重试', () => {
      if (store.purgeExpired() > 0) changed = true
    })
    warn('检查提醒失败，下一秒重试', () => {
      if (checkReminders()) changed = true
    })
    if (changed) {
      day = today
      warn('通知界面失败', () => broadcast())
    }
  }, 1000)
}

// ---- 界面调用 ----

function registerIpc(): void {
  const check = (event: Electron.IpcMainInvokeEvent): void => {
    const known = [win, floatWin].some((w) => w && event.senderFrame === w.webContents.mainFrame)
    if (!known) throw new Error('来源无效')
  }
  const handle = (channel: string, action: (...args: never[]) => void, changes = true): void => {
    ipcMain.handle(channel, (event, ...args): AppState => {
      check(event)
      action(...(args as never[]))
      if (changes) broadcast(event.sender)
      return state()
    })
  }
  handle('state:get', () => {}, false)
  handle('todo:add', (title: string, date: string | null) => void store.add(title, date))
  handle('todo:update', (id: string, patch: TodoPatch) => store.update(id, patch))
  handle('todo:done', (id: string, done: boolean) => store.setDone(id, done))
  handle('todo:reorder', (ids: string[]) => store.reorder(ids))
  handle('todo:remove', (id: string) => store.remove(id))
  handle('todo:restore', (id: string) => store.restore(id))
  handle('todo:purge', (id: string) => store.purge(id))
  handle('missed:dismiss', () => void (missed = []))
  handle('float:open', (open: boolean) => setFloatOpen(open === true))
  handle('float:pin', (pinned: boolean) => setFloatPinned(pinned === true))
  handle('main:open', (id: string | null) => showMain(typeof id === 'string' ? id : null), false)
  ipcMain.handle('focus:take', (event): string | null => {
    check(event)
    if (event.sender !== win?.webContents) return null
    const id = pendingFocus
    pendingFocus = null
    return id
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.setAppUserModelId(app.isPackaged ? 'io.github.yifei929hub.worktodo' : process.execPath)
  app.on('second-instance', () => showMain(null))
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => (quitting = true))
  app.on('will-quit', () => {
    // 先停定时器，否则退出过程中会访问已关闭的数据库
    clearInterval(ticker)
    tray?.destroy()
    store?.close()
  })

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
    warn('启动时清理回收站失败，稍后重试', () => void store.purgeExpired())
    warn('启动时检查提醒失败，稍后重试', () => void checkReminders())
    registerIpc()
    createTray()
    createMain()
    if (floatSettings().open) createFloat(false)
    refreshTray()
    startTicker()
  })
}
