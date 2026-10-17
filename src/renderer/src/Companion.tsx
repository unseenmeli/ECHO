import { useRef, type PointerEvent } from 'react'
import { CharacterSprite } from './CharacterSprite'
import { PreferenceToast } from './preferences/PreferenceToast'
import { useScreenWatcher } from './useScreenWatcher'
import { useVoice } from './voice/useVoice'

// Dragging is done by hand rather than with -webkit-app-region: drag, because
// native drag regions swallow mouse events and :hover would never fire. The
// renderer only marks the start and end; the main process moves the window
// by following the OS cursor.
function useWindowDrag() {
  const dragging = useRef(false)

  const end = (): void => {
    if (!dragging.current) return
    dragging.current = false
    window.companion.dragEnd()
  }

  return {
    onPointerDown(e: PointerEvent<HTMLElement>) {
      if (e.button !== 0) return
      // Capture keeps pointerup coming to us even if the cursor outruns the window.
      e.currentTarget.setPointerCapture(e.pointerId)
      dragging.current = true
      window.companion.dragStart()
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end
  }
}

export function Companion() {
  const drag = useWindowDrag()
  const screen = useScreenWatcher()
  const { snapshot } = useVoice()
  const voiceOn = snapshot.state !== 'idle' && snapshot.state !== 'error'
  const voiceLabel = voiceOn ? 'End conversation' : 'Start conversation'

  // Starting a conversation never asks to share the screen; sharing is turned on from the tray menu.
  const toggleVoice = (): void => window.voice.command({ type: 'toggle' })

  return (
    <main className="companion" data-voice={snapshot.state}>
      <PreferenceToast className="companion-toast" />
      {screen.status !== 'off' && (
        <button
          className="watch-pill"
          data-status={screen.status}
          onClick={screen.togglePause}
          title={`${screen.status === 'paused' ? 'Resume' : 'Pause'} watching${screen.sourceLabel ? ` · ${screen.sourceLabel}` : ''}`}
        >
          <span className="watch-dot" aria-hidden="true" />
          {screen.status === 'paused' ? 'Paused' : 'Watching'}
        </button>
      )}

      <div className="character" title="Drag to move" {...drag}>
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
          aria-label={voiceLabel}
          aria-pressed={voiceOn}
          title={snapshot.state === 'error' && snapshot.message ? snapshot.message : voiceLabel}
          onClick={toggleVoice}
        >
          <span className="glyph-question">?</span>
          {snapshot.state !== 'idle' && <span className="voice-dot" aria-hidden="true" />}
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
