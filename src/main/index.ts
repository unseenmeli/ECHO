import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, nativeTheme, screen } from 'electron'
import { attachBoardHost, registerBoardIpc } from './board'

const COMPANION_WIDTH = 150
const COMPANION_HEIGHT = 240
const SCREEN_MARGIN = 24

let companion: BrowserWindow | null = null
let lesson: BrowserWindow | null = null

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

function openLessonWindow(): void {
  if (lesson && !lesson.isDestroyed()) {
    if (lesson.isMinimized()) lesson.restore()
    lesson.show()
    lesson.focus()
    return
  }

  const isMac = process.platform === 'darwin'
  const isWin = process.platform === 'win32'
  nativeTheme.themeSource = 'light'

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    show: false,
    backgroundColor: '#f3f1ea',
    title: 'Lesson',
    // macOS: traffic lights inset into the renderer's title bar.
    ...(isMac && {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 18, y: 19 }
    }),
    // Windows: native caption buttons drawn over the renderer's title bar.
    ...(isWin && {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: { color: '#00000000', symbolColor: '#151514', height: 52 }
    }),
    ...(!isMac && !isWin && { frame: false }),
    webPreferences: {
      preload: join(__dirname, '../preload/tutor.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  lesson = win
  attachBoardHost(win)

  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (lesson === win) lesson = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/tutor.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/tutor.html'))
  }
}

ipcMain.on('companion:open-lesson', (event) => {
  if (companion && event.sender === companion.webContents) openLessonWindow()
})

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
  registerBoardIpc()
  companion = createCompanionWindow()

  app.on('activate', () => {
    if (!companion) companion = createCompanionWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
