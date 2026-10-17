import type { VoiceConfig } from './config'
import { PhraseChunker, type Phrase } from './chunker'
import { buildSystemPrompt } from './claude'
import { EchoGuard } from './echoGuard'
import { ConversationHistory } from './history'
import { asksAboutScreen, classifyIntent, isNoise, pickFiller } from './intent'
import {
  ChatError,
  type ChatPort,
  type EnginePort,
  type LinkStatus,
  type SttHooks,
  type SttPort,
  type TtsHooks,
  type TtsPort,
  type TurnInfo,
  type VoiceContextProvider
} from './ports'
import {
  IDLE_SNAPSHOT,
  type EngineError,
  type EnginePlaybackReport,
  type TranscriptEntry,
  type VoiceEvent,
  type VoiceMetrics,
  type VoiceSnapshot,
  type VoiceState
} from '../../shared/voice'

/** After local VAD ducks playback, wait this long for STT to confirm real speech before un-ducking. */
const DUCK_CONFIRM_MS = 1500
/** Push-to-talk: keep the mic open briefly after release so the last word isn't clipped. */
const TALK_RELEASE_TAIL_MS = 300
const MAX_ENTRIES = 60
/** How long to wait for the engine's playback position after an interruption. */
const PARTIAL_WAIT_MS = 400

export interface SessionDeps {
  config: VoiceConfig
  engine: EnginePort
  createStt(hooks: SttHooks): SttPort
  createTts(hooks: TtsHooks): TtsPort
  chat: ChatPort
  emit(event: VoiceEvent): void
  now?(): number
  contextProvider?: VoiceContextProvider
  log?(message: string): void
}

interface Segment {
  /** Characters of `fullText` covered once this segment has been spoken. */
  end: number
}

interface Reply {
  id: string
  abort: AbortController
  chunker: PhraseChunker
  fullText: string
  /** Spoken right away while the screen is checked. Part of fullText, but kept out of history. */
  filler: string | null
  sinceFlush: string
  segments: Segment[]
  flushedAcks: number
  playedSegments: number
  claudeDone: boolean
  audioStarted: boolean
  responseDoneSent: boolean
  tEndOfTurn: number
  tFirstText?: number
  tFirstAudio?: number
  tFirstPlayed?: number
}

interface Turn {
  index: number
  text: string
  /** Looks like ECHO's own voice so far: don't interrupt, don't show. */
  suspect: boolean
  entryId: string | null
}

/**
 * The voice conversation state machine. It owns the turn/interruption logic;
 * microphone, playback, Deepgram and Claude sit behind ports so every async
 * event can be tagged with a session epoch and response id, and stale ones
 * are dropped.
 */
export class VoiceSession {
  private state: VoiceState = 'idle'
  private muted = false
  private pushToTalk = false
  private talking = false
  private message: string | null = null
  private lastSnapshotJson = ''

  private epoch = 0
  private stt: SttPort | null = null
  private tts: TtsPort | null = null
  private engineReady = false
  private sttConnected = false
  private active = false

  private history = new ConversationHistory()
  private echo = new EchoGuard()
  private entries: TranscriptEntry[] = []
  private turn: Turn | null = null
  private reply: Reply | null = null
  private lastEndedTurn = -1
  private replySeq = 0
  private entrySeq = 0
  private lastFiller: string | null = null

  private duckTimer: ReturnType<typeof setTimeout> | null = null
  private releaseTimer: ReturnType<typeof setTimeout> | null = null
  private tInterrupt: number | null = null
  private interruptedReplyId: string | null = null
  /** An interrupted reply whose heard portion is still being measured by the engine. */
  private pendingStop: { reply: Reply; timer: ReturnType<typeof setTimeout> } | null = null

  constructor(private readonly deps: SessionDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }
  private log(msg: string): void {
    this.deps.log?.(msg)
  }

  // --- Public API ---------------------------------------------------------------

  getSnapshot(): VoiceSnapshot {
    return {
      state: this.state,
      muted: this.muted,
      pushToTalk: this.pushToTalk,
      talking: this.talking,
      message: this.message
    }
  }

  getEntries(): TranscriptEntry[] {
    return this.entries.map((e) => ({ ...e }))
  }

  isActive(): boolean {
    return this.active
  }

  start(): void {
    if (this.active) return // one session at a time: no duplicate mics or sockets
    const epoch = ++this.epoch
    this.active = true
    this.engineReady = false
    this.sttConnected = false
    this.message = null
    this.history.clear()
    this.echo.reset()
    this.entries = []
    this.turn = null
    this.reply = null
    this.lastEndedTurn = -1
    this.deps.emit({ type: 'reset' })
    this.setState('connecting')

    this.stt = this.deps.createStt({
      onTurn: (info) => epoch === this.epoch && this.onTurn(info),
      onStatus: (s) => epoch === this.epoch && this.onSttStatus(s)
    })
    this.tts = this.deps.createTts({
      onAudio: (id, buf) => epoch === this.epoch && this.onTtsAudio(id, buf),
      onFlushed: (id, seg) => epoch === this.epoch && this.onTtsFlushed(id, seg),
      onError: (id, msg, fatal) => epoch === this.epoch && this.onTtsError(id, msg, fatal)
    })
    this.deps.engine.start(this.effectiveMuted(), this.deps.config.bargeInMs)
    this.stt.connect()
    this.tts.ensureConnected()
  }

  /** Ends the conversation and releases the microphone, sockets and pending requests. */
  stop(): void {
    this.teardown()
    this.message = null
    this.setState('idle')
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    if (muted && this.turn && !this.turn.suspect) this.stt?.forceEndTurn()
    this.applyMute()
    this.refresh()
  }

  setPushToTalkMode(enabled: boolean): void {
    this.pushToTalk = enabled
    this.talking = false
    this.applyMute()
    this.refresh()
  }

  talk(pressed: boolean): void {
    if (!this.active || !this.pushToTalk) return
    if (this.releaseTimer) clearTimeout(this.releaseTimer)
    this.releaseTimer = null
    if (pressed) {
      this.talking = true
      if (this.reply) this.interrupt('talk-button')
      this.applyMute()
    } else {
      const epoch = this.epoch
      this.releaseTimer = setTimeout(() => {
        this.releaseTimer = null
        if (epoch !== this.epoch) return
        this.talking = false
        this.stt?.forceEndTurn()
        this.applyMute()
        this.refresh()
      }, TALK_RELEASE_TAIL_MS)
    }
    this.refresh()
  }

  /** The visible Stop button. */
  stopResponse(): void {
    if (this.reply) this.interrupt('stop-button')
  }

  // --- Events from the audio engine -----------------------------------------------

  onEngineReady(): void {
    if (!this.active) return
    this.engineReady = true
    this.refresh()
  }

  onEngineError(err: EngineError): void {
    if (!this.active) return
    this.fail(err.message)
  }

  onMicAudio(pcm16: Buffer): void {
    if (this.active && this.sttConnected) this.stt?.sendAudio(pcm16)
  }

  /** Local voice-activity detection. The engine has already ducked playback on `speaking`. */
  onVad(speaking: boolean): void {
    if (!this.active || !speaking) return
    if (this.effectiveMuted()) return
    const r = this.reply
    if (!r?.audioStarted) return
    this.log('[voice] local VAD: speech while ECHO is speaking (playback ducked, awaiting confirmation)')
    this.tInterrupt = this.now()
    if (this.duckTimer) clearTimeout(this.duckTimer)
    const epoch = this.epoch
    this.duckTimer = setTimeout(() => {
      this.duckTimer = null
      if (epoch === this.epoch) this.deps.engine.duck(false)
    }, DUCK_CONFIRM_MS)
  }

  /**
   * The local VAD heard sustained speech while ECHO was talking. This stops ECHO
   * without waiting for Deepgram to report a turn; the user's words are still
   * transcribed normally and answered once their turn ends.
   */
  onBargeIn(): void {
    if (!this.active || this.effectiveMuted()) return
    const r = this.reply
    if (!r?.audioStarted) return
    this.clearDuckTimer()
    this.interrupt('local-vad-sustained')
    this.refresh()
  }

  onPlayback(report: EnginePlaybackReport): void {
    if (!this.active) return
    const r = this.reply
    switch (report.kind) {
      case 'started':
        if (r?.id !== report.responseId) return
        r.audioStarted = true
        r.tFirstPlayed = report.at
        this.emitMetrics(r)
        this.refresh()
        return
      case 'segment':
        if (r?.id !== report.responseId) return
        r.playedSegments = Math.max(r.playedSegments, report.segment + 1)
        this.updateReplyEntry(r)
        return
      case 'ended':
        if (r?.id !== report.responseId) return
        this.finishReply(r, false)
        return
      case 'stopped':
        if (this.pendingStop?.reply.id === report.responseId) this.finalizeInterrupted(report.partial)
        if (this.tInterrupt !== null && this.interruptedReplyId === report.responseId) {
          const ms = Math.max(0, report.at - this.tInterrupt)
          this.metrics({ responseId: report.responseId, interruptToStop: ms })
          this.tInterrupt = null
        }
        return
    }
  }

  // --- Speech-to-text events -----------------------------------------------------

  private onSttStatus(status: LinkStatus): void {
    switch (status.kind) {
      case 'connected':
        this.sttConnected = true
        this.lastEndedTurn = -1 // turn numbering restarts on every new Flux connection
        if (this.message?.startsWith('Reconnecting')) this.message = null
        this.refresh()
        return
      case 'reconnecting':
        this.sttConnected = false
        this.message = `Reconnecting to speech recognition (attempt ${status.attempt})…`
        this.refresh()
        return
      case 'fatal':
        this.fail(status.message)
        return
    }
  }

  private onTurn(info: TurnInfo): void {
    if (!this.active) return
    if (info.event !== 'Update') this.log('[voice] stt ' + info.event + ' #' + info.turnIndex + ' "' + info.transcript.slice(0, 80) + '"')
    // A trailing update for a turn that already ended must not be mistaken for new speech.
    const trailing = info.event === 'Update' || info.event === 'EagerEndOfTurn' || info.event === 'TurnResumed'
    if (trailing && !this.turn && info.turnIndex <= this.lastEndedTurn) return
    switch (info.event) {
      case 'StartOfTurn':
        this.onTurnStart(info)
        return
      case 'Update':
      case 'EagerEndOfTurn':
        this.onTurnUpdate(info)
        return
      case 'TurnResumed':
        return
      case 'EndOfTurn':
        this.onTurnEnd(info)
        return
    }
  }

  private looksLikeEcho(transcript: string): boolean {
    return this.echo.isEchoLike(transcript, this.now(), !!this.reply?.audioStarted)
  }

  private onTurnStart(info: TurnInfo): void {
    const turn: Turn = { index: info.turnIndex, text: info.transcript, suspect: false, entryId: null }
    this.turn = turn
    if (this.reply) {
      if (this.looksLikeEcho(info.transcript)) {
        // Probably ECHO's own voice leaking in: stay ducked and wait for more words.
        turn.suspect = true
        return
      }
      this.interrupt('speech')
    }
    this.confirmTurn(turn)
  }

  private onTurnUpdate(info: TurnInfo): void {
    // Flux sends periodic updates even when nobody is speaking, with an empty transcript.
    // Those are not speech and must never interrupt ECHO or appear in the transcript.
    if (!info.transcript.trim()) return
    const turn = this.turn
    if (!turn) {
      // Update without a StartOfTurn (e.g. after a reconnect): treat as the start.
      this.onTurnStart(info)
      return
    }
    turn.text = info.transcript
    if (turn.suspect) {
      if (this.looksLikeEcho(info.transcript)) return
      turn.suspect = false
      this.interrupt('speech')
      this.confirmTurn(turn)
      return
    }
    this.updateTurnEntry(turn, false)
  }

  private onTurnEnd(info: TurnInfo): void {
    // Flux numbers turns; never process the same one twice.
    if (info.turnIndex <= this.lastEndedTurn) return
    this.lastEndedTurn = info.turnIndex

    const turn = this.turn
    this.turn = null
    const text = info.transcript.trim()
    this.clearDuckTimer()

    const echo = this.reply && (turn?.suspect || this.looksLikeEcho(text))
    if (echo) {
      this.deps.engine.duck(false)
      this.refresh()
      return
    }

    if (!text || isNoise(text)) {
      if (turn?.entryId) this.removeEntry(turn.entryId)
      this.refresh()
      return
    }

    const entry = turn ?? { index: info.turnIndex, text, suspect: false, entryId: null }
    entry.text = text
    this.updateTurnEntry(entry, true)

    if (classifyIntent(text) === 'stop') {
      this.interrupt('stop-command')
      this.refresh()
      return
    }
    if (this.reply) this.interrupt('new-turn')
    this.submit(text)
  }

  private confirmTurn(turn: Turn): void {
    this.updateTurnEntry(turn, false)
    this.refresh()
  }

  // --- Reply lifecycle --------------------------------------------------------------

  private submit(text: string): void {
    this.flushPendingStop() // make sure history reflects what was heard before the next question
    // An unanswered earlier question + this one are one question split by a pause.
    if (this.history.hasUnansweredUser()) this.history.mergeIntoLastUser(text)
    else this.history.addUser(text)
    this.startReply(text)
  }

  private startReply(question: string): void {
    const epoch = this.epoch
    const reply: Reply = {
      id: `r${++this.replySeq}`,
      abort: new AbortController(),
      chunker: new PhraseChunker(),
      fullText: '',
      filler: null,
      sinceFlush: '',
      segments: [],
      flushedAcks: 0,
      playedSegments: 0,
      claudeDone: false,
      audioStarted: false,
      responseDoneSent: false,
      tEndOfTurn: this.now()
    }
    this.reply = reply
    this.tts?.begin(reply.id)
    this.upsertEntry({ id: reply.id, role: 'assistant', text: '', final: false, spokenChars: 0 })
    // Looking at the screen takes a moment: say so instead of going quiet.
    if (this.deps.contextProvider?.isWatchingScreen?.() && asksAboutScreen(question)) {
      reply.filler = this.lastFiller = pickFiller(this.lastFiller)
      this.speakPhrase(reply, { text: reply.filler, flush: false })
      this.flushSegment(reply, true)
    }
    this.refresh()
    void this.runChat(reply, epoch)
  }

  private async runChat(reply: Reply, epoch: number): Promise<void> {
    const alive = (): boolean => epoch === this.epoch && this.reply === reply && !reply.abort.signal.aborted
    try {
      const context = (await this.deps.contextProvider?.getContext().catch(() => null)) ?? null
      if (!alive()) return
      await this.deps.chat.stream({
        system: buildSystemPrompt(context, reply.filler),
        messages: this.history.toMessages(this.deps.config.historyMessages),
        image: context?.screenImage,
        signal: reply.abort.signal,
        onText: (delta) => alive() && this.onClaudeText(reply, delta)
      })
    } catch (err) {
      if (!alive()) return
      const kind = err instanceof ChatError ? err.kind : 'other'
      const message = err instanceof ChatError ? err.message : 'Claude request failed.'
      this.log(`[voice] chat error (${kind})`)
      if (kind === 'auth') {
        this.fail(message)
        return
      }
      // No automatic replay: tell the user and wait for them to speak again.
      this.abandonReply(reply, message)
      return
    }
    if (alive()) this.endClaude(reply)
  }

  private onClaudeText(reply: Reply, delta: string): void {
    if (reply.tFirstText === undefined) reply.tFirstText = this.now()
    for (const phrase of reply.chunker.push(delta)) this.speakPhrase(reply, phrase)
  }

  private endClaude(reply: Reply): void {
    reply.claudeDone = true
    for (const phrase of reply.chunker.end()) this.speakPhrase(reply, phrase)
    if (reply.sinceFlush) this.flushSegment(reply, true)
    if (reply.segments.length === 0) {
      // Nothing to say.
      this.finishReply(reply, false)
      return
    }
    this.maybeResponseDone(reply)
  }

  private speakPhrase(reply: Reply, phrase: Phrase): void {
    if (phrase.text) {
      reply.fullText += (reply.fullText ? ' ' : '') + phrase.text
      reply.sinceFlush += phrase.text
      this.echo.noteSpoken(phrase.text, this.now())
      this.tts?.speak(phrase.text + ' ')
      this.updateReplyEntry(reply)
    }
    if (phrase.flush) this.flushSegment(reply, false)
  }

  private flushSegment(reply: Reply, force: boolean): void {
    if (!reply.sinceFlush || !this.tts) return
    // Deepgram allows only ~20 flushes a minute: hold text for a bigger group when out of budget.
    if (!force && !this.tts.canFlush()) return
    const index = this.tts.flush()
    reply.segments[index] = { end: reply.fullText.length }
    reply.sinceFlush = ''
  }

  private maybeResponseDone(reply: Reply): void {
    if (reply.responseDoneSent || !reply.claudeDone) return
    if (reply.flushedAcks < reply.segments.length) return
    reply.responseDoneSent = true
    this.deps.engine.responseDone(reply.id)
  }

  private onTtsAudio(responseId: string, pcm16: Buffer): void {
    const r = this.reply
    if (r?.id !== responseId) return // stale audio from an interrupted answer
    if (r.tFirstAudio === undefined) r.tFirstAudio = this.now()
    this.deps.engine.sendAudio(responseId, pcm16)
  }

  private onTtsFlushed(responseId: string, segment: number): void {
    const r = this.reply
    if (r?.id !== responseId) return
    r.flushedAcks += 1
    this.deps.engine.segmentMarker(responseId, segment)
    this.maybeResponseDone(r)
  }

  private onTtsError(responseId: string | null, message: string, fatal: boolean): void {
    if (fatal) {
      this.fail(message)
      return
    }
    const r = this.reply
    if (r && (responseId === null || r.id === responseId)) this.abandonReply(r, message)
  }

  /** Stops a reply because something failed. What was already spoken stays in history; nothing is replayed. */
  private abandonReply(reply: Reply, message: string): void {
    this.message = message
    this.tts?.clear()
    this.deps.engine.clearPlayback(reply.id)
    reply.abort.abort()
    this.finishReply(reply, true)
  }

  private interrupt(reason: string): void {
    const r = this.reply
    if (!r) return
    this.log(`[voice] interrupt (${reason})`)
    if (this.tInterrupt === null || this.now() - this.tInterrupt > 3000) this.tInterrupt = this.now()
    this.interruptedReplyId = r.id
    this.clearDuckTimer()
    r.abort.abort()
    this.tts?.clear()
    this.deps.engine.clearPlayback(r.id)
    this.finishReply(r, true)
  }

  private deliveredText(r: Reply, interrupted: boolean): string {
    if (!interrupted) return r.fullText
    // Only count what finished playing, not everything that was generated.
    const played = r.segments.slice(0, r.playedSegments)
    const end = played.length ? (played[played.length - 1]?.end ?? 0) : 0
    return r.fullText.slice(0, end)
  }

  /** What belongs in history: the delivered text minus the filler line. */
  private withoutFiller(r: Reply, delivered: string): string {
    return r.filler && delivered.startsWith(r.filler) ? delivered.slice(r.filler.length).trim() : delivered
  }

  private finishReply(r: Reply, interrupted: boolean): void {
    if (this.reply !== r) return
    this.reply = null
    let delivered: string
    if (interrupted) {
      // Wait briefly for the engine to say how far into the current segment playback got.
      this.flushPendingStop()
      const epoch = this.epoch
      const timer = setTimeout(() => epoch === this.epoch && this.finalizeInterrupted(undefined), PARTIAL_WAIT_MS)
      this.pendingStop = { reply: r, timer }
      delivered = this.deliveredText(r, true)
    } else {
      delivered = r.fullText
      this.history.commitAssistant(this.withoutFiller(r, delivered))
    }
    const entry = this.entries.find((e) => e.id === r.id)
    if (entry) {
      this.upsertEntry({
        ...entry,
        text: r.fullText,
        final: true,
        interrupted,
        spokenChars: interrupted ? delivered.length : r.fullText.length
      })
    }
    this.refresh()
  }

  /**
   * Records what the user actually heard of an interrupted reply: every fully
   * played segment plus the played share of the segment that was cut off.
   */
  private finalizeInterrupted(partial?: { segment: number; fraction: number }): void {
    const pending = this.pendingStop
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingStop = null
    const r = pending.reply

    let delivered = this.deliveredText(r, true)
    if (partial && partial.fraction > 0 && partial.segment === r.playedSegments) {
      const start = r.playedSegments > 0 ? (r.segments[r.playedSegments - 1]?.end ?? 0) : 0
      const end = r.segments[partial.segment]?.end
      if (end !== undefined) {
        const words = r.fullText.slice(start, end).trim().split(/\s+/)
        const heard = Math.floor(words.length * Math.min(1, partial.fraction))
        if (heard > 0) delivered = (delivered + ' ' + words.slice(0, heard).join(' ')).trim()
      }
    }
    const heard = this.withoutFiller(r, delivered)
    this.history.commitAssistant(heard)
    // ECHO did start answering: the user's question was heard, so the next turn is a new one.
    // A filler line alone doesn't count; the question is still open.
    if (!heard && r.audioStarted && !r.filler) this.history.markAnswered()
    const entry = this.entries.find((e) => e.id === r.id)
    if (entry) this.upsertEntry({ ...entry, spokenChars: delivered.length })
  }

  private flushPendingStop(): void {
    if (this.pendingStop) this.finalizeInterrupted(undefined)
  }

  // --- Mute / state -------------------------------------------------------------------

  private effectiveMuted(): boolean {
    return this.muted || (this.pushToTalk && !this.talking)
  }

  private applyMute(): void {
    if (this.active) this.deps.engine.setMuted(this.effectiveMuted())
  }

  private computeState(): VoiceState {
    if (this.state === 'error') return 'error'
    if (!this.active) return 'idle'
    if (!this.engineReady || !this.sttConnected) return 'connecting'
    if (this.turn && !this.turn.suspect) return 'user-speaking'
    if (this.reply) return this.reply.audioStarted ? 'speaking' : 'thinking'
    return this.muted ? 'paused' : 'listening'
  }

  private refresh(): void {
    this.setState(this.computeState())
  }

  private setState(state: VoiceState): void {
    this.state = state
    const snapshot = this.getSnapshot()
    const json = JSON.stringify(snapshot)
    if (json === this.lastSnapshotJson) return
    this.lastSnapshotJson = json
    this.deps.emit({ type: 'state', snapshot })
  }

  private fail(message: string): void {
    this.teardown()
    this.message = message
    this.state = 'error'
    this.lastSnapshotJson = ''
    this.setState('error')
  }

  private teardown(): void {
    this.epoch += 1 // invalidates every callback still in flight
    this.active = false
    this.clearDuckTimer()
    if (this.releaseTimer) clearTimeout(this.releaseTimer)
    this.releaseTimer = null
    this.reply?.abort.abort()
    this.reply = null
    if (this.pendingStop) clearTimeout(this.pendingStop.timer)
    this.pendingStop = null
    this.turn = null
    this.stt?.close()
    this.tts?.close()
    this.stt = null
    this.tts = null
    this.deps.engine.stop()
    this.engineReady = false
    this.sttConnected = false
    this.talking = false
    this.tInterrupt = null
    this.history.clear()
    this.echo.reset()
    // A stopped conversation is not an error any more.
    if (this.state === 'error') this.state = 'idle'
  }

  private clearDuckTimer(): void {
    if (this.duckTimer) clearTimeout(this.duckTimer)
    this.duckTimer = null
  }

  // --- Transcript entries -----------------------------------------------------------------

  private upsertEntry(entry: TranscriptEntry): void {
    const i = this.entries.findIndex((e) => e.id === entry.id)
    if (i >= 0) this.entries[i] = entry
    else {
      this.entries.push(entry)
      if (this.entries.length > MAX_ENTRIES) this.entries.shift()
    }
    this.deps.emit({ type: 'entry', entry })
  }

  private removeEntry(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id)
    this.deps.emit({ type: 'entry', entry: { id, role: 'user', text: '', final: true } })
  }

  private updateTurnEntry(turn: Turn, final: boolean): void {
    if (!turn.entryId) turn.entryId = `u${++this.entrySeq}`
    this.upsertEntry({ id: turn.entryId, role: 'user', text: turn.text, final })
  }

  private updateReplyEntry(r: Reply): void {
    const spoken = r.playedSegments > 0 ? (r.segments[r.playedSegments - 1]?.end ?? 0) : 0
    this.upsertEntry({ id: r.id, role: 'assistant', text: r.fullText, final: false, spokenChars: spoken })
  }

  // --- Metrics ------------------------------------------------------------------------------

  private emitMetrics(r: Reply): void {
    const m: VoiceMetrics = {
      responseId: r.id,
      firstClaudeText: r.tFirstText !== undefined ? r.tFirstText - r.tEndOfTurn : undefined,
      firstTtsAudio: r.tFirstAudio !== undefined ? r.tFirstAudio - r.tEndOfTurn : undefined,
      firstAudioPlayed: r.tFirstPlayed !== undefined ? r.tFirstPlayed - r.tEndOfTurn : undefined
    }
    this.metrics(m)
  }

  private metrics(m: VoiceMetrics): void {
    if (this.deps.config.logMetrics) this.log(`[voice] metrics ${JSON.stringify(m)}`)
    this.deps.emit({ type: 'metrics', metrics: m })
  }
}

export { IDLE_SNAPSHOT }
