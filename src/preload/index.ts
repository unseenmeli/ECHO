import { contextBridge, ipcRenderer } from 'electron'
import type { VoiceEvent } from '../shared/voice'
import type { VoiceApi } from './voiceBridge'

// The only surface the React UI gets. Keep privileged Electron APIs out of
// the renderer; add narrowly scoped methods here as features land.
const api = {
  next: (): void => ipcRenderer.send('companion:next'),
  openLesson: (): void => ipcRenderer.send('companion:open-lesson'),
  dragStart: (): void => ipcRenderer.send('companion:drag-start'),
  dragEnd: (): void => ipcRenderer.send('companion:drag-end')
}

contextBridge.exposeInMainWorld('companion', api)
// Voice conversation bridge (same surface in every UI window; kept inline because
// sandboxed preload scripts cannot require shared chunks).
const voiceApi: VoiceApi = {
  command: (cmd) => ipcRenderer.send('voice:command', cmd),
  getState: () => ipcRenderer.invoke('voice:get-state'),
  onEvent: (cb) => {
    const listener = (_e: unknown, event: VoiceEvent): void => cb(event)
    ipcRenderer.on('voice:event', listener)
    return () => ipcRenderer.removeListener('voice:event', listener)
  }
}
contextBridge.exposeInMainWorld('voice', voiceApi)

export type CompanionApi = typeof api
