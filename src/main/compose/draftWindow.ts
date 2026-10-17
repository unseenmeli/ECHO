import { join } from 'node:path'
import { BrowserWindow, ipcMain, screen, type Rectangle } from 'electron'
import { parseDraftEdits, type Draft, type DraftEdits } from '../../shared/compose'

const WIDTH = 380
const HEIGHT = 420
const GAP = 8

let win: BrowserWindow | null = null
let current: Draft | null = null
let anchor: () => Rectangle | null = () => null

/** Next to the companion (to its left, bottom-aligned), kept on its display. */
function placement(): { x: number; y: number } {
  const a = anchor()
  const area = screen.getDisplayMatching(a ?? screen.getPrimaryDisplay().workArea).workArea
  const x = a ? a.x - WIDTH - GAP : area.x + area.width - WIDTH - GAP
  const y = a ? a.y + a.height - HEIGHT : area.y + area.height - HEIGHT - GAP
  return {
    x: Math.round(Math.min(Math.max(x, area.x), area.x + area.width - WIDTH)),
    y: Math.round(Math.min(Math.max(y, area.y), area.y + area.height - HEIGHT))
  }
}

function create(): BrowserWindow {
  const created = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    ...placement(),
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
    acceptFirstMouse: true,
    show: false,
    title: 'ECHO Draft',
    webPreferences: {
      preload: join(__dirname, '../preload/draft.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  created.setAlwaysOnTop(true, 'floating')
  created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  created.once('ready-to-show', () => current && created.showInactive())
  created.on('closed', () => {
    if (win === created) win = null
  })
  if (process.env.ELECTRON_RENDERER_URL) void created.loadURL(`${process.env.ELECTRON_RENDERER_URL}/draft.html`)
  else void created.loadFile(join(__dirname, '../renderer/draft.html'))
  return created
}

/** Shows the draft card with this draft, or hides it (null). */
export function showDraft(draft: Draft | null): void {
  current = draft
  if (!draft) {
    if (win && !win.isDestroyed()) {
      win.hide()
      win.webContents.send('draft:show', null)
    }
    return
  }
  if (!win || win.isDestroyed()) {
    win = create() // shows itself once loaded; the card asks for the draft
    return
  }
  win.setBounds({ ...placement(), width: WIDTH, height: HEIGHT })
  win.webContents.send('draft:show', draft)
  win.showInactive()
}

/**
 * @param getAnchor The companion's bounds, so the card appears beside it.
 * @param handlers Where Send/Cancel and edits from the card go (the voice session).
 */
export function registerDraftIpc(
  getAnchor: () => Rectangle | null,
  handlers: { answer(id: string, send: boolean): void; edit(id: string, edits: DraftEdits): void }
): void {
  anchor = getAnchor
  const fromCard = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean =>
    !!win && !win.isDestroyed() && e.sender === win.webContents
  ipcMain.handle('draft:get', (e) => (fromCard(e) ? current : null))
  ipcMain.on('draft:answer', (e, id: unknown, send: unknown) => {
    if (fromCard(e) && typeof id === 'string' && typeof send === 'boolean') handlers.answer(id, send)
  })
  ipcMain.on('draft:edit', (e, id: unknown, raw: unknown) => {
    const edits = parseDraftEdits(raw)
    if (fromCard(e) && typeof id === 'string' && edits) handlers.edit(id, edits)
  })
}
