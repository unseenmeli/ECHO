import { authenticate } from '../../lib/auth'
import { apiError, methodNotAllowed } from '../../lib/http'
import { admitDeepgramToken, readLimits } from '../../lib/limits'
import { counterStore } from '../../lib/store'

// POST /api/deepgram/token: a short-lived Deepgram token for one judge, so ECHO can open its speech-to-text and
// text-to-speech sockets straight to Deepgram (no audio passes through this server) without holding the API key.
// A token is only checked when a socket opens; open sockets keep working after it expires.

const GRANT_URL = 'https://api.deepgram.com/v1/auth/grant'

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.DEEPGRAM_API_KEY
  if (!apiKey) return apiError(503, 'api_error', 'The ECHO server has no Deepgram API key configured.')
  const caller = authenticate(request)
  if (!caller) return apiError(401, 'authentication_error', 'Invalid or missing ECHO access code.')
  const store = counterStore()
  if (!store) return apiError(503, 'api_error', 'The ECHO server has no usage store connected (see backend/README.md).')

  const admitted = await admitDeepgramToken(store, caller.label, readLimits())
  if (!admitted.ok) return apiError(429, 'rate_limit_error', admitted.message)

  const ttl = Math.min(3600, Math.max(30, Number(process.env.ECHO_DEEPGRAM_TOKEN_TTL) || 60))
  let grant: Response
  try {
    grant = await fetch(GRANT_URL, {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: ttl }),
      signal: request.signal
    })
  } catch {
    return apiError(502, 'api_error', 'The ECHO server could not reach Deepgram.', { 'x-should-retry': 'true' })
  }
  if (!grant.ok) {
    // Don't echo Deepgram's response: it can describe the server's key.
    console.error(`[deepgram] grant failed with HTTP ${grant.status}`)
    return apiError(502, 'api_error', `Deepgram refused to issue a token (HTTP ${grant.status}).`)
  }
  const { access_token, expires_in } = (await grant.json()) as { access_token?: string; expires_in?: number }
  if (!access_token) return apiError(502, 'api_error', 'Deepgram returned no token.')
  return Response.json({ access_token, expires_in: expires_in ?? ttl }, { headers: { 'cache-control': 'no-store' } })
}

export function GET(): Response {
  return methodNotAllowed('POST')
}
