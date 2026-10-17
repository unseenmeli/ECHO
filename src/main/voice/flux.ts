import WebSocket from 'ws'
import type { VoiceConfig } from './config'
import type { LinkStatus, SttHooks, SttPort, TurnEventName, TurnInfo } from './ports'
import { MIC_SAMPLE_RATE } from '../../shared/voice'

const MAX_ATTEMPTS = 6
const BACKOFF_BASE_MS = 300
const BACKOFF_MAX_MS = 5000

const TURN_EVENTS = new Set<string>(['StartOfTurn', 'Update', 'EagerEndOfTurn', 'TurnResumed', 'EndOfTurn'])

/**
 * Deepgram Flux streaming speech-to-text (`/v2/listen`). Flux models whole
 * conversational turns, so the session sees "turn started" / "turn ended"
 * instead of having to guess from silence.
 */
export class FluxClient implements SttPort {
  private ws: WebSocket | null = null
  private wanted = false
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private open = false

  constructor(
    private readonly cfg: VoiceConfig,
    private readonly hooks: SttHooks
  ) {}

  connect(): void {
    this.wanted = true
    this.attempt = 0
    this.openSocket()
  }

  private url(): string {
    const q = new URLSearchParams({
      model: this.cfg.sttModel,
      encoding: 'linear16',
      sample_rate: String(MIC_SAMPLE_RATE),
      eot_threshold: String(this.cfg.eotThreshold),
      eot_timeout_ms: String(this.cfg.eotTimeoutMs)
    })
    if (this.cfg.eagerEotThreshold !== null) q.set('eager_eot_threshold', String(this.cfg.eagerEotThreshold))
    return `${this.cfg.deepgramBase}/v2/listen?${q.toString()}`
  }

  private openSocket(): void {
    const ws = new WebSocket(this.url(), { headers: { Authorization: `Token ${this.cfg.deepgramApiKey}` } })
    this.ws = ws
    this.open = false

    ws.on('open', () => {
      if (this.ws !== ws) return
      this.open = true
      this.attempt = 0
      this.hooks.onStatus({ kind: 'connected' })
    })

    ws.on('message', (data, isBinary) => {
      if (this.ws !== ws || isBinary) return
      this.handleMessage(data.toString())
    })

    ws.on('unexpected-response', (_req, res) => {
      // HTTP-level rejection of the upgrade: bad key / no access / rate limited.
      const status = res.statusCode ?? 0
      res.resume()
      if (this.ws !== ws) return
      this.ws = null
      if (status === 401 || status === 403) {
        this.fatal('Deepgram rejected the API key (check DEEPGRAM_API_KEY).')
      } else if (status === 429) {
        this.fatal('Deepgram rate limit reached. Wait a moment and try again.')
      } else {
        this.retry(`Deepgram returned HTTP ${status}`)
      }
    })

    ws.on('error', () => {
      // 'close' follows; reconnect handling lives there.
    })

    ws.on('close', () => {
      if (this.ws !== ws) return
      this.ws = null
      this.open = false
      if (this.wanted) this.retry('Speech recognition connection lost')
    })
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    if (msg.type === 'Error') {
      const code = String(msg.code ?? '')
      this.fatal(`Speech recognition error${code ? ` (${code})` : ''}.`)
      return
    }
    // Flux reports turn updates as TurnInfo messages carrying an `event` field.
    const event = msg.event
    if (typeof event === 'string' && TURN_EVENTS.has(event)) {
      const info: TurnInfo = {
        event: event as TurnEventName,
        turnIndex: typeof msg.turn_index === 'number' ? msg.turn_index : 0,
        transcript: typeof msg.transcript === 'string' ? msg.transcript : '',
        ...(Array.isArray(msg.words) ? { words: parseWords(msg.words) } : {})
      }
      this.hooks.onTurn(info)
    }
  }

  private retry(reason: string): void {
    if (!this.wanted) return
    if (this.attempt >= MAX_ATTEMPTS) {
      this.fatal(`${reason}. Gave up after ${MAX_ATTEMPTS} attempts.`)
      return
    }
    this.attempt += 1
    const status: LinkStatus = { kind: 'reconnecting', attempt: this.attempt }
    this.hooks.onStatus(status)
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.attempt - 1))
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.wanted) this.openSocket()
    }, delay)
  }

  private fatal(message: string): void {
    this.wanted = false
    this.teardown()
    this.hooks.onStatus({ kind: 'fatal', message })
  }

  sendAudio(pcm16: Buffer): void {
    if (this.open && this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm16)
  }

  forceEndTurn(): void {
    if (this.open && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'ForceEndTurn' }))
  }

  close(): void {
    this.wanted = false
    const ws = this.ws
    if (ws && this.open && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'CloseStream' }))
      } catch {
        // already closing
      }
    }
    this.teardown()
  }

  private teardown(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const ws = this.ws
    this.ws = null
    this.open = false
    if (ws) {
      ws.removeAllListeners()
      ws.on('error', () => {})
      try {
        ws.close()
      } catch {
        // ignore
      }
      // Don't leave a half-closed socket lingering if the peer never answers.
      setTimeout(() => ws.terminate(), 1000).unref()
    }
  }
}

/** Flux's per-word results (`TurnInfo.words`: `{ word, confidence, start, end }`). Anything malformed is skipped. */
function parseWords(raw: unknown[]): Array<{ word: string; confidence: number }> {
  const out: Array<{ word: string; confidence: number }> = []
  for (const w of raw) {
    if (!w || typeof w !== 'object') continue
    const { word, confidence } = w as { word?: unknown; confidence?: unknown }
    // The schema declares confidence a string ("float"); SDKs treat it as a number. Accept both.
    const c = typeof confidence === 'number' ? confidence : typeof confidence === 'string' ? Number(confidence) : NaN
    if (typeof word === 'string' && Number.isFinite(c)) out.push({ word, confidence: c })
  }
  return out
}
