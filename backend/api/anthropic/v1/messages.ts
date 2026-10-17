import { waitUntil } from '@vercel/functions'
import { authenticate } from '../../../lib/auth'
import { mergeUsage, readPolicy, usageTap, validateMessagesRequest, type Usage } from '../../../lib/anthropic'
import { apiError, methodNotAllowed } from '../../../lib/http'
import { admitClaudeRequest, readLimits, recordTokens } from '../../../lib/limits'
import { counterStore } from '../../../lib/store'

// POST /api/anthropic/v1/messages: the Anthropic Messages API, behind a judge access code.
// ECHO points the Anthropic SDK here (baseURL .../api/anthropic), so streaming, tool calls and error types work
// exactly as against the real API, while the API key never leaves this server. When the app aborts a request,
// Vercel aborts request.signal (supportsCancellation in vercel.json) and the upstream request is cancelled with it.

const UPSTREAM = 'https://api.anthropic.com/v1/messages'
/** Vercel refuses request bodies over 4.5 MB; say so in the API's own words before it does. */
const MAX_BODY_BYTES = 4_400_000
const PASS_HEADERS = ['content-type', 'request-id', 'retry-after', 'x-should-retry']

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return apiError(503, 'api_error', 'The ECHO server has no Anthropic API key configured.')
  const caller = authenticate(request)
  if (!caller) return apiError(401, 'authentication_error', 'Invalid or missing ECHO access code.')
  const store = counterStore()
  if (!store) return apiError(503, 'api_error', 'The ECHO server has no usage store connected (see backend/README.md).')

  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return apiError(413, 'request_too_large', 'Request too large for the ECHO server (4.5 MB limit).')
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return apiError(400, 'invalid_request_error', 'The request body is not valid JSON.')
  }
  const check = validateMessagesRequest(body, readPolicy())
  if (!check.ok) return apiError(400, 'invalid_request_error', check.message)

  const admitted = await admitClaudeRequest(store, caller.label, readLimits())
  if (!admitted.ok) {
    return apiError(429, 'rate_limit_error', admitted.message, admitted.retryAfter ? { 'retry-after': String(admitted.retryAfter), 'x-should-retry': 'true' } : {})
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': request.headers.get('anthropic-version') ?? '2023-06-01'
  }
  if (process.env.ANTHROPIC_WORKSPACE_ID) headers['anthropic-workspace-id'] = process.env.ANTHROPIC_WORKSPACE_ID

  let upstream: Response
  try {
    upstream = await fetch(UPSTREAM, { method: 'POST', headers, body: text, signal: request.signal })
  } catch {
    if (request.signal.aborted) return new Response(null, { status: 499 })
    return apiError(502, 'api_error', 'The ECHO server could not reach Anthropic.', { 'x-should-retry': 'true' })
  }

  const out = new Headers()
  for (const h of PASS_HEADERS) {
    const v = upstream.headers.get(h)
    if (v) out.set(h, v)
  }
  const record = (usage: Usage): void => {
    if (usage.input || usage.output) waitUntil(recordTokens(store, caller.label, usage).catch(() => {}))
  }

  // Errors and non-streamed replies are small: read the usage from the JSON.
  if (!upstream.ok || !check.stream || !upstream.body) {
    const reply = await upstream.text()
    if (upstream.ok) {
      try {
        const usage: Usage = { input: 0, output: 0 }
        mergeUsage(usage, (JSON.parse(reply) as { usage?: Parameters<typeof mergeUsage>[1] }).usage)
        record(usage)
      } catch {
        // No usage to record.
      }
    }
    return new Response(reply, { status: upstream.status, headers: out })
  }

  // Streamed: pass the events through as they arrive, counting tokens on the way.
  const tap = usageTap(record)
  request.signal.addEventListener('abort', tap.finish, { once: true })
  const stream = upstream.body.pipeThrough(tap.stream)
  out.set('cache-control', 'no-cache, no-transform')
  return new Response(stream, { status: upstream.status, headers: out })
}

export function GET(): Response {
  return methodNotAllowed('POST')
}
