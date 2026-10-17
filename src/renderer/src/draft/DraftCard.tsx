import { useEffect, useState } from 'react'
import { DESTINATIONS, type Draft, type DraftEdits } from '../../../shared/compose'

/** An email or post ECHO wrote, editable, with Send (opens the compose page) and Cancel. */
export function DraftCard() {
  const [draft, setDraft] = useState<Draft | null>(null)

  useEffect(() => {
    const off = window.draft.onShow(setDraft)
    void window.draft.get().then((d) => d && setDraft(d))
    return off
  }, [])

  if (!draft) return null
  const dest = DESTINATIONS[draft.destination]
  const email = dest.kind === 'email'

  const change = (edits: DraftEdits): void => {
    setDraft({ ...draft, ...edits })
    window.draft.edit(draft.id, edits)
  }

  return (
    <main className="draft">
      <header className="draft-head">
        <span className="draft-kind">{email ? 'Email' : 'Post'}</span>
        <span className="draft-dest">{dest.label}</span>
      </header>

      {email && (
        <>
          <label className="draft-field">
            <span>To</span>
            <input value={draft.to} placeholder="name@example.com" onChange={(e) => change({ to: e.target.value })} />
          </label>
          <label className="draft-field">
            <span>Subject</span>
            <input value={draft.subject} onChange={(e) => change({ subject: e.target.value })} />
          </label>
        </>
      )}

      <textarea className="draft-body" value={draft.body} onChange={(e) => change({ body: e.target.value })} />

      <p className="draft-note">
        Say “send it” or press Send: ECHO opens {dest.label} with this filled in, and you press {email ? 'send' : 'post'} there.
      </p>

      <footer className="draft-actions">
        <button className="draft-btn" onClick={() => window.draft.answer(draft.id, false)}>
          Cancel
        </button>
        <button className="draft-btn is-primary" onClick={() => window.draft.answer(draft.id, true)}>
          Send
        </button>
      </footer>
    </main>
  )
}
