import { contextBridge, ipcRenderer } from 'electron'
import type { PreferenceEvent } from '../shared/preferences'
import type { VoiceEvent } from '../shared/voice'
import type { PreferencesApi } from './preferencesBridge'
import type { VoiceApi } from './voiceBridge'
import type { BoardMethod, SavedBoard } from '../shared/board'

type RequestHandler = (method: BoardMethod, args: unknown[]) => Promise<unknown>

// Narrow surface for the tutoring window: persist/restore the board, and
// answer board requests that originate in the main process.
const api = {
  loadBoard: (): Promise<SavedBoard | null> => ipcRenderer.invoke('board:load'),
  saveBoard: (scene: SavedBoard): void => ipcRenderer.send('board:save', scene),
  /** The board answers requests from now on. */
  boardReady: (): void => ipcRenderer.send('board:ready'),
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
  openLink: (url) => ipcRenderer.send('voice:open-link', url),
  onEvent: (cb) => {
    const listener = (_e: unknown, event: VoiceEvent): void => cb(event)
    ipcRenderer.on('voice:event', listener)
    return () => ipcRenderer.removeListener('voice:event', listener)
  }
}
contextBridge.exposeInMainWorld('voice', voiceApi)
// Saved-preference bridge: the "Preference saved · Undo" toast (see PreferenceToast).
const preferencesApi: PreferencesApi = {
  get: () => ipcRenderer.invoke('prefs:get'),
  command: (cmd) => ipcRenderer.invoke('prefs:command', cmd),
  onEvent: (cb) => {
    const listener = (_e: unknown, event: PreferenceEvent): void => cb(event)
    ipcRenderer.on('prefs:event', listener)
    return () => ipcRenderer.removeListener('prefs:event', listener)
  }
}
contextBridge.exposeInMainWorld('preferences', preferencesApi)

export type TutorApi = typeof api
