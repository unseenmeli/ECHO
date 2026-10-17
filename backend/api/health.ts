import { accessCodeCount } from '../lib/auth'
import { counterStore } from '../lib/store'

// GET /api/health: whether the server is configured. Says what is missing, never the values.
export function GET(): Response {
  const store = counterStore()
  const status = {
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    deepgram: !!process.env.DEEPGRAM_API_KEY,
    accessCodes: accessCodeCount(),
    usageStore: store?.kind ?? 'missing'
  }
  const ok = status.anthropic && status.deepgram && status.accessCodes > 0 && !!store
  return Response.json({ ok, ...status }, { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } })
}
