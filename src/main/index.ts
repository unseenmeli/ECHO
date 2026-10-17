import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, screen } from 'electron'

const COMPANION_WIDTH = 150
const COMPANION_HEIGHT = 240
const SCREEN_MARGIN = 24

let companion: BrowserWindow | null = null

function createCompanionWindow(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay()

  const win = new BrowserWindow({
    width: COMPANION_WIDTH,
    height: COMPANION_HEIGHT,
    x: workArea.x + workArea.width - COMPANION_WIDTH - SCREEN_MARGIN,
    y: workArea.y + workArea.height - COMPANION_HEIGHT - SCREEN_MARGIN,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // macOS: let the first click on the (usually unfocused) companion start a
    // drag or press a button, instead of only focusing the window.
    acceptFirstMouse: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // 'floating' keeps it above normal windows; also follow the user across
  // macOS Spaces and over full-screen apps.
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  win.once('ready-to-show', () => win.showInactive())

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.on('closed', () => {
    companion = null
  })

  return win
}

// Button actions. Stubs for now — these become "start listening" and
// "explain deeper / open lecture" once the voice and lecture layers exist.
ipcMain.on('companion:ask', () => {
  console.log('[companion] ? pressed')
})
ipcMain.on('companion:next', () => {
  console.log('[companion] > pressed')
})

// Window dragging. The renderer sends the cursor offset since drag start;
// applying it to the origin (rather than summing deltas) avoids drift.
let dragOrigin: [number, number] | null = null

ipcMain.on('companion:drag-start', () => {
  if (companion) dragOrigin = companion.getPosition() as [number, number]
})
ipcMain.on('companion:drag-move', (_event, dx: unknown, dy: unknown) => {
  if (!companion || !dragOrigin || typeof dx !== 'number' || typeof dy !== 'number') return
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
  companion.setPosition(Math.round(dragOrigin[0] + dx), Math.round(dragOrigin[1] + dy))
})

app.whenReady().then(() => {
  companion = createCompanionWindow()

  app.on('activate', () => {
    if (!companion) companion = createCompanionWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
