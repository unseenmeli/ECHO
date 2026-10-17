import { authenticate } from '../lib/auth'
import { apiError } from '../lib/http'
import { readLimits, usageSummary } from '../lib/limits'
import { counterStore } from '../lib/store'

// GET /api/usage: what this access code has used today, and its limits. Also a quick way to check a code works.
export async function GET(request: Request): Promise<Response> {
  const caller = authenticate(request)
  if (!caller) return apiError(401, 'authentication_error', 'Invalid or missing ECHO access code.')
  const store = counterStore()
  if (!store) return apiError(503, 'api_error', 'The ECHO server has no usage store connected (see backend/README.md).')
  return Response.json(await usageSummary(store, caller.label, readLimits()), { headers: { 'cache-control': 'no-store' } })
}
