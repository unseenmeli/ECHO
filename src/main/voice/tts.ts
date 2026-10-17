import WebSocket from 'ws'
import type { VoiceConfig } from './config'
import { DeepgramAuthError, keyAuth, type DeepgramAuth } from './backend'
import type { TtsHooks, TtsPort } from './ports'
import { TTS_SAMPLE_RATE } from '../../shared/voice'

// Deepgram TTS limits (docs): 20 flushes / 60 s, 2000 chars per Speak message.
const FLUSH_WINDOW_MS = 60_000
const FLUSH_BUDGET = 18 // headroom under the documented 20
const MAX_SPEAK_CHARS = 1800
const CLEAR_TIMEOUT_MS = 1500
const MAX_RECONNECTS = 4

/**
 * Deepgram streaming text-to-speech (`/v1/speak`). One socket is reused for
 * many responses; `Clear` drops pending speech on interruption. Audio that
 * is still in flight when Clear is sent is discarded until the server's
 * `Cleared` acknowledgement, so late audio from a cancelled answer can never
 * play.
 */
export class DeepgramTts implements TtsPort {
  private ws: WebSocket | null = null
  private open = false
  private connecting = false
  private outbox: string[] = []
  private responseId: string | null = null
  private awaitingCleared = false
  private clearTimer: ReturnType<typeof setTimeout> | null = null
  private flushTimes: number[] = []
  private segmentsSent = 0
  private segmentsAcked = 0
  private reconnects = 0
  private closedByUs = false
  /** Bumped per connection attempt, so a credential that arrives after a newer attempt (or close) is dropped. */
  private attemptId = 0

  /** @param auth Credentials for each socket: the .env key, or a short-lived token from ECHO's server. */
  constructor(
    private readonly cfg: VoiceConfig,
    private readonly hooks: TtsHooks,
    private readonly auth: DeepgramAuth = keyAuth(cfg.deepgramApiKey)
  ) {}

  private url(): string {
    const q = new URLSearchParams({
      model: this.cfg.ttsVoice,
      encoding: 'linear16',
      sample_rate: String(TTS_SAMPLE_RATE)
    })
    return `${this.cfg.deepgramBase}/v1/speak?${q.toString()}`
  }

  ensureConnected(): void {
    this.closedByUs = false
    if (this.open || this.connecting) return
    this.connecting = true
    const id = ++this.attemptId
    this.auth.header().then(
      (authorization) => {
        if (id === this.attemptId && this.connecting && !this.closedByUs) this.openWith(authorization)
      },
      (err: unknown) => {
        if (id !== this.attemptId) return
        this.connecting = false
        if (this.closedByUs) return
        const message = err instanceof Error ? err.message : 'Could not get speech credentials.'
        this.hooks.onError(this.responseId, message, err instanceof DeepgramAuthError && err.fatal)
      }
    )
  }

  private openWith(authorization: string): void {
    const ws = new WebSocket(this.url(), { headers: { Authorization: authorization } })
    this.ws = ws

    ws.on('open', () => {
      if (this.ws !== ws) return
      this.open = true
      this.connecting = false
      this.reconnects = 0
      this.drainOutbox()
    })

    ws.on('message', (data, isBinary) => {
      if (this.ws !== ws) return
      if (isBinary) {
        // Dropped while a Clear is pending: it belongs to a cancelled answer.
        if (!this.awaitingCleared && this.responseId) this.hooks.onAudio(this.responseId, data as Buffer)
        return
      }
      this.handleControl(data.toString())
    })

    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0
      res.resume()
      if (this.ws !== ws) return
      this.dropSocket()
      const msg =
        status === 401 || status === 403
          ? this.auth.rejectedMessage
          : status === 429
            ? 'Deepgram speech rate limit reached. Try again in a moment.'
            : `Deepgram speech service returned HTTP ${status}.`
      this.hooks.onError(this.responseId, msg, status === 401 || status === 403)
    })

    ws.on('error', () => {
      // 'close' follows.
    })

    ws.on('close', () => {
      if (this.ws !== ws) return
      const wasOpen = this.open
      this.dropSocket()
      if (this.closedByUs) return
      const active = this.responseId
      // Idle sockets may be closed by the server; they reconnect lazily.
      if (active) {
        this.hooks.onError(active, wasOpen ? 'Voice output connection lost.' : 'Could not reach Deepgram speech.', false)
      }
    })
  }

  private dropSocket(): void {
    const ws = this.ws
    this.ws = null
    this.open = false
    this.connecting = false
    this.awaitingCleared = false
    if (this.clearTimer) clearTimeout(this.clearTimer)
    this.clearTimer = null
    this.flushTimes = []
    this.segmentsSent = 0
    this.segmentsAcked = 0
    if (ws) {
      ws.removeAllListeners()
      ws.on('error', () => {})
      try {
        ws.terminate()
      } catch {
        // ignore
      }
    }
  }

  private handleControl(raw: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    switch (msg.type) {
      case 'Flushed': {
        if (this.awaitingCleared || !this.responseId) return
        const segment = this.segmentsAcked++
        this.hooks.onFlushed(this.responseId, segment)
        return
      }
      case 'Cleared':
        this.awaitingCleared = false
        if (this.clearTimer) clearTimeout(this.clearTimer)
        this.clearTimer = null
        this.segmentsAcked = 0
        this.segmentsSent = 0
        this.drainOutbox()
        return
      case 'Warning':
        // e.g. flush rate exceeded; the budget below should keep us clear of it.
        return
      case 'Error':
        this.hooks.onError(this.responseId, 'Deepgram speech reported an error.', false)
        return
    }
  }

  begin(responseId: string): void {
    this.responseId = responseId
    this.segmentsSent = 0
    this.segmentsAcked = 0
    this.ensureConnected()
  }

  private send(frame: string): void {
    this.outbox.push(frame)
    this.drainOutbox()
  }

  private drainOutbox(): void {
    if (!this.open || this.awaitingCleared || !this.ws) return
    while (this.outbox.length) {
      this.ws.send(this.outbox.shift()!)
    }
  }

  speak(text: string): void {
    for (let i = 0; i < text.length; i += MAX_SPEAK_CHARS) {
      this.send(JSON.stringify({ type: 'Speak', text: text.slice(i, i + MAX_SPEAK_CHARS) }))
    }
  }

  canFlush(): boolean {
    const now = Date.now()
    this.flushTimes = this.flushTimes.filter((t) => now - t < FLUSH_WINDOW_MS)
    return this.flushTimes.length < FLUSH_BUDGET
  }

  flush(): number {
    this.flushTimes.push(Date.now())
    this.send(JSON.stringify({ type: 'Flush' }))
    return this.segmentsSent++
  }

  clear(): void {
    this.responseId = null
    this.outbox = []
    this.segmentsSent = 0
    this.segmentsAcked = 0
    if (!this.open || !this.ws) return
    this.awaitingCleared = true
    this.ws.send(JSON.stringify({ type: 'Clear' }))
    if (this.clearTimer) clearTimeout(this.clearTimer)
    // If the ack never arrives, a fresh socket is the only way to be sure nothing stale plays.
    this.clearTimer = setTimeout(() => {
      this.clearTimer = null
      if (!this.awaitingCleared) return
      this.dropSocket()
      if (this.reconnects++ < MAX_RECONNECTS) this.ensureConnected()
    }, CLEAR_TIMEOUT_MS)
  }

  close(): void {
    this.closedByUs = true
    this.attemptId += 1
    this.responseId = null
    this.outbox = []
    const ws = this.ws
    if (ws && this.open && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'Close' }))
      } catch {
        // ignore
      }
    }
    this.dropSocket()
  }
}
