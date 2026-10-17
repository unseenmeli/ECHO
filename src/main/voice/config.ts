import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { EFFORTS, type Effort } from './ports'
import { parseQualityRoutes, type QualityRoute } from './routing'
import { DESTINATION_IDS, isDestination, type DestinationId } from '../../shared/compose'

// Everything tunable lives here and is read from the environment, so models,
// voice and turn-detection can change without touching code. Credentials are
// only ever read in the main process and are never logged or sent to a window.

export interface VoiceConfig {
  anthropicApiKey: string
  /** Needed only when the API key is not scoped to a single workspace. */
  anthropicWorkspaceId: string | null
  deepgramApiKey: string

  claudeModel: string
  /** Model for deep-dive lessons, where depth matters more than the first word arriving fast. */
  deepModel: string
  /** Model for short questions that need real reasoning (debugging, comparisons, maths, "I still don't get it"). */
  strongModel: string
  /** Send hard questions to strongModel even when nobody asked for a deep dive. */
  smartRouting: boolean
  /** Which kinds of turn go to strongModel: reasoning, screen, lesson, practice, follow-up. */
  qualityRoutes: Set<QualityRoute>
  /** Whether strongModel may think before answering (adaptive), and how hard it works. */
  strongThinking: 'adaptive' | 'off'
  strongEffort: Effort
  /** How hard deepModel works on a deep dive (it always thinks first). */
  deepEffort: Effort
  claudeMaxTokens: number
  /** Thinking adds latency before the first spoken word; turn it off where the model allows it. */
  claudeDisableThinking: boolean
  /** Messages (not turns) of history sent to Claude. */
  historyMessages: number

  /** Flux (conversational turn detection). `flux-general-en` is English; `flux-general-multi` is multilingual. */
  sttModel: string
  /** Confidence needed to end a turn (0.5–1.0). Higher = waits longer through pauses. */
  eotThreshold: number
  /** Optional: enables EagerEndOfTurn/TurnResumed events (more Claude calls if used speculatively). */
  eagerEotThreshold: number | null
  /** Silence after which a turn is force-ended (500–60000). */
  eotTimeoutMs: number
  /** Words recognized with less confidence than this are flagged to the model as possibly misheard (0 = off). */
  sttUnsureConfidence: number

  ttsVoice: string
  /** Characters the first spoken piece waits for, and the size of later groups (each group is voiced as one unit). */
  ttsFirstChars: number
  ttsGroupChars: number

  /**
   * Speech (ms) the local VAD must hear while ECHO talks before ECHO stops, even if
   * Deepgram hasn't reported a turn yet. Higher = harder to interrupt by accident.
   * 0 disables it, leaving only Deepgram's own turn detection.
   */
  bargeInMs: number
  /** Deepgram websocket base, overridable for tests. */
  deepgramBase: string

  logMetrics: boolean

  /** Whiteboard visuals alongside the spoken lesson (needs the lesson window open). */
  visualsEnabled: boolean
  /** Let the whiteboard show real pictures, looked up on Wikimedia Commons. */
  picturesEnabled: boolean

  /** Let ECHO search the web (Anthropic's server-side web search tool) for facts it should not answer from memory. */
  webSearchEnabled: boolean
  /** Most searches in one quick answer, and in one deep dive (which researches before it teaches). */
  webSearchMaxUses: number
  webSearchDeepMaxUses: number
  /** Let ECHO read whole pages from its search results (Anthropic's web fetch tool) instead of answering from snippets. */
  webFetchEnabled: boolean
  /** Most pages read in a quick answer, and in a deep dive. */
  webFetchMaxUses: number
  webFetchDeepMaxUses: number
  /** Longest page text (tokens) the model reads from one page; longer pages are cut. */
  webFetchMaxTokens: number
  /** Offer Anthropic's hosted code execution (on Anthropic's servers) for checking calculations and examples. */
  codeExecutionEnabled: boolean
  /** Where ECHO may open drafted emails and posts (empty: drafting is off). */
  composeDestinations: DestinationId[]
}

const num = (v: string | undefined, fallback: number, min: number, max: number): number => {
  if (v === undefined || v.trim() === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

const effort = (v: string | undefined, fallback: Effort): Effort => {
  const e = v?.trim().toLowerCase()
  return (EFFORTS as readonly string[]).includes(e ?? '') ? (e as Effort) : fallback
}

/** "gmail,x" → those destinations, in order; "none" → none; unset → all. */
export function parseDestinations(v: string | undefined): DestinationId[] {
  const raw = v?.trim().toLowerCase()
  if (!raw) return [...DESTINATION_IDS]
  if (raw === 'none' || raw === 'off') return []
  return [...new Set(raw.split(/[\s,]+/).filter(isDestination))]
}

const bool = (v: string | undefined, fallback: boolean): boolean => {
  if (v === undefined || v.trim() === '') return fallback
  return /^(1|true|yes|on)$/i.test(v.trim())
}

/** Loads `.env` files (never overriding variables already set in the real environment). */
export function loadEnvFiles(dirs: string[]): void {
  for (const dir of dirs) {
    const file = join(dir, '.env')
    if (existsSync(file)) {
      try {
        process.loadEnvFile(file)
      } catch {
        // Malformed .env: ignore rather than crash; missing keys are reported at session start.
      }
    }
  }
}

export type ConfigResult = { ok: true; config: VoiceConfig } | { ok: false; message: string }

export function readVoiceConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const anthropicApiKey = (env.ANTHROPIC_API_KEY ?? '').trim()
  const deepgramApiKey = (env.DEEPGRAM_API_KEY ?? '').trim()

  const missing = [
    !anthropicApiKey && 'ANTHROPIC_API_KEY',
    !deepgramApiKey && 'DEEPGRAM_API_KEY'
  ].filter(Boolean)
  if (missing.length) {
    return { ok: false, message: `Missing ${missing.join(' and ')} in .env — add your key(s) and restart ECHO.` }
  }

  const eager = env.ECHO_EAGER_EOT_THRESHOLD?.trim()

  return {
    ok: true,
    config: {
      anthropicApiKey,
      anthropicWorkspaceId: env.ANTHROPIC_WORKSPACE_ID?.trim() || null,
      deepgramApiKey,
      claudeModel: env.ECHO_CLAUDE_MODEL?.trim() || 'claude-haiku-5-5',
      deepModel: env.ECHO_DEEP_MODEL?.trim() || 'claude-sonnet-5-5',
      strongModel: env.ECHO_STRONG_MODEL?.trim() || env.ECHO_DEEP_MODEL?.trim() || 'claude-sonnet-5-5',
      smartRouting: bool(env.ECHO_SMART_ROUTING, true),
      qualityRoutes: parseQualityRoutes(env.ECHO_QUALITY_ROUTES),
      strongThinking: /^(off|false|0|no)$/i.test(env.ECHO_STRONG_THINKING?.trim() ?? '') ? 'off' : 'adaptive',
      strongEffort: effort(env.ECHO_STRONG_EFFORT, 'high'),
      deepEffort: effort(env.ECHO_DEEP_EFFORT, 'high'),
      claudeMaxTokens: num(env.ECHO_CLAUDE_MAX_TOKENS, 1200, 50, 4000),
      claudeDisableThinking: bool(env.ECHO_CLAUDE_DISABLE_THINKING, true),
      historyMessages: num(env.ECHO_HISTORY_MESSAGES, 24, 2, 200),
      sttModel: env.ECHO_STT_MODEL?.trim() || 'flux-general-en',
      eotThreshold: num(env.ECHO_EOT_THRESHOLD, 0.8, 0.5, 1),
      eagerEotThreshold: eager ? num(eager, 0.5, 0.3, 0.9) : null,
      eotTimeoutMs: num(env.ECHO_EOT_TIMEOUT_MS, 4000, 500, 60000),
      sttUnsureConfidence: num(env.ECHO_STT_UNSURE_CONFIDENCE, 0.6, 0, 1),
      bargeInMs: env.ECHO_BARGE_IN_MS?.trim() === '0' ? 0 : num(env.ECHO_BARGE_IN_MS, 450, 150, 3000),
      ttsVoice: env.ECHO_TTS_VOICE?.trim() || 'aura-2-thalia-en',
      ttsFirstChars: num(env.ECHO_TTS_FIRST_CHARS, 40, 10, 200),
      ttsGroupChars: num(env.ECHO_TTS_GROUP_CHARS, 220, 60, 1200),
      deepgramBase: (env.ECHO_DEEPGRAM_WS_BASE?.trim() || 'wss://api.deepgram.com').replace(/\/+$/, ''),
      logMetrics: bool(env.ECHO_LOG_METRICS, true),
      visualsEnabled: bool(env.ECHO_VISUALS, true),
      picturesEnabled: bool(env.ECHO_PICTURES, true),
      webSearchEnabled: bool(env.ECHO_WEB_SEARCH, true),
      webSearchMaxUses: num(env.ECHO_WEB_SEARCH_MAX_USES, 2, 1, 10),
      webSearchDeepMaxUses: num(env.ECHO_WEB_SEARCH_DEEP_MAX_USES, 5, 1, 15),
      webFetchEnabled: bool(env.ECHO_WEB_FETCH, true),
      webFetchMaxUses: num(env.ECHO_WEB_FETCH_MAX_USES, 1, 1, 5),
      webFetchDeepMaxUses: num(env.ECHO_WEB_FETCH_DEEP_MAX_USES, 3, 1, 10),
      webFetchMaxTokens: num(env.ECHO_WEB_FETCH_MAX_TOKENS, 8000, 1000, 50000),
      codeExecutionEnabled: bool(env.ECHO_CODE_EXECUTION, true),
      composeDestinations: parseDestinations(env.ECHO_COMPOSE_DESTINATIONS),
    }
  }
}
