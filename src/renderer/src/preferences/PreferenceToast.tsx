import { useEffect, useState } from 'react'
import type { PreferenceToast as Toast } from '../../../shared/preferences'
import './preferenceToast.css'

const VISIBLE_MS = 6000

/**
 * A subtle "Preference saved · Undo" note. It appears when ECHO saves or forgets a preference, goes away by
 * itself, and Undo restores exactly what was there before.
 */
export function PreferenceToast({ className = '' }: { className?: string }) {
  const [toast, setToast] = useState<Toast | null>(null)

  useEffect(() => {
    return window.preferences.onEvent((event) => {
      if (event.type === 'toast') setToast(event.toast)
    })
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), VISIBLE_MS)
    return () => window.clearTimeout(timer)
  }, [toast])

  if (!toast) return null
  return (
    <div className={`pref-toast ${className}`} role="status" aria-live="polite">
      <span>{toast.message}</span>
      <span className="pref-toast-sep" aria-hidden="true">
        ·
      </span>
      <button
        className="pref-toast-undo"
        onClick={() => {
          void window.preferences.command({ type: 'undo', id: toast.id })
          setToast(null)
        }}
      >
        Undo
      </button>
    </div>
  )
}
