import { contextBridge, ipcRenderer } from 'electron'
import type { PreferenceEvent } from '../shared/preferences'
import type { PreferencesApi } from './preferencesBridge'
import type { AccessInfo, AccessSaveResult } from '../shared/access'

// The preferences window: list, edit and forget what ECHO remembers.
const api: PreferencesApi = {
  get: () => ipcRenderer.invoke('prefs:get'),
  command: (cmd) => ipcRenderer.invoke('prefs:command', cmd),
  onEvent: (cb) => {
    const listener = (_e: unknown, event: PreferenceEvent): void => cb(event)
    ipcRenderer.on('prefs:event', listener)
    return () => ipcRenderer.removeListener('prefs:event', listener)
  }
}

contextBridge.exposeInMainWorld('preferences', api)

// The judge access code for ECHO's server: whether one is needed and saved, and saving a new one.
const access = {
  get: (): Promise<AccessInfo | null> => ipcRenderer.invoke('access:get'),
  set: (code: string): Promise<AccessSaveResult> => ipcRenderer.invoke('access:set', code)
}

export type AccessApi = typeof access

contextBridge.exposeInMainWorld('access', access)
