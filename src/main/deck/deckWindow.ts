import { join } from 'node:path'
import { BrowserWindow, ipcMain, screen } from 'electron'
import type { DeckView } from '../../shared/deck'

// The window a deck is shown in. It opens without taking focus (the user is talking, maybe in another app), follows
// every change the studio makes, and doubles as the page the PDF is printed from.

const WIDTH = 960
const HEIGHT = 600
const READY_TIMEOUT_MS = 8000

let win: BrowserWindow | null = null
let current: DeckView | null = null
/** The deck version the window last finished drawing. */
let rendered = -1
/** printDeck calls waiting for the window to draw a version. */
let waiters: Array<{ version: number; resolve: () => void }> = []

function create(): BrowserWindow {
  const area = screen.getPrimaryDisplay().workArea
  const isMac = process.platform === 'darwin'
  const created = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: Math.round(area.x + (area.width - WIDTH) / 2),
    y: Math.round(area.y + (area.height - HEIGHT) / 3),
    minWidth: 480,
    minHeight: 320,
    show: false,
    title: 'Presentation',
    backgroundColor: '#101114',
    ...(isMac && { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 14 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/deck.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Printing to PDF needs it drawing even when it's behind other windows.
      backgroundThrottling: false
    }
  })
  rendered = -1
  created.once('ready-to-show', () => created.showInactive())
  created.on('closed', () => {
    if (win === created) win = null
  })
  if (process.env.ELECTRON_RENDERER_URL) void created.loadURL(`${process.env.ELECTRON_RENDERER_URL}/deck.html`)
  else void created.loadFile(join(__dirname, '../renderer/deck.html'))
  return created
}

/** Shows the deck window with this view (opening it if needed), or updates it. */
export function showDeck(view: DeckView): void {
  current = view
  if (!win || win.isDestroyed()) {
    win = create() // the window asks for the view once loaded
    return
  }
  win.webContents.send('deck:show', view)
  if (!win.isVisible()) win.showInactive()
}

export function isDeckOpen(): boolean {
  return !!win && !win.isDestroyed() && win.isVisible()
}

export function closeDeck(): void {
  if (win && !win.isDestroyed()) win.close()
}

/** The current deck as a PDF, one 16:9 page per slide, printed from the deck window. */
export async function printDeck(): Promise<Buffer> {
  if (!current?.deck) throw new Error('no deck')
  showDeck(current)
  const target = current.deck.version
  if (rendered < target) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the deck window did not finish drawing')), READY_TIMEOUT_MS)
      waiters.push({
        version: target,
        resolve: () => {
          clearTimeout(timer)
          resolve()
        }
      })
    })
  }
  if (!win || win.isDestroyed()) throw new Error('the deck window closed')
  return win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } })
}

/** @param select The window's own arrows and arrow keys. */
export function registerDeckIpc(select: (index: number) => void): void {
  const fromDeck = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean => !!win && !win.isDestroyed() && e.sender === win.webContents
  ipcMain.handle('deck:get', (e) => (fromDeck(e) ? current : null))
  ipcMain.on('deck:select', (e, index: unknown) => {
    if (fromDeck(e) && typeof index === 'number') select(index)
  })
  ipcMain.on('deck:rendered', (e, version: unknown) => {
    if (!fromDeck(e) || typeof version !== 'number') return
    rendered = Math.max(rendered, version)
    const done = waiters.filter((w) => w.version <= rendered)
    waiters = waiters.filter((w) => w.version > rendered)
    for (const w of done) w.resolve()
  })
}
