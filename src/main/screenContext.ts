import { randomUUID } from 'node:crypto'
import { desktopCapturer, ipcMain, Menu, session, webContents, type BrowserWindow } from 'electron'
import type { FramePayload, FrameTrigger, SharingState } from '../shared/screen'

/** A captured frame, held in memory only. */
export interface ScreenFrame {
  /** Stable reference for handoffs, e.g. "frame-42". */
  id: string
  capturedAt: number
  trigger: FrameTrigger
  sourceLabel: string | null
  width: number
  height: number
  mimeType: 'image/jpeg'
  data: Buffer
}

// Bounded history. The renderer skips frames when nothing visibly changed, so
// this covers more than MAX_FRAMES × the sampling interval of real time.
const MAX_FRAMES = 12
// Frames kept beyond eviction because something refers to them (e.g. the
// screenshot a lesson was started from).
const MAX_PINNED = 8
const FRESH_TIMEOUT_MS = 3000

let host: BrowserWindow | null = null
let state: SharingState = { status: 'off', sourceLabel: null }
let nextFrameNumber = 1
const frames: ScreenFrame[] = []
const pinned = new Map<string, ScreenFrame>()
const pendingFresh = new Map<string, { resolve: (f: ScreenFrame) => void; reject: (e: Error) => void }>()
const stateListeners = new Set<(s: SharingState) => void>()

function setState(next: SharingState): void {
  state = next
  if (host && !host.isDestroyed()) host.webContents.send('screen:status', state)
  for (const listener of stateListeners) listener(state)
}

function storeFrame(payload: FramePayload): ScreenFrame {
  const frame: ScreenFrame = {
    id: `frame-${nextFrameNumber++}`,
    capturedAt: payload.capturedAt,
    trigger: payload.trigger,
    sourceLabel: state.sourceLabel,
    width: payload.width,
    height: payload.height,
    mimeType: payload.mimeType,
    data: Buffer.from(payload.bytes)
  }
  frames.push(frame)
  if (frames.length > MAX_FRAMES) frames.shift()
  return frame
}

function rejectPending(reason: string): void {
  for (const [id, p] of pendingFresh) {
    p.reject(new Error(reason))
    pendingFresh.delete(id)
  }
}

/**
 * Main-process handle on what the user is sharing. Agents use this:
 *   const frame = await screenContext.captureFresh()   // when a question is asked
 *   screenContext.pin(frame.id)                        // keep it for a lesson handoff
 */
export const screenContext = {
  state: (): SharingState => state,

  /** Most recent frame, or null if nothing has been captured. */
  latest: (): ScreenFrame | null => frames.at(-1) ?? null,

  /** Up to `limit` most recent frames, oldest first. */
  recent: (limit = 3): ScreenFrame[] => frames.slice(-limit),

  get: (id: string): ScreenFrame | null => pinned.get(id) ?? frames.find((f) => f.id === id) ?? null,

  /** Ask the renderer for a frame right now. Rejects unless actively sharing. */
  captureFresh(): Promise<ScreenFrame> {
    const target = host
    if (state.status !== 'sharing' || !target || target.isDestroyed()) {
      return Promise.reject(new Error(state.status === 'paused' ? 'Screen watching is paused' : 'Screen is not shared'))
    }
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingFresh.delete(requestId)
        reject(new Error('Fresh screen capture timed out'))
      }, FRESH_TIMEOUT_MS)
      pendingFresh.set(requestId, {
        resolve: (f) => (clearTimeout(timer), resolve(f)),
        reject: (e) => (clearTimeout(timer), reject(e))
      })
      target.webContents.send('screen:grab', requestId)
    })
  },

  /** Keep a frame available after it leaves the rolling buffer. */
  pin(id: string): boolean {
    const frame = screenContext.get(id)
    if (!frame) return false
    pinned.delete(id)
    pinned.set(id, frame)
    if (pinned.size > MAX_PINNED) pinned.delete(pinned.keys().next().value!)
    return true
  },

  unpin: (id: string): void => void pinned.delete(id),

  onStateChange(listener: (s: SharingState) => void): () => void {
    stateListeners.add(listener)
    return () => stateListeners.delete(listener)
  },

  /** Start sharing. Needs the renderer to call getDisplayMedia inside a user gesture. */
  requestStart(): void {
    if (!host || host.isDestroyed() || state.status !== 'off') return
    host.webContents.executeJavaScript(`window.dispatchEvent(new Event('echo:start-sharing'))`, true)
  },

  togglePause(): void {
    if (state.status === 'sharing') setState({ ...state, status: 'paused' })
    else if (state.status === 'paused') setState({ ...state, status: 'sharing' })
  },

  stop(): void {
    if (host && !host.isDestroyed()) host.webContents.send('screen:stop')
  }
}

/** The window that owns the capture stream (the companion). */
export function attachScreenHost(win: BrowserWindow): void {
  host = win
  win.webContents.on('did-finish-load', () => win.webContents.send('screen:status', state))
  win.on('closed', () => {
    if (host !== win) return
    host = null
    rejectPending('Companion window closed')
    setState({ status: 'off', sourceLabel: null })
  })
}

export function registerScreenIpc(ownWindows: () => BrowserWindow[]): void {
  const fromHost = (e: Electron.IpcMainEvent): boolean => !!host && e.sender === host.webContents

  ipcMain.on('screen:started', (e, label: unknown) => {
    if (!fromHost(e)) return
    setState({ status: 'sharing', sourceLabel: typeof label === 'string' && label ? label : null })
  })

  ipcMain.on('screen:stopped', (e) => {
    if (!fromHost(e)) return
    rejectPending('Screen sharing stopped')
    setState({ status: 'off', sourceLabel: null })
  })

  ipcMain.on('screen:toggle-pause', (e) => {
    if (fromHost(e)) screenContext.togglePause()
  })

  ipcMain.on('screen:frame', (e, payload: FramePayload) => {
    if (!fromHost(e) || state.status === 'off' || !(payload?.bytes instanceof Uint8Array)) return
    const waiter = payload.requestId ? pendingFresh.get(payload.requestId) : undefined
    // Interval frames are dropped while paused; requested ones were asked for.
    if (state.status === 'paused' && !waiter) return
    const frame = storeFrame(payload)
    if (waiter && payload.requestId) {
      pendingFresh.delete(payload.requestId)
      waiter.resolve(frame)
    }
  })

  ipcMain.on('screen:grab-failed', (e, requestId: unknown, message: unknown) => {
    if (!fromHost(e) || typeof requestId !== 'string') return
    pendingFresh.get(requestId)?.reject(new Error(typeof message === 'string' ? message : 'Capture failed'))
    pendingFresh.delete(requestId)
  })

  // macOS 15+: the system picker (no Screen Recording permission or relaunch
  // needed). Elsewhere the handler below shows a native menu of sources.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      const requester = request.frame ? webContents.fromFrame(request.frame) : undefined
      if (!host || requester !== host.webContents) return callback(null)

      const ownIds = new Set(ownWindows().map((w) => w.getMediaSourceId()))
      const sources = (
        await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
      ).filter((s) => !ownIds.has(s.id))
      const screens = sources.filter((s) => s.id.startsWith('screen:'))
      const windows = sources.filter((s) => s.id.startsWith('window:') && s.name.trim())

      let chosen = false
      const choose = (source: Electron.DesktopCapturerSource) => () => {
        chosen = true
        callback({ video: source })
      }
      const label = (name: string): string => (name.length > 60 ? `${name.slice(0, 57)}…` : name)
      const menu = Menu.buildFromTemplate([
        { label: 'Share with Echo', enabled: false },
        ...screens.map((s, i) => ({
          label: screens.length > 1 ? `Entire Screen ${i + 1}` : 'Entire Screen',
          click: choose(s)
        })),
        ...(windows.length ? [{ type: 'separator' as const }] : []),
        ...windows.map((s) => ({ label: label(s.name), click: choose(s) }))
      ])
      // Clicks are delivered after the menu closes; wait a tick before
      // treating a close as "cancelled".
      menu.once('menu-will-close', () => setTimeout(() => chosen || callback(null), 100))
      menu.popup({ window: host })
    },
    { useSystemPicker: true }
  )
}
