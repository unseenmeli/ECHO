import type { CounterStore } from './counters'

// Usage limits per access code (per UTC day, plus a per-minute burst limit) and one overall daily cap across every
// code, as a backstop for the provider bills. All are read from the environment; the defaults suit a few judges
// trying ECHO for an evening each.

export interface Limits {
  requestsPerMinute: number
  requestsPerDay: number
  inputTokensPerDay: number
  outputTokensPerDay: number
  deepgramTokensPerDay: number
  globalRequestsPerDay: number
}

const int = (v: string | undefined, fallback: number): number => {
  const n = Number(v)
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

export function readLimits(env: Record<string, string | undefined> = process.env): Limits {
  return {
    requestsPerMinute: int(env.ECHO_LIMIT_REQUESTS_PER_MINUTE, 30),
    requestsPerDay: int(env.ECHO_LIMIT_REQUESTS_PER_DAY, 600),
    inputTokensPerDay: int(env.ECHO_LIMIT_INPUT_TOKENS_PER_DAY, 4_000_000),
    outputTokensPerDay: int(env.ECHO_LIMIT_OUTPUT_TOKENS_PER_DAY, 300_000),
    deepgramTokensPerDay: int(env.ECHO_LIMIT_DEEPGRAM_TOKENS_PER_DAY, 200),
    globalRequestsPerDay: int(env.ECHO_GLOBAL_REQUESTS_PER_DAY, 5_000)
  }
}

const DAY_TTL = 2 * 24 * 3600
const MINUTE_TTL = 120

const day = (now: number): string => new Date(now).toISOString().slice(0, 10)
const minute = (now: number): string => new Date(now).toISOString().slice(0, 16)

export const keys = {
  requests: (label: string, now: number) => `echo:${day(now)}:${label}:requests`,
  minute: (label: string, now: number) => `echo:${minute(now)}:${label}:rpm`,
  input: (label: string, now: number) => `echo:${day(now)}:${label}:input`,
  output: (label: string, now: number) => `echo:${day(now)}:${label}:output`,
  deepgram: (label: string, now: number) => `echo:${day(now)}:${label}:deepgram`,
  global: (now: number) => `echo:${day(now)}:global:requests`
}

export type LimitResult = { ok: true } | { ok: false; message: string; retryAfter?: number }

const untilTomorrow = (now: number): number => {
  const d = new Date(now)
  return Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000)
}

/**
 * Counts one Claude request against the caller and refuses it once a limit is reached. Token limits are checked
 * against what was used so far (a request's own tokens are only known once it finishes; see recordTokens).
 */
export async function admitClaudeRequest(store: CounterStore, label: string, limits: Limits, now = Date.now()): Promise<LimitResult> {
  const [input, output] = await store.get([keys.input(label, now), keys.output(label, now)])
  if (input >= limits.inputTokensPerDay || output >= limits.outputTokensPerDay) {
    return { ok: false, message: 'This access code has used its tokens for today. It resets at midnight UTC.' }
  }
  const [perMinute, perDay, global] = await Promise.all([
    store.incr(keys.minute(label, now), 1, MINUTE_TTL),
    store.incr(keys.requests(label, now), 1, DAY_TTL),
    store.incr(keys.global(now), 1, DAY_TTL)
  ])
  if (perDay > limits.requestsPerDay) {
    return { ok: false, message: 'This access code has reached its requests for today. It resets at midnight UTC.' }
  }
  if (global > limits.globalRequestsPerDay) {
    return { ok: false, message: 'ECHO has reached its overall limit for today. Please try again tomorrow.' }
  }
  if (perMinute > limits.requestsPerMinute) {
    return { ok: false, message: 'Too many requests this minute. Wait a moment.', retryAfter: 60 - new Date(now).getUTCSeconds() }
  }
  return { ok: true }
}

export async function recordTokens(store: CounterStore, label: string, usage: { input: number; output: number }, now = Date.now()): Promise<void> {
  await Promise.all([
    usage.input > 0 ? store.incr(keys.input(label, now), usage.input, DAY_TTL) : null,
    usage.output > 0 ? store.incr(keys.output(label, now), usage.output, DAY_TTL) : null
  ])
}

export async function admitDeepgramToken(store: CounterStore, label: string, limits: Limits, now = Date.now()): Promise<LimitResult> {
  const used = await store.incr(keys.deepgram(label, now), 1, DAY_TTL)
  return used > limits.deepgramTokensPerDay
    ? { ok: false, message: 'This access code has reached its voice sessions for today. It resets at midnight UTC.' }
    : { ok: true }
}

export async function usageSummary(store: CounterStore, label: string, limits: Limits, now = Date.now()) {
  const [requests, input, output, deepgram] = await store.get([
    keys.requests(label, now),
    keys.input(label, now),
    keys.output(label, now),
    keys.deepgram(label, now)
  ])
  return {
    label,
    day: day(now),
    resetsInSeconds: untilTomorrow(now),
    used: { requests, inputTokens: input, outputTokens: output, deepgramTokens: deepgram },
    limits: {
      requests: limits.requestsPerDay,
      inputTokens: limits.inputTokensPerDay,
      outputTokens: limits.outputTokensPerDay,
      deepgramTokens: limits.deepgramTokensPerDay,
      requestsPerMinute: limits.requestsPerMinute
    }
  }
}
