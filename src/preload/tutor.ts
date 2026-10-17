import { contextBridge, ipcRenderer } from 'electron'
import type { VoiceEvent } from '../shared/voice'
import type { VoiceApi } from './voiceBridge'
import type { BoardMethod, SavedBoard } from '../shared/board'

type RequestHandler = (method: BoardMethod, args: unknown[]) => Promise<unknown>

// Narrow surface for the tutoring window: persist/restore the board, and
// answer board requests that originate in the main process.
const api = {
  loadBoard: (): Promise<SavedBoard | null> => ipcRenderer.invoke('board:load'),
  saveBoard: (scene: SavedBoard): void => ipcRenderer.send('board:save', scene),
  handleBoardRequests: (handler: RequestHandler): (() => void) => {
    const listener = (_e: unknown, id: string, method: BoardMethod, args: unknown[]): void => {
      handler(method, args).then(
        (result) => ipcRenderer.send('board:response', id, true, result),
        (err: unknown) => ipcRenderer.send('board:response', id, false, err instanceof Error ? err.message : String(err))
      )
    }
    ipcRenderer.on('board:request', listener)
    return () => ipcRenderer.removeListener('board:request', listener)
  }
}

contextBridge.exposeInMainWorld('tutor', api)
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

export type TutorApi = typeof api
