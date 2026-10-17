import { CharacterSprite } from './CharacterSprite'

export function Companion() {
  return (
    <main className="companion">
      <div className="character" title="Drag to move">
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
