// The judge access code, as the Preferences window sees it. A code the user saved never goes back to a window; the
// built-in demo code is public, so it is shown.

export interface AccessInfo {
  /** Host of ECHO's server, or null when the app uses keys from .env (development). */
  server: string | null
  hasCode: boolean
  /** The built-in demo code, when it is the one in use (nothing saved). */
  builtInCode: string | null
}

export interface AccessSaveResult {
  ok: boolean
  message: string
}
