import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow } from 'electron'
import type { BoardApi, BoardMethod, SavedBoard } from '../shared/board'

// Whiteboard state that outlives the tutoring window (cleared when the app quits).
let saved: SavedBoard | null = null

// The window currently hosting the board; requests are routed to it.
let host: BrowserWindow | null = null
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
const REQUEST_TIMEOUT_MS = 10_000

export function attachBoardHost(win: BrowserWindow): void {
  host = win
  win.on('closed', () => {
    if (host === win) host = null
    for (const [id, p] of pending) {
      p.reject(new Error('Tutoring window closed'))
      pending.delete(id)
    }
  })
}

function request(method: BoardMethod, args: unknown[]): Promise<unknown> {
  const target = host
  if (!target || target.isDestroyed()) return Promise.reject(new Error('Tutoring window is not open'))
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Board request "${method}" timed out`))
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e))
    })
    target.webContents.send('board:request', id, method, args)
  })
}

/**
 * Main-process handle on the live board. Future Claude tool calls use this:
 *   await board.upsertElements([{ id: 'step1-box', type: 'rectangle', x: 0, y: 0, width: 200, height: 80 }])
 * Rejects while the tutoring window is closed.
 */
export const board: BoardApi = {
  getScene: () => request('getScene', []) as ReturnType<BoardApi['getScene']>,
  getSelected: () => request('getSelected', []) as ReturnType<BoardApi['getSelected']>,
  upsertElements: (s) => request('upsertElements', [s]) as ReturnType<BoardApi['upsertElements']>,
  updateElements: (p) => request('updateElements', [p]) as ReturnType<BoardApi['updateElements']>,
  deleteElements: (ids) => request('deleteElements', [ids]) as ReturnType<BoardApi['deleteElements']>,
  clear: () => request('clear', []) as ReturnType<BoardApi['clear']>
}

export function registerBoardIpc(): void {
  ipcMain.on('board:response', (event, id: unknown, ok: unknown, payload: unknown) => {
    if (typeof id !== 'string' || event.sender !== host?.webContents) return
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (ok) p.resolve(payload)
    else p.reject(new Error(typeof payload === 'string' ? payload : 'Board request failed'))
  })

  ipcMain.on('board:save', (event, scene: unknown) => {
    if (event.sender !== host?.webContents) return
    const s = scene as Partial<SavedBoard> | null
    if (s && Array.isArray(s.elements) && s.viewport && typeof s.viewport === 'object') saved = s as SavedBoard
  })

  ipcMain.handle('board:load', (event) => (event.sender === host?.webContents ? saved : null))
}
