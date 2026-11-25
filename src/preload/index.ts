import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api, AppState } from '../shared/types'

const api: Api = {
  getState: () => ipcRenderer.invoke('state:get'),
  add: (title, date) => ipcRenderer.invoke('todo:add', title, date),
  update: (id, patch) => ipcRenderer.invoke('todo:update', id, patch),
  setDone: (id, done) => ipcRenderer.invoke('todo:done', id, done),
  reorder: (ids) => ipcRenderer.invoke('todo:reorder', ids),
  remove: (id) => ipcRenderer.invoke('todo:remove', id),
  restore: (id) => ipcRenderer.invoke('todo:restore', id),
  purge: (id) => ipcRenderer.invoke('todo:purge', id),
  onState: (listener) => {
    const handler = (_event: IpcRendererEvent, state: AppState): void => listener(state)
    ipcRenderer.on('state', handler)
    return () => ipcRenderer.off('state', handler)
  }
}

contextBridge.exposeInMainWorld('worktodo', api)
