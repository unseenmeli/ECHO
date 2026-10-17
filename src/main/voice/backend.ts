import type { VoiceConfig } from './config'

/** Where ECHO's server is, and the judge access code it accepts. Provider keys stay on the server. */
export interface BackendConfig {
  /** e.g. https://echo-backend.vercel.app (no trailing slash). */
  url: string
  accessCode: string
}

/** How the speech sockets authenticate: the Authorization header value, fetched fresh for each connection. */
export interface DeepgramAuth {
  header(): Promise<string>
  /** What to tell the user when Deepgram refuses the socket's credentials. */
  rejectedMessage: string
}

export class DeepgramAuthError extends Error {
  constructor(
    message: string,
    /** Retrying won't help (bad access code, daily limit reached). */
    readonly fatal: boolean
  ) {
    super(message)
  }
}

/** Direct mode (development): the Deepgram key from .env. */
export function keyAuth(apiKey: string): DeepgramAuth {
  return {
    header: async () => `Token ${apiKey}`,
    rejectedMessage: 'Deepgram rejected the API key (check DEEPGRAM_API_KEY).'
  }
}

/** The message in an Anthropic-shaped error body ({ error: { message } }), if there is one. */
async function serverMessage(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } }
    return typeof body.error?.message === 'string' ? body.error.message : null
  } catch {
    return null
  }
}

export const ACCESS_CODE_REJECTED = "The ECHO server didn't accept your access code. Check it in ECHO's Preferences."

/**
 * Backend mode: a short-lived Deepgram token from ECHO's server for each socket. The speech-to-text and
 * text-to-speech sockets open at about the same time, so a token is reused until shortly before it expires.
 */
export function backendDeepgramAuth(backend: BackendConfig, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): DeepgramAuth {
  let cached: { header: string; until: number } | null = null
  let inFlight: Promise<string> | null = null

  const request = async (): Promise<string> => {
    let res: Response
    try {
      res = await fetchImpl(`${backend.url}/api/deepgram/token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${backend.accessCode}` },
        signal: AbortSignal.timeout(10_000)
      })
    } catch {
      throw new DeepgramAuthError("Couldn't reach the ECHO server for a voice connection.", false)
    }
    if (res.status === 401) throw new DeepgramAuthError(ACCESS_CODE_REJECTED, true)
    if (res.status === 429) throw new DeepgramAuthError((await serverMessage(res)) ?? 'Voice limit reached for today.', true)
    if (!res.ok) throw new DeepgramAuthError((await serverMessage(res)) ?? `The ECHO server returned HTTP ${res.status}.`, false)
    const { access_token, expires_in } = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!access_token) throw new DeepgramAuthError('The ECHO server returned no voice token.', false)
    const header = `Bearer ${access_token}`
    cached = { header, until: now() + Math.max(0, (expires_in ?? 30) - 15) * 1000 }
    return header
  }

  return {
    header: () => {
      if (cached && now() < cached.until) return Promise.resolve(cached.header)
      inFlight ??= request().finally(() => (inFlight = null))
      return inFlight
    },
    rejectedMessage: 'Deepgram rejected the voice token from the ECHO server. Try again, or check the server.'
  }
}

export function deepgramAuthFor(cfg: VoiceConfig): DeepgramAuth {
  return cfg.backend ? backendDeepgramAuth(cfg.backend) : keyAuth(cfg.deepgramApiKey)
}
