import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { FramePayload, SharingState } from '../shared/screen'

// Subscribe to a main-process channel; returns an unsubscribe function.
function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// The only surface the React UI gets. Keep privileged Electron APIs out of
// the renderer; add narrowly scoped methods here as features land.
const api = {
  ask: (): void => ipcRenderer.send('companion:ask'),
  next: (): void => ipcRenderer.send('companion:next'),
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

export type CompanionApi = typeof api
