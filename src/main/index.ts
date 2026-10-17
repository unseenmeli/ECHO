import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, nativeTheme, screen } from 'electron'
import { attachBoardHost, registerBoardIpc } from './board'
import { createTray } from './tray'
import { voiceHost } from './voice/host'

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

// Button actions. "?" starts/ends the voice conversation (see ./voice); ">"
// is still a stub until the lecture layer exists.
ipcMain.on('companion:next', () => {
  console.log('[companion] > pressed')
})

// Window dragging. While the pointer is held, the window follows the OS cursor
// position instead of renderer coordinates: on Windows those lag behind a
// moving window and feed back into jumps. setBounds pins the size because
// setPosition can grow transparent windows on scaled Windows displays.
const DRAG_INTERVAL_MS = 8
let dragTimer: ReturnType<typeof setInterval> | null = null

function stopDrag(): void {
  if (dragTimer) clearInterval(dragTimer)
  dragTimer = null
}

ipcMain.on('companion:drag-start', (event) => {
  const win = companion
  if (!win || event.sender !== win.webContents) return
  stopDrag()

  const cursor = screen.getCursorScreenPoint()
  const [startX, startY] = win.getPosition()
  const grab = { x: cursor.x - startX, y: cursor.y - startY }
  let last = { x: startX, y: startY }

  dragTimer = setInterval(() => {
    if (win.isDestroyed()) return stopDrag()
    const p = screen.getCursorScreenPoint()
    const x = p.x - grab.x
    const y = p.y - grab.y
    if (x === last.x && y === last.y) return
    last = { x, y }
    win.setBounds({ x, y, width: COMPANION_WIDTH, height: COMPANION_HEIGHT })
  }, DRAG_INTERVAL_MS)
})
ipcMain.on('companion:drag-end', stopDrag)

function showCompanion(): void {
  if (!companion || companion.isDestroyed()) companion = createCompanionWindow()
  else companion.showInactive()
}

// Double-launching (e.g. the Windows shortcut) reuses the running companion.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showCompanion)

  app.whenReady().then(() => {
    // Lives in the menu bar / notification area, not the Dock (packaged macOS
    // builds also set LSUIElement so the Dock icon never flashes at launch).
    app.dock?.hide()

    registerBoardIpc()
    voiceHost.register()
    companion = createCompanionWindow()

    createTray({
      isCompanionVisible: () => !!companion && !companion.isDestroyed() && companion.isVisible(),
      toggleCompanion: () => {
        if (companion && !companion.isDestroyed() && companion.isVisible()) companion.hide()
        else showCompanion()
      },
      openLesson: openLessonWindow,
      toggleVoice: () => voiceHost.toggle(),
      isVoiceActive: () => voiceHost.isActive()
    })

    app.on('activate', showCompanion)
  })
}

app.on('before-quit', () => voiceHost.shutdown())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
