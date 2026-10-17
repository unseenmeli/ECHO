import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import windowIconPath from '../../resources/icon.png?asset'

let win: BrowserWindow | null = null

/** The preferences window if it is open, so it can receive live updates. */
export function preferencesWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null
}

export function openPreferencesWindow(): void {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return
  }

  const created = new BrowserWindow({
    width: 480,
    height: 640,
    minWidth: 400,
    minHeight: 420,
    show: false,
    backgroundColor: '#f5f4f0',
    title: 'ECHO Preferences',
    icon: windowIconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preferences.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win = created
  created.once('ready-to-show', () => created.show())
  created.on('closed', () => {
    if (win === created) win = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void created.loadURL(`${process.env.ELECTRON_RENDERER_URL}/preferences.html`)
  } else {
    void created.loadFile(join(__dirname, '../renderer/preferences.html'))
  }
}
