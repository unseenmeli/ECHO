import { contextBridge, ipcRenderer } from 'electron'
import type { BoardMethod, SavedBoard } from '../shared/board'

type RequestHandler = (method: BoardMethod, args: unknown[]) => Promise<unknown>

// Narrow surface for the tutoring window: persist/restore the board, and
// answer board requests that originate in the main process.
const api = {
  loadBoard: (): Promise<SavedBoard | null> => ipcRenderer.invoke('board:load'),
  saveBoard: (scene: SavedBoard): void => ipcRenderer.send('board:save', scene),
  handleBoardRequests: (handler: RequestHandler): (() => void) => {
    const listener = (_e: unknown, id: string, method: BoardMethod, args: unknown[]): void => {
      handler(method, args).then(
        (result) => ipcRenderer.send('board:response', id, true, result),
        (err: unknown) => ipcRenderer.send('board:response', id, false, err instanceof Error ? err.message : String(err))
      )
    }
    ipcRenderer.on('board:request', listener)
    return () => ipcRenderer.removeListener('board:request', listener)
  }
}

contextBridge.exposeInMainWorld('tutor', api)

export type TutorApi = typeof api
