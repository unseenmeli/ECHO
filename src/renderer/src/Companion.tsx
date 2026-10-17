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
