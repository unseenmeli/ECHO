import { contextBridge, ipcRenderer } from 'electron'

// The only surface the React UI gets. Keep privileged Electron APIs out of
// the renderer; add narrowly scoped methods here as features land.
const api = {
  ask: (): void => ipcRenderer.send('companion:ask'),
  next: (): void => ipcRenderer.send('companion:next')
}

contextBridge.exposeInMainWorld('companion', api)

export type CompanionApi = typeof api
