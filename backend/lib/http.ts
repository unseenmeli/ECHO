// Errors in the Anthropic API's own shape, so the Anthropic SDK in the app raises its usual typed errors
// (AuthenticationError, RateLimitError, ...) for problems this server finds too.

export type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'request_too_large'
  | 'rate_limit_error'
  | 'api_error'
  | 'overloaded_error'

export function apiError(status: number, type: ErrorType, message: string, headers: Record<string, string> = {}): Response {
  return Response.json(
    { type: 'error', error: { type, message } },
    // Most of these won't succeed on a retry; the SDK honors x-should-retry.
    { status, headers: { 'x-should-retry': 'false', ...headers } }
  )
}

export function methodNotAllowed(allowed: string): Response {
  return apiError(405, 'invalid_request_error', `Use ${allowed}.`, { allow: allowed })
}
