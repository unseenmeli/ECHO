import { useEffect, useState } from 'react'
import { AccessSection } from './AccessSection'
import type { PreferenceRow, PreferencesView } from '../../../shared/preferences'

const NOT_SET = ''

interface RowProps {
  row: PreferenceRow
  /** Resolves to a message when the value was refused, null when it was saved. */
  onSet(value: string): Promise<string | null>
  onForget(): void
}

function Row({ row, onSet, onForget }: RowProps) {
  const saved = row.entry?.value ?? ''
  const [draft, setDraft] = useState(saved)
  const [error, setError] = useState<string | null>(null)

  // Follows changes made elsewhere: by voice, by Undo, or by "Forget preferences".
  useEffect(() => {
    setDraft(saved)
    setError(null)
  }, [saved])

  const commit = async (value: string): Promise<void> => {
    const next = value.trim()
    if (next === saved) {
      setError(null)
      return
    }
    if (next === NOT_SET) {
      onForget()
      return
    }
    setError(await onSet(next))
  }

  const id = `pref-${row.key}`
  return (
    <li className="pref-row">
      <div className="pref-head">
        <label htmlFor={id} className="pref-label">
          {row.label}
        </label>
        {row.entry && (
          <button className="pref-forget" onClick={onForget} aria-label={`Forget ${row.label}`}>
            Forget
          </button>
        )}
      </div>
      <p className="pref-hint">{row.hint}</p>
      {row.options ? (
        <select id={id} value={saved} onChange={(e) => void commit(e.target.value)}>
          <option value={NOT_SET}>Not set</option>
          {row.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type="text"
          value={draft}
          maxLength={row.maxLength}
          placeholder={row.key === 'userName' ? 'Tell ECHO “my name is …”, or type it here' : 'Not set'}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit(draft)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      )}
      {error && (
        <p className="pref-error" role="alert">
          {error}
        </p>
      )}
    </li>
  )
}

export function PreferencesWindow() {
  const [view, setView] = useState<PreferencesView | null>(null)

  useEffect(() => {
    let live = true
    const off = window.preferences.onEvent((event) => {
      if (live && event.type === 'changed') setView(event.view)
    })
    void window.preferences.get().then((v) => {
      if (live && v) setView(v)
    })
    return () => {
      live = false
      off()
    }
  }, [])

  const set = async (key: PreferenceRow['key'], value: string): Promise<string | null> => {
    const r = await window.preferences.command({ type: 'set', key, value })
    return r.ok ? null : r.reason
  }

  // Your name is about you, not about how ECHO teaches: it gets its own card, and "Forget" on the
  // preferences below never touches it.
  const you = view?.rows.filter((r) => r.permanent) ?? []
  const teaching = view?.rows.filter((r) => !r.permanent) ?? []
  const saved = teaching.filter((r) => r.entry).length
  const row = (r: PreferenceRow) => (
    <Row
      key={r.key}
      row={r}
      onSet={(value) => set(r.key, value)}
      onForget={() => void window.preferences.command({ type: 'forget', key: r.key })}
    />
  )

  return (
    <main className="prefs">
      <header className="prefs-header">
        <h1>What ECHO remembers</h1>
        <p>
          Who you are, and how you like to learn. Introduce yourself once and ECHO keeps your name for good. Tell ECHO
          “remember that I prefer diagrams” or “from now on, be less formal”, or set them here. They stay on this
          computer, and ECHO never keeps a record of what you say.
        </p>
      </header>

      <AccessSection />

      {view && (
        <>
          <div className="pref-scroll">
            <section className="pref-section">
              <h2>You</h2>
              <ul className="pref-list is-you">{you.map(row)}</ul>
            </section>
            <section className="pref-section">
              <h2>How ECHO teaches you</h2>
              <ul className="pref-list">{teaching.map(row)}</ul>
            </section>
          </div>
          <footer className="prefs-footer">
            <span>{saved === 0 ? 'No preferences saved yet.' : `${saved} saved · your name is kept`}</span>
            <button
              className="pref-forget-all"
              disabled={saved === 0}
              onClick={() => void window.preferences.command({ type: 'forget-all' })}
            >
              Forget preferences
            </button>
          </footer>
        </>
      )}
    </main>
  )
}
