import { useRef, type PointerEvent } from 'react'
import { CharacterSprite } from './CharacterSprite'

// Dragging is done by hand rather than with -webkit-app-region: drag, because
// native drag regions swallow mouse events and :hover would never fire.
function useWindowDrag() {
  const start = useRef<{ x: number; y: number } | null>(null)

  return {
    onPointerDown(e: PointerEvent<HTMLElement>) {
      if (e.button !== 0) return
      e.currentTarget.setPointerCapture(e.pointerId)
      start.current = { x: e.screenX, y: e.screenY }
      window.companion.dragStart()
    },
    onPointerMove(e: PointerEvent<HTMLElement>) {
      if (!start.current) return
      window.companion.dragMove(e.screenX - start.current.x, e.screenY - start.current.y)
    },
    onPointerUp(e: PointerEvent<HTMLElement>) {
      e.currentTarget.releasePointerCapture(e.pointerId)
      start.current = null
    }
  }
}

export function Companion() {
  const drag = useWindowDrag()

  return (
    <main className="companion">
      <div className="character" title="Drag to move" {...drag} onPointerCancel={drag.onPointerUp}>
        <CharacterSprite />
      </div>

      <div className="controls">
        <button
          className="glass-button"
          aria-label="Start lesson"
          title="Start lesson"
          onClick={() => window.companion.openLesson()}
        >
          <svg className="glyph-book" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 6.5C10.4 5.3 8.2 4.7 5 4.7v12.6c3.2 0 5.4.6 7 1.8 1.6-1.2 3.8-1.8 7-1.8V4.7c-3.2 0-5.4.6-7 1.8z" />
            <path d="M12 6.5v12.6" />
          </svg>
        </button>
        <span className="controls-divider" aria-hidden="true" />
        <button
          className="glass-button"
          aria-label="Ask a question"
          title="Ask a question"
          onClick={() => window.companion.ask()}
        >
          <span className="glyph-question">?</span>
        </button>
        <span className="controls-divider" aria-hidden="true" />
        <button
          className="glass-button"
          aria-label="Go deeper"
          title="Go deeper"
          onClick={() => window.companion.next()}
        >
          <svg className="glyph-chevron" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </main>
  )
}
