import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Excalidraw, MainMenu, WelcomeScreen } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import '@excalidraw/excalidraw/index.css'
import type { SavedBoard } from '../../../shared/board'
import { createBoardController } from './boardController'
import avatarSrc from '../assets/echo-avatar.png'
import characterSrc from '../assets/poses/frame-1.png'
import { VoiceDock } from '../voice/VoiceDock'

const SAVE_DELAY_MS = 250
const isMac = navigator.platform.startsWith('Mac')

export function TutorWindow() {
  // Excalidraw reads initialData once, so wait for the saved board first.
  const [initial, setInitial] = useState<SavedBoard | null | undefined>(undefined)
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const saveTimer = useRef(0)
  const pending = useRef<SavedBoard | null>(null)
  const boardRef = useRef<HTMLElement>(null)

  useEffect(() => {
    window.tutor.loadBoard().then(setInitial)
  }, [])

  // Answer board requests from the main process (the lesson draws through these).
  useEffect(() => {
    if (!api) return
    const board = createBoardController(api)
    const off = window.tutor.handleBoardRequests((method, args) =>
      (board[method] as (...a: unknown[]) => Promise<unknown>)(...args)
    )
    window.tutor.boardReady()
    return off
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
    // The dot-paper texture sits behind a transparent canvas; keep it pinned
    // to the scene so it pans and zooms with the drawing.
    const style = boardRef.current?.style
    if (style) {
      const z = state.zoom.value
      style.setProperty('--paper-zoom', String(z))
      style.setProperty('--paper-x', `${state.scrollX * z}px`)
      style.setProperty('--paper-y', `${state.scrollY * z}px`)
    }

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
        <img className="tutor-avatar" src={avatarSrc} alt="" draggable={false} />
        <h1>
          Lesson<span className="tutor-cursor" aria-hidden="true" />
        </h1>
      </header>
      <main className="tutor-board" ref={boardRef}>
        {initial !== undefined && (
          <Excalidraw
            excalidrawAPI={setApi}
            onChange={onChange}
            theme="light"
            initialData={{
              elements: (initial?.elements ?? []) as unknown as ExcalidrawElement[],
              appState: {
                viewBackgroundColor: 'transparent',
                ...(initial && {
                  scrollX: initial.viewport.scrollX,
                  scrollY: initial.viewport.scrollY,
                  zoom: { value: initial.viewport.zoom as never }
                })
              },
              scrollToContent: false
            }}
            UIOptions={{
              canvasActions: {
                loadScene: false,
                saveToActiveFile: false,
                export: false,
                changeViewBackgroundColor: false,
                toggleTheme: false
              }
            }}
          >
            <MainMenu>
              <MainMenu.DefaultItems.ClearCanvas />
              <MainMenu.DefaultItems.Help />
            </MainMenu>
            <WelcomeScreen>
              <WelcomeScreen.Center>
                <WelcomeScreen.Center.Logo>
                  {/* Pink "echo" afterimages, as on the app icon: silhouettes masked from the sprite. */}
                  <div
                    className="tutor-welcome-art"
                    aria-hidden="true"
                    style={{ '--character': `url(${characterSrc})` } as CSSProperties}
                  >
                    <span className="echo echo-2" />
                    <span className="echo echo-1" />
                    <img src={characterSrc} alt="" draggable={false} />
                  </div>
                </WelcomeScreen.Center.Logo>
                <WelcomeScreen.Center.Heading>
                  <span className="tutor-welcome-title">The board is empty</span>
                  <span className="tutor-welcome-body">
                    Ask <mark>Echo</mark> about what's on your screen and say “explain deeper”. The lesson draws itself
                    here, and you can sketch along.
                  </span>
                </WelcomeScreen.Center.Heading>
              </WelcomeScreen.Center>
              <WelcomeScreen.Hints.ToolbarHint />
            </WelcomeScreen>
          </Excalidraw>
        )}
      </main>
      <VoiceDock />
    </div>
  )
}
