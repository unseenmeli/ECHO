import { existsSync } from 'node:fs'
import { join } from 'node:path'

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

  ttsVoice: string

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
}

const num = (v: string | undefined, fallback: number, min: number, max: number): number => {
  if (v === undefined || v.trim() === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
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
      claudeMaxTokens: num(env.ECHO_CLAUDE_MAX_TOKENS, 400, 50, 4000),
      claudeDisableThinking: bool(env.ECHO_CLAUDE_DISABLE_THINKING, true),
      historyMessages: num(env.ECHO_HISTORY_MESSAGES, 24, 2, 200),
      sttModel: env.ECHO_STT_MODEL?.trim() || 'flux-general-en',
      eotThreshold: num(env.ECHO_EOT_THRESHOLD, 0.8, 0.5, 1),
      eagerEotThreshold: eager ? num(eager, 0.5, 0.3, 0.9) : null,
      eotTimeoutMs: num(env.ECHO_EOT_TIMEOUT_MS, 4000, 500, 60000),
      bargeInMs: env.ECHO_BARGE_IN_MS?.trim() === '0' ? 0 : num(env.ECHO_BARGE_IN_MS, 450, 150, 3000),
      ttsVoice: env.ECHO_TTS_VOICE?.trim() || 'aura-2-thalia-en',
      deepgramBase: (env.ECHO_DEEPGRAM_WS_BASE?.trim() || 'wss://api.deepgram.com').replace(/\/+$/, ''),
      logMetrics: bool(env.ECHO_LOG_METRICS, true),
      visualsEnabled: bool(env.ECHO_VISUALS, true),
    }
  }
}
