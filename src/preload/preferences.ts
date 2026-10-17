import { contextBridge, ipcRenderer } from 'electron'
import type { PreferenceEvent } from '../shared/preferences'
import type { PreferencesApi } from './preferencesBridge'

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
