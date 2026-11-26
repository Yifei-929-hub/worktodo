import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api, AppState } from '../shared/types'

const api: Api = {
  getState: () => ipcRenderer.invoke('state:get'),
  add: (title, date, time, endTime) => ipcRenderer.invoke('todo:add', title, date, time, endTime),
  update: (id, patch) => ipcRenderer.invoke('todo:update', id, patch),
  setDone: (id, done) => ipcRenderer.invoke('todo:done', id, done),
  reorder: (ids) => ipcRenderer.invoke('todo:reorder', ids),
  remove: (id) => ipcRenderer.invoke('todo:remove', id),
  restore: (id) => ipcRenderer.invoke('todo:restore', id),
  purge: (id) => ipcRenderer.invoke('todo:purge', id),
  dismissMissed: () => ipcRenderer.invoke('missed:dismiss'),
  setFloatOpen: (open) => ipcRenderer.invoke('float:open', open),
  setFloatPinned: (pinned) => ipcRenderer.invoke('float:pin', pinned),
  openMain: (id) => ipcRenderer.invoke('main:open', id),
  takeFocus: () => ipcRenderer.invoke('focus:take'),
  onFocus: (listener) => {
    const handler = (): void => {
      void ipcRenderer.invoke('focus:take').then((id: string | null) => {
        if (id) listener(id)
      })
    }
    ipcRenderer.on('focus', handler)
    return () => ipcRenderer.off('focus', handler)
  },
  listBackups: () => ipcRenderer.invoke('backup:list'),
  exportBackup: () => ipcRenderer.invoke('backup:export'),
  prepareRestore: (name) => ipcRenderer.invoke('backup:prepare', name),
  cancelRestore: () => ipcRenderer.invoke('backup:cancel'),
  confirmRestore: () => ipcRenderer.invoke('backup:restore'),
  openBackupFolder: () => ipcRenderer.invoke('backup:folder'),
  listLogs: () => ipcRenderer.invoke('log:list'),
  getLog: (date) => ipcRenderer.invoke('log:get', date),
  saveLog: (date, items) => ipcRenderer.invoke('log:save', date, items),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  onState: (listener) => {
    const handler = (_event: IpcRendererEvent, state: AppState): void => listener(state)
    ipcRenderer.on('state', handler)
    return () => ipcRenderer.off('state', handler)
  }
}

contextBridge.exposeInMainWorld('worktodo', api)
