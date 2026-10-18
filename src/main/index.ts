import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, screen, shell } from 'electron'
import { attachBoardHost, registerBoardIpc, whenBoardReady } from './board'
import { attachScreenHost, registerScreenIpc, screenContext } from './screenContext'
import { createTray } from './tray'
import windowIconPath from '../../resources/icon.png?asset'
import { voiceHost } from './voice/host'
import { registerPreferenceIpc } from './memory/preferenceIpc'
import { PreferenceStore } from './memory/preferenceStore'
import { STUDY_EXTENSIONS, StudyMaterial } from './study/studyMaterial'
import { openPreferencesWindow, preferencesWindow } from './preferencesWindow'
import { registerDraftIpc } from './compose/draftWindow'
<<<<<<< HEAD
=======
import { registerDeckIpc } from './deck/deckWindow'
>>>>>>> origin/main
import { AccessCodeStore, registerAccessIpc } from './accessCode'
import { loadEnvFiles } from './voice/config'

const COMPANION_WIDTH = 150
// Tall enough for the "Watching" pill above the character.
const COMPANION_HEIGHT = 270
const SCREEN_MARGIN = 24

let companion: BrowserWindow | null = null
let lesson: BrowserWindow | null = null
/** Screenshot the current lesson was started from (for the teacher handoff). */
let lessonSourceFrameId: string | null = null

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
      sandbox: true,
      // It owns the screen-capture stream; keep sampling while hidden.
      backgroundThrottling: false
    }
  })
  attachScreenHost(win)

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

  // Preserve what the student was looking at before the lesson window covers
  // it, so later questions refer to the material, not the whiteboard.
  const source = screenContext.latest()
  if (source && screenContext.pin(source.id)) lessonSourceFrameId = source.id

  const isMac = process.platform === 'darwin'
  const isWin = process.platform === 'win32'
  nativeTheme.themeSource = 'light'

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    show: false,
    backgroundColor: '#f5f4f0',
    title: 'Lesson',
    // Windows/Linux taskbar + title icon (macOS windows don't show one).
    icon: windowIconPath,
    // macOS: traffic lights inset into the renderer's title bar.
    ...(isMac && {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 18, y: 19 }
    }),
    // Windows: native caption buttons drawn over the renderer's title bar.
    ...(isWin && {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: { color: '#00000000', symbolColor: '#1c1c1e', height: 52 }
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

// Button actions. "?" starts/ends the voice conversation (see ./voice). ">" minimizes ECHO to the tray; the tray
// menu (or its icon) brings it back. A deep dive is asked for by voice.
ipcMain.on('companion:hide', (event) => {
  if (!companion || event.sender !== companion.webContents) return
  companion.hide()
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

// Debug aid: open the most recent frame in the system image viewer.
async function showLatestFrame(): Promise<void> {
  const frame = screenContext.latest()
  if (!frame) return
  const file = join(app.getPath('temp'), 'echo-latest-frame.jpg')
  await writeFile(file, frame.data)
  await shell.openPath(file)
}

function showCompanion(): void {
  if (!companion || companion.isDestroyed()) companion = createCompanionWindow()
  else companion.showInactive()
}

/** Asks for files and adds them, saying how it went (the app has no window that would show it otherwise). */
async function addStudyMaterial(study: StudyMaterial): Promise<void> {
  app.focus({ steal: true })
  const picked = await dialog.showOpenDialog({
    title: 'Add study material',
    buttonLabel: 'Add',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF, text or Markdown', extensions: STUDY_EXTENSIONS }]
  })
  if (picked.canceled) return
  const lines: string[] = []
  for (const path of picked.filePaths) {
    const r = await study.add(path)
    lines.push(r.ok ? `${r.file.name}: ${r.file.problem ?? `${r.file.pages} ${r.file.unit}${r.file.pages === 1 ? '' : 's'}, ready`}` : r.message)
  }
  if (Notification.isSupported()) new Notification({ title: 'Study material', body: lines.join('\n') }).show()
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
    // Read .env now, not at the first conversation: Preferences needs ECHO_BACKEND_URL to offer the access code box.
    loadEnvFiles([app.getAppPath(), process.cwd(), app.getPath('userData')])

    registerBoardIpc()
    // The card for emails and posts ECHO drafts, shown beside the companion.
    registerDraftIpc(() => (companion && !companion.isDestroyed() ? companion.getBounds() : null), {
      answer: (id, send) => voiceHost.answerDraft(id, send),
      edit: (id, edits) => voiceHost.editDraft(id, edits)
    })
<<<<<<< HEAD
=======
    // The window for slide decks ECHO builds by voice.
    registerDeckIpc((index) => voiceHost.selectSlide(index))
>>>>>>> origin/main
    registerScreenIpc(() => [companion, lesson].filter((w): w is BrowserWindow => !!w && !w.isDestroyed()))
    // What ECHO remembers about how to teach this learner: a small file in the user-data folder.
    const preferences = new PreferenceStore(join(app.getPath('userData'), 'preferences.json'))
    registerPreferenceIpc(preferences, () =>
      [companion, lesson, preferencesWindow()].filter((w): w is BrowserWindow => !!w && !w.isDestroyed())
    )
    // The judge access code for ECHO's server (when the app was built or started with one).
    const access = new AccessCodeStore(join(app.getPath('userData'), 'access-code.json'))
    registerAccessIpc(access, () => [preferencesWindow()].filter((w): w is BrowserWindow => !!w && !w.isDestroyed()))
    // The learner's own study material: which files they added, re-read on launch.
    const study = new StudyMaterial(join(app.getPath('userData'), 'study-material.json'))
    void study.load()
    voiceHost.register({
      canCaptureScreen: (wc) => !!companion && !companion.isDestroyed() && wc === companion.webContents,
      openLesson: (timeoutMs) => {
        openLessonWindow()
        return whenBoardReady(timeoutMs)
      },
      closeLesson: () => {
        if (lesson && !lesson.isDestroyed()) lesson.close()
      },
      preferences,
      study,
      access
    })
    companion = createCompanionWindow()

    createTray({
      isCompanionVisible: () => !!companion && !companion.isDestroyed() && companion.isVisible(),
      toggleCompanion: () => {
        if (companion && !companion.isDestroyed() && companion.isVisible()) companion.hide()
        else showCompanion()
      },
      openLesson: openLessonWindow,
      openPreferences: openPreferencesWindow,
      study: {
        list: () => study.list(),
        add: () => void addStudyMaterial(study),
        remove: (id) => void study.remove(id)
      },
      screen: {
        state: screenContext.state,
        start: screenContext.requestStart,
        togglePause: screenContext.togglePause,
        stop: screenContext.stop,
        showLatest: showLatestFrame
      },
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
