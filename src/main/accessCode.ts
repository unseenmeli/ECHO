import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { ipcMain, safeStorage, type BrowserWindow, type WebContents } from 'electron'
import { parseBackendUrl } from './voice/config'
import type { AccessInfo, AccessSaveResult } from '../shared/access'

/** The judge access code, kept in the user-data folder and encrypted with the OS keychain when available. */
export class AccessCodeStore {
  private code: string | null | undefined

  constructor(private readonly file: string) {}

  get(): string | null {
    if (this.code !== undefined) return this.code
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { encrypted?: boolean; value?: string }
      this.code = !saved.value ? null : saved.encrypted ? safeStorage.decryptString(Buffer.from(saved.value, 'base64')) : saved.value
    } catch {
      this.code = null
    }
    return this.code
  }

  set(code: string | null): void {
    this.code = code
    if (!code) {
      rmSync(this.file, { force: true })
      return
    }
    const encrypted = safeStorage.isEncryptionAvailable()
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(
      this.file,
      JSON.stringify({ encrypted, value: encrypted ? safeStorage.encryptString(code).toString('base64') : code }),
      { mode: 0o600 }
    )
  }
}

/** The server address: from the environment (development) or baked in at build time (MAIN_VITE_ECHO_BACKEND_URL). */
export function backendUrl(): string {
  return process.env.ECHO_BACKEND_URL?.trim() || import.meta.env.MAIN_VITE_ECHO_BACKEND_URL?.trim() || ''
}

/** Asks the server whether the code works (GET /api/usage). null: couldn't reach it. */
async function checkCode(url: string, code: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${url}/api/usage`, { headers: { Authorization: `Bearer ${code}` }, signal: AbortSignal.timeout(8000) })
    return res.status === 401 ? false : res.ok ? true : null
  } catch {
    return null
  }
}

/** Lets the app's own windows see whether a code is needed and save one. The code itself is never sent back. */
export function registerAccessIpc(store: AccessCodeStore, windows: () => BrowserWindow[]): void {
  const isAppWindow = (wc: WebContents): boolean => windows().some((w) => w.webContents === wc)

  ipcMain.handle('access:get', (event): AccessInfo | null => {
    if (!isAppWindow(event.sender)) return null
    const url = parseBackendUrl(backendUrl())
    return { server: typeof url === 'string' ? new URL(url).host : null, hasCode: !!store.get() || !!process.env.ECHO_ACCESS_CODE }
  })

  ipcMain.handle('access:set', async (event, raw: unknown): Promise<AccessSaveResult> => {
    if (!isAppWindow(event.sender)) return { ok: false, message: 'Not allowed.' }
    const code = typeof raw === 'string' ? raw.trim() : ''
    if (code.length > 200) return { ok: false, message: 'That code is too long.' }
    if (!code) {
      store.set(null)
      return { ok: true, message: 'Access code removed.' }
    }
    const url = parseBackendUrl(backendUrl())
    if (typeof url === 'string') {
      const works = await checkCode(url, code)
      if (works === false) return { ok: false, message: "That code wasn't accepted. Check it and try again." }
      store.set(code)
      return { ok: true, message: works ? 'Saved. Start a conversation to use it.' : "Saved, but the ECHO server couldn't be reached to check it." }
    }
    store.set(code)
    return { ok: true, message: 'Saved.' }
  })
}
