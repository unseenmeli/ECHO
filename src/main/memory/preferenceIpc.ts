import { ipcMain, type BrowserWindow, type WebContents } from 'electron'
import {
  parsePreferenceCommand,
  type PreferenceCommandResult,
  type PreferenceEvent,
  type PreferencesView
} from '../../shared/preferences'
import type { PreferenceStore } from './preferenceStore'

/**
 * The narrow IPC surface for preferences: windows can read the list, edit or forget entries, and undo the last
 * change. Only the app's own UI windows are listed in `windows`; the hidden audio engine is never one of them.
 */
export function registerPreferenceIpc(store: PreferenceStore, windows: () => BrowserWindow[]): void {
  const isAppWindow = (wc: WebContents): boolean => windows().some((w) => w.webContents === wc)

  ipcMain.handle('prefs:get', (event): PreferencesView | null => (isAppWindow(event.sender) ? store.view() : null))

  ipcMain.handle('prefs:command', (event, raw: unknown): PreferenceCommandResult => {
    if (!isAppWindow(event.sender)) return { ok: false, reason: 'Not allowed.' }
    const cmd = parsePreferenceCommand(raw)
    if (!cmd) return { ok: false, reason: 'Unrecognized command.' }
    switch (cmd.type) {
      case 'set': {
        // Edited in the settings window, where the change is already visible: no toast.
        const r = store.set(cmd.key, cmd.value, 'user', { announce: false })
        return r.ok ? { ok: true } : r
      }
      case 'forget':
        store.forget(cmd.key, { announce: false })
        return { ok: true }
      case 'forget-all':
        store.forgetAll({ announce: false })
        return { ok: true }
      case 'undo':
        return store.undo(cmd.id) ? { ok: true } : { ok: false, reason: 'That change can no longer be undone.' }
    }
  })

  const send = (event: PreferenceEvent): void => {
    for (const w of windows()) {
      if (!w.isDestroyed()) w.webContents.send('prefs:event', event)
    }
  }
  store.subscribe((change) => {
    send({ type: 'changed', view: change.view })
    if (change.toast !== undefined) send({ type: 'toast', toast: change.toast })
  })
}
