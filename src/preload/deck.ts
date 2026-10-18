import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DeckView } from '../shared/deck'

// The deck window: shows the deck ECHO is building, and reports which slide the user moved to and what it has drawn.
const api = {
  get: (): Promise<DeckView | null> => ipcRenderer.invoke('deck:get'),
  onShow: (cb: (view: DeckView) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, view: DeckView): void => cb(view)
    ipcRenderer.on('deck:show', listener)
    return () => ipcRenderer.removeListener('deck:show', listener)
  },
  select: (index: number): void => ipcRenderer.send('deck:select', index),
  rendered: (version: number): void => ipcRenderer.send('deck:rendered', version)
}

export type DeckApi = typeof api

contextBridge.exposeInMainWorld('deck', api)
