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
        ECHO runs through {info.server}. {info.hasCode ? 'A code is saved on this computer.' : 'Enter the access code you were given.'}
      </p>
      <form className="access-form" onSubmit={(e) => void save(e)}>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={info.hasCode ? 'Replace the saved code' : 'XXXX-XXXX-XXXX'}
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
