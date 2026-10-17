import { useEffect, useState, type FormEvent } from 'react'
import type { AccessInfo } from '../../../shared/access'

/** The judge access code for ECHO's server. Only shown when the app was set up to use one. */
export function AccessSection() {
  const [info, setInfo] = useState<AccessInfo | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    void window.access.get().then(setInfo)
  }, [])

  if (!info?.server) return null

  const reset = async (): Promise<void> => {
    setResult(await window.access.set(''))
    setInfo(await window.access.get())
  }

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    const r = await window.access.set(code)
    setBusy(false)
    setResult(r)
    if (r.ok) {
      setCode('')
      setInfo(await window.access.get())
    }
  }

  return (
    <section className="access">
      <h2>Access code</h2>
      <p>
        ECHO runs through {info.server}.{' '}
        {info.builtInCode ? (
          <>
            Using the built-in code <code className="access-code">{info.builtInCode}</code>, so there is nothing to enter.
          </>
        ) : (
          <>
            Using your own code.{' '}
            <button type="button" className="access-reset" onClick={() => void reset()}>
              Use the built-in code
            </button>
          </>
        )}
      </p>
      <form className="access-form" onSubmit={(e) => void save(e)}>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="Use a different code (optional)"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button type="submit" disabled={busy || !code.trim()}>
          {busy ? 'Checking…' : 'Save'}
        </button>
      </form>
      {result && <p className={`access-result${result.ok ? '' : ' is-error'}`}>{result.message}</p>}
    </section>
  )
}
