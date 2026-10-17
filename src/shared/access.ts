// The judge access code, as the Preferences window sees it. The code itself never goes back to a window.

export interface AccessInfo {
  /** Host of ECHO's server, or null when the app uses keys from .env (development). */
  server: string | null
  hasCode: boolean
}

export interface AccessSaveResult {
  ok: boolean
  message: string
}
