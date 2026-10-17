import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { FramePayload, SharingState } from '../shared/screen'
import type { PreferenceEvent } from '../shared/preferences'
import type { VoiceEvent } from '../shared/voice'
import type { PreferencesApi } from './preferencesBridge'
import type { VoiceApi } from './voiceBridge'

// Subscribe to a main-process channel; returns an unsubscribe function.
function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// The only surface the React UI gets. Keep privileged Electron APIs out of
// the renderer; add narrowly scoped methods here as features land.
const api = {
  hide: (): void => ipcRenderer.send('companion:hide'),
  openLesson: (): void => ipcRenderer.send('companion:open-lesson'),
  dragStart: (): void => ipcRenderer.send('companion:drag-start'),
  dragEnd: (): void => ipcRenderer.send('companion:drag-end'),

  // Screen context: this window owns the capture stream and reports frames.
  screen: {
    reportStarted: (sourceLabel: string): void => ipcRenderer.send('screen:started', sourceLabel),
    reportStopped: (): void => ipcRenderer.send('screen:stopped'),
    sendFrame: (frame: FramePayload): void => ipcRenderer.send('screen:frame', frame),
    reportGrabFailed: (requestId: string, message: string): void =>
      ipcRenderer.send('screen:grab-failed', requestId, message),
    togglePause: (): void => ipcRenderer.send('screen:toggle-pause'),
    onStatus: (cb: (state: SharingState) => void) => on('screen:status', cb),
    onGrabRequest: (cb: (requestId: string) => void) => on('screen:grab', cb),
    onStopRequest: (cb: () => void) => on('screen:stop', cb)
  }
}

contextBridge.exposeInMainWorld('companion', api)
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

export type CompanionApi = typeof api
