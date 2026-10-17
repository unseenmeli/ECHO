import { useEffect, useRef, useState } from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import '@excalidraw/excalidraw/index.css'
import type { SavedBoard } from '../../../shared/board'
import { createBoardController } from './boardController'
import { VoiceDock } from '../voice/VoiceDock'

const SAVE_DELAY_MS = 250
const isMac = navigator.platform.startsWith('Mac')

export function TutorWindow() {
  // Excalidraw reads initialData once, so wait for the saved board first.
  const [initial, setInitial] = useState<SavedBoard | null | undefined>(undefined)
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const saveTimer = useRef(0)
  const pending = useRef<SavedBoard | null>(null)

  useEffect(() => {
    window.tutor.loadBoard().then(setInitial)
  }, [])

  // Answer board requests from the main process (future Claude actions).
  useEffect(() => {
    if (!api) return
    const board = createBoardController(api)
    return window.tutor.handleBoardRequests((method, args) =>
      (board[method] as (...a: unknown[]) => Promise<unknown>)(...args)
    )
  }, [api])

  const flush = (): void => {
    window.clearTimeout(saveTimer.current)
    if (pending.current) window.tutor.saveBoard(pending.current)
    pending.current = null
  }

  // Don't lose the last edit when the window closes.
  useEffect(() => {
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [])

  const onChange = (
    elements: readonly ExcalidrawElement[],
    state: { scrollX: number; scrollY: number; zoom: { value: number } }
  ): void => {
    pending.current = {
      elements: JSON.parse(JSON.stringify(elements.filter((e) => !e.isDeleted))),
      viewport: { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value }
    }
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(flush, SAVE_DELAY_MS)
  }

  return (
    <div className={`tutor-root ${isMac ? 'platform-mac' : ''}`}>
      <header className="tutor-titlebar">
        <div className="tutor-seal" aria-hidden="true">
          学
        </div>
        <h1>Lesson</h1>
      </header>
      <main className="tutor-board">
        {initial !== undefined && (
          <Excalidraw
            excalidrawAPI={setApi}
            onChange={onChange}
            initialData={{
              elements: (initial?.elements ?? []) as unknown as ExcalidrawElement[],
              appState: {
                ...(initial && {
                  scrollX: initial.viewport.scrollX,
                  scrollY: initial.viewport.scrollY,
                  zoom: { value: initial.viewport.zoom as never }
                })
              },
              scrollToContent: false
            }}
            UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false } }}
          />
        )}
      </main>
      <VoiceDock />
    </div>
  )
}
