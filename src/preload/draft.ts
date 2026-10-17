import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Draft, DraftEdits } from '../shared/compose'

// The draft card: shows an email or post ECHO wrote, lets the user edit it, and answers Send or Cancel.
const api = {
  get: (): Promise<Draft | null> => ipcRenderer.invoke('draft:get'),
  onShow: (cb: (draft: Draft | null) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, draft: Draft | null): void => cb(draft)
    ipcRenderer.on('draft:show', listener)
    return () => ipcRenderer.removeListener('draft:show', listener)
  },
  edit: (id: string, edits: DraftEdits): void => ipcRenderer.send('draft:edit', id, edits),
  answer: (id: string, send: boolean): void => ipcRenderer.send('draft:answer', id, send)
}

export type DraftApi = typeof api

contextBridge.exposeInMainWorld('draft', api)
