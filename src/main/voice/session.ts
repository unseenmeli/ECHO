import type { VoiceConfig } from './config'
import { LessonState, LessonTurn, type LessonBoardPort, type TurnIO } from '../lesson/controller'
import { describeBoardForTutor, summarizeBoard, summarizeSelection } from '../lesson/summary'
import { LESSON_PROMPT_ADDENDUM, SegmentStreamParser, type ParsedSegment } from '../lesson/tutorProtocol'
import type { VisualPlan } from '../lesson/ops'
import { selectSkills, skillsPrompt } from '../skills'
import { DEFAULT_CHUNKER, normalizeForSpeech, PhraseChunker, type Phrase } from './chunker'
import { buildSystemPrompt, buildTurnContext, preferencesBlock } from './claude'
import { EchoGuard } from './echoGuard'
import { ConversationHistory, SUMMARY_SYSTEM, summaryRequest } from './history'
import {
  asksAboutScreen,
  classifyIntent,
  closeFallback,
  couldBeLessonRequest,
  couldBePracticeRequest,
  isNoise,
  parseRoute,
  pickFiller,
  pictureRequest,
  ROUTER_SYSTEM,
  routerPrompt,
  WAIT_LINES,
  type LessonAction
} from './intent'
import {
  ChatError,
  type ChatPort,
  type ChatRequest,
  type ChatResult,
  type ChatTool,
  type EnginePort,
  type LinkStatus,
  type SttHooks,
  type SttPort,
  type ToolCall,
  type TtsHooks,
  type TtsPort,
  type TurnInfo,
  type VoiceContextProvider
} from './ports'
import { chooseModelTier, type ModelTier } from './routing'
import { danglingReferenceNote, misheardNote, unsureWords } from './repair'
import { CODE_EXECUTION_GUIDE, WEB_FETCH_GUIDE, WEB_SEARCH_DEEP_LESSON, WEB_SEARCH_DEEP_VERBAL, WEB_SEARCH_GUIDE, WEB_SEARCH_LESSON } from './research'
import type { PreferenceStorePort } from '../memory/preferenceStore'
import { STUDY_MATERIAL_GUIDE, type StudyMaterialPort } from '../study/studyMaterial'
import type { Picture, PictureLookup } from '../lesson/pictures'
import { PREFERENCE_TOOL_GUIDE, PREFERENCE_TOOLS, PreferenceTools } from '../memory/preferenceTools'
import { composeGuide, composeTools, ComposeTools, type ComposePort } from '../compose/composeTools'
import type { DraftEdits } from '../../shared/compose'
<<<<<<< HEAD
=======
import { DECK_GUIDE, DECK_TOOL_NAMES, DECK_TOOLS, type DeckStudio } from '../deck/deckTools'
>>>>>>> origin/main
import {
  IDLE_SNAPSHOT,
  type EngineError,
  type EnginePlaybackReport,
  type TranscriptEntry,
  type VoiceEvent,
  type VoiceMetrics,
  type VoiceSnapshot,
  type VoiceState,
  type SourceLink
} from '../../shared/voice'

/** After local VAD ducks playback, wait this long for STT to confirm real speech before un-ducking. */
const DUCK_CONFIRM_MS = 1500
/** Push-to-talk: keep the mic open briefly after release so the last word isn't clipped. */
const TALK_RELEASE_TAIL_MS = 300
const MAX_ENTRIES = 60
/** How long to wait for the engine's playback position after an interruption. */
const PARTIAL_WAIT_MS = 400
/** How long a deep dive waits for the lesson window to open and its board to load. */
const LESSON_OPEN_TIMEOUT_MS = 8000
/** Token budgets: a normal lesson answer, and a deep dive (6-8 segments, each with its drawing). */
const LESSON_MAX_TOKENS = 7200
const DEEP_MAX_TOKENS = 21000
/** A spoken deep dive (10-15 sentences, after any thinking). */
const DEEP_VERBAL_MAX_TOKENS = 3600
/** The lesson router answers with one word. */
const ROUTE_MAX_TOKENS = 24
/** The running conversation summary (asked to stay under 180 words). */
const SUMMARY_MAX_TOKENS = 1800
/** What the "go deeper" button says on the learner's behalf. */
export const DEEP_DIVE_REQUEST = 'Go deeper on that. Explain it in depth.'
/** How long to wait for the model to say whether a turn is a lesson request before falling back. */
const ROUTE_TIMEOUT_MS = 3000
/** How long a picture request waits for the picture to be found. */
const PICTURE_WAIT_MS = 10000
/** If nothing has been said this long after the learner finished, a brief wait line fills the silence. */
const WAIT_LINE_DELAY_MS = 2000
const CLOSED_LESSON_ACK = 'Okay, I closed the whiteboard.'
const NOTHING_TO_CLOSE_ACK = "The whiteboard isn't open right now."

/** What the session needs to run a lesson with whiteboard visuals alongside the speech. */
export interface LessonSupport {
  /** True while a lesson window is open and visuals are enabled. */
  available(): boolean
  board(): LessonBoardPort | null
  /** Open the lesson window and resolve once its board is ready (false if it could not be opened). */
  open?(timeoutMs: number): Promise<boolean>
  /** Close the lesson window. */
  close?(): void
  /** Finds real pictures for the whiteboard (image ops). */
  pictures?: PictureLookup
}

/** How many learner turns a practice activity keeps check-understanding loaded unless it is ended sooner. */
const PRACTICE_MAX_TURNS = 12

export interface SessionDeps {
  config: VoiceConfig
  engine: EnginePort
  createStt(hooks: SttHooks): SttPort
  createTts(hooks: TtsHooks): TtsPort
  chat: ChatPort
  emit(event: VoiceEvent): void
  now?(): number
  contextProvider?: VoiceContextProvider
  lesson?: LessonSupport
  /** Saved user preferences: supplied to the model on every request, and written through its tools. */
  preferences?: PreferenceStorePort
  /** The learner's own study material, searched for passages related to each question. */
  study?: StudyMaterialPort
  /** Emails and posts ECHO drafts for the user to approve; the app opens the compose page on their yes. */
  compose?: ComposePort
<<<<<<< HEAD
=======
  /** Slide decks ECHO builds by voice (kept by the app across conversations). */
  deck?: DeckStudio
>>>>>>> origin/main
  log?(message: string): void
}

interface SubmitOptions {
  /** The go-deeper button: teach in depth without asking the model what the words meant. */
  forceDeep?: boolean
  /** Answer with this exact line instead of asking the model (acknowledging a saved preference). */
  localText?: string
  /** Words speech recognition was unsure of, so the model can check before answering the wrong question. */
  unsure?: string[]
}

interface Segment {
  /** Characters of `fullText` covered once this segment has been spoken. */
  end: number
}

interface Reply {
  id: string
  /** What the learner said that this reply answers. */
  question: string
  /** Spoken as-is, without asking the model. */
  localText: string | null
  /** Set when this reply runs as a visual lesson (segments + whiteboard). */
  lessonTurn: LessonTurn | null
  abort: AbortController
  chunker: PhraseChunker
  fullText: string
  /** A wait line spoken because the answer was slow to start. Part of fullText, but kept out of history. */
  filler: string | null
  /** Speaks the wait line if nothing has been said by then. */
  waitTimer: ReturnType<typeof setTimeout> | null
  /** The learner asked for depth: open the whiteboard and teach a full lesson. */
  deep: boolean
  /** Which model answers when this isn't a deep dive: the fast one, or the strong one for a hard question. */
  tier: ModelTier
  /** Words of the question speech recognition was unsure of. */
  unsure: string[]
  /** There were earlier turns when this question was asked (something "this" could refer to). */
  hadHistory: boolean
  /** Part of a practice or checkpoint activity the learner asked for. */
  practice: boolean
  /** The learner asked to see a picture of `subject`; `found` is the picture once looked up (null: none to show). */
  picture: { subject: string; found: Picture | null } | null
  /** Web pages the answer drew on, for the transcript. */
  sources: SourceLink[]
  searchFailed: boolean
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
  private lessonState = new LessonState()
  private entrySeq = 0
  private lastFiller: string | null = null
  /** The tier that answered the last turn, so a short follow-up stays on it. */
  private lastTier: ModelTier = 'fast'
  private readonly prefTools: PreferenceTools | null
  private readonly compose: ComposeTools | null
  /** The voice the current speech socket was opened with, to notice a changed preference. */
  private ttsVoice: string | undefined
  /** A web search or page read is running, so the status line says so. */
  private searching: 'search' | 'fetch' | false = false
  /** Learner turns left in the current practice activity (0: none running). */
  private practiceTurnsLeft = 0
  /** The background request folding older turns into the conversation summary, if one is running. */
  private summarizing: AbortController | null = null
  /** A line ECHO says on its own (a deck is ready) once it isn't talking and the user isn't either. */
  private announcement: string | null = null

  private duckTimer: ReturnType<typeof setTimeout> | null = null
  private releaseTimer: ReturnType<typeof setTimeout> | null = null
  private tInterrupt: number | null = null
  private interruptedReplyId: string | null = null
  /** An interrupted reply whose heard portion is still being measured by the engine. */
  private pendingStop: { reply: Reply; timer: ReturnType<typeof setTimeout> } | null = null

  constructor(private readonly deps: SessionDeps) {
    this.prefTools = deps.preferences ? new PreferenceTools(deps.preferences) : null
    this.compose = deps.compose?.destinations.length ? new ComposeTools(deps.compose) : null
<<<<<<< HEAD
=======
    deps.deck?.setAnnouncer((line) => this.announce(line))
>>>>>>> origin/main
  }

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
    this.lessonState = new LessonState()
    this.prefTools?.reset()
    this.compose?.reset()
    this.practiceTurnsLeft = 0
    this.lastTier = 'fast'
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
    this.tts = this.makeTts(epoch)
    this.deps.engine.start(this.effectiveMuted(), this.deps.config.bargeInMs)
    this.stt.connect()
    this.tts.ensureConnected()
  }

  private makeTts(epoch: number): TtsPort {
    this.ttsVoice = this.deps.preferences?.get('voice')
    return this.deps.createTts({
      onAudio: (id, buf) => epoch === this.epoch && this.onTtsAudio(id, buf),
      onFlushed: (id, seg) => epoch === this.epoch && this.onTtsFlushed(id, seg),
      onError: (id, msg, fatal) => epoch === this.epoch && this.onTtsError(id, msg, fatal)
    })
  }

  /**
   * A new voice preference only takes effect on a new speech socket. Swap it between replies, so the line that
   * announced the change finishes in the old voice and everything after it is in the new one.
   */
  onPreferencesChanged(): void {
    if (!this.active || this.reply || !this.deps.preferences) return
    if (this.deps.preferences.get('voice') === this.ttsVoice) return
    this.tts?.close()
    this.tts = this.makeTts(this.epoch)
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

  /**
   * The "go deeper" button: asks for a deep dive on whatever was just discussed, as if the learner had said
   * so. Returns false when there is nothing to go deeper on yet.
   */
  deepDive(): boolean {
    if (!this.active || !this.history.toMessages(2).length) return false
    if (this.reply) this.interrupt('deep-dive')
    this.updateTurnEntry({ index: -1, text: DEEP_DIVE_REQUEST, suspect: false, entryId: null }, true)
    this.submit(DEEP_DIVE_REQUEST, { forceDeep: true })
    return true
  }

  /** Send or Cancel pressed on the draft card. ECHO says what happened. */
  answerDraft(id: string, send: boolean): void {
    const answer = this.compose?.answer(id, send)
    if (!answer || !this.active) return
    this.log(`[voice] draft ${answer.kind} (button)`)
    if (this.reply) this.interrupt('draft-button')
    this.flushPendingStop()
    this.startReply('', { localText: answer.spoken })
  }

  /** The user edited the draft in the card. */
  editDraft(id: string, edits: DraftEdits): void {
    this.compose?.edit(id, edits)
  }

<<<<<<< HEAD
=======
  /** Something to say without being asked (a deck finished). Waits for the current reply, or the user, to finish. */
  private announce(line: string): void {
    if (!this.active) return
    this.announcement = line
    this.maybeAnnounce()
  }

  private maybeAnnounce(): void {
    const line = this.announcement
    if (!line || !this.active || this.reply || (this.turn && !this.turn.suspect)) return
    this.announcement = null
    this.flushPendingStop()
    this.startReply('', { localText: line })
  }

  /** After the current event settles: a reply ending is often followed at once by the next one starting. */
  private scheduleAnnouncement(): void {
    if (!this.announcement) return
    const epoch = this.epoch
    setTimeout(() => epoch === this.epoch && this.maybeAnnounce(), 0)
  }

>>>>>>> origin/main
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
      case 'segmentStart':
        if (r?.id !== report.responseId) return
        r.lessonTurn?.onSegmentStart(report.segment, report.at)
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
      this.scheduleAnnouncement()
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
    // If ECHO just asked whether to remember something, a short yes/no settles it without another model call.
    const answer = this.prefTools?.resolveProposal(text) ?? this.compose?.resolveSpoken(text)
    if (answer?.kind === 'sent' || answer?.kind === 'cancelled') this.log(`[voice] draft ${answer.kind} (spoken)`)
<<<<<<< HEAD
=======
    // "Next slide", "go back", "slide three" while a deck is open: moved at once, no model call.
    const slide = answer ? null : this.deps.deck?.resolveSpoken(text)
    if (slide) this.log('[voice] deck navigation (spoken)')
>>>>>>> origin/main
    const unsure = unsureWords(info.words, this.deps.config.sttUnsureConfidence)
    if (unsure.length) this.log(`[voice] speech recognition unsure of: ${unsure.join(', ')}`)
    const localText = answer?.spoken ?? slide
    this.submit(text, localText ? { localText } : { unsure })
  }

  private confirmTurn(turn: Turn): void {
    this.updateTurnEntry(turn, false)
    this.refresh()
  }

  // --- Reply lifecycle --------------------------------------------------------------

  private submit(text: string, options: SubmitOptions = {}): void {
    this.flushPendingStop() // make sure history reflects what was heard before the next question
    // An unanswered earlier question + this one are one question split by a pause.
    if (this.history.hasUnansweredUser()) this.history.mergeIntoLastUser(text)
    else this.history.addUser(text)
    this.startReply(text, options)
  }

  private canTeachOnBoard(): boolean {
    return !!(this.deps.lesson?.open || this.deps.lesson?.available())
  }

  private startReply(question: string, options: SubmitOptions = {}): void {
    const epoch = this.epoch
    // Asking to see a picture is routed here, without the model: it always gets a real picture on the board.
    const picture = options.forceDeep || options.localText ? null : pictureRequest(question)
    // Whether this turn is a lesson request is the model's call, not a keyword's. Turns with nothing lesson-like
    // in them skip that check entirely.
    const needsRoute =
      !picture &&
      !options.forceDeep &&
      !options.localText &&
      (couldBeLessonRequest(question) || couldBePracticeRequest(question, this.practiceTurnsLeft > 0))
    const reply: Reply = {
      id: `r${++this.replySeq}`,
      question,
      localText: options.localText ?? null,
      lessonTurn: null,
      abort: new AbortController(),
      chunker: new PhraseChunker({
        ...DEFAULT_CHUNKER,
        firstMinChars: this.deps.config.ttsFirstChars,
        groupMinChars: this.deps.config.ttsGroupChars
      }),
      fullText: '',
      filler: null,
      waitTimer: null,
      deep: !!options.forceDeep,
      tier: 'fast',
      unsure: options.unsure ?? [],
      hadHistory: this.history.toMessages(3).length > 1,
      practice: false,
      picture: picture ? { subject: picture, found: null } : null,
      sources: [],
      searchFailed: false,
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
    if (!reply.localText) reply.waitTimer = setTimeout(() => this.speakWaitLine(reply, epoch), WAIT_LINE_DELAY_MS)
    this.refresh()
    void this.runChat(reply, epoch, needsRoute)
  }

  /**
   * ECHO starts with the answer. Only when nothing has been heard for a noticeable moment (the whiteboard opening,
   * a picture being found, a slow first word) does it say a brief line, so the silence doesn't sound like a hang.
   */
  private speakWaitLine(reply: Reply, epoch: number): void {
    reply.waitTimer = null
    if (epoch !== this.epoch || this.reply !== reply || reply.abort.signal.aborted || reply.fullText) return
    const lesson = this.deps.lesson
    const lines = reply.picture
      ? WAIT_LINES.picture
      : reply.deep && lesson?.open && !lesson.available()
        ? WAIT_LINES.whiteboard
        : this.deps.contextProvider?.isWatchingScreen?.() && asksAboutScreen(reply.question)
          ? WAIT_LINES.screen
          : WAIT_LINES.other
    reply.filler = this.lastFiller = pickFiller(this.lastFiller, Math.random, lines)
    this.speakPhrase(reply, { text: reply.filler, flush: false })
    this.flushSegment(reply, true)
  }

  /**
   * Asks the model, in one word, whether the learner wants a deep dive, wants the lesson window closed, or neither.
   * If it can't answer in time, only a plain "close the whiteboard" is honored; nothing is ever opened by a guess.
   */
  private async routeLesson(reply: Reply): Promise<LessonAction> {
    const ctl = new AbortController()
    const onAbort = (): void => ctl.abort()
    reply.abort.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => ctl.abort(), ROUTE_TIMEOUT_MS)
    const lastEcho = this.history.toMessages(4).reverse().find((m) => m.role === 'assistant')?.content ?? null
    let text = ''
    try {
      await this.deps.chat.stream({
        system: ROUTER_SYSTEM,
        maxTokens: ROUTE_MAX_TOKENS,
        cache: false,
        reasoning: 'off',
        effort: 'low',
        messages: [{ role: 'user', content: routerPrompt(reply.question, !!this.deps.lesson?.available(), lastEcho, this.practiceTurnsLeft > 0) }],
        signal: ctl.signal,
        onText: (d) => (text += d)
      })
    } catch {
      // Treated like a timeout below.
    } finally {
      clearTimeout(timer)
      reply.abort.signal.removeEventListener('abort', onAbort)
    }
    if (reply.abort.signal.aborted) return 'none'
    const action = parseRoute(text) ?? closeFallback(reply.question)
    this.log(`[voice] lesson route: ${action}`)
    return action
  }

  /** Speaks a fixed line as the whole reply. */
  private speakLocally(reply: Reply, text: string): void {
    this.speakPhrase(reply, { text, flush: false })
    this.endClaude(reply)
  }

  private closeLessonByVoice(reply: Reply): void {
    const lesson = this.deps.lesson
    const wasOpen = !!lesson?.available()
    if (wasOpen) {
      lesson?.close?.()
      this.lessonState = new LessonState() // the next lesson starts fresh
    }
    this.speakLocally(reply, wasOpen ? CLOSED_LESSON_ACK : NOTHING_TO_CLOSE_ACK)
  }

  /** Preference and other tool calls the model made while answering. */
  private onToolUse(reply: Reply, call: ToolCall): string | undefined {
<<<<<<< HEAD
=======
    if (DECK_TOOL_NAMES.has(call.name) && this.deps.deck) {
      const note = this.deps.deck.handle(call, {
        chat: this.deps.chat,
        conversation: this.history.toMessages(this.deps.config.historyMessages),
        webSearch: this.deps.config.webSearchEnabled,
        material: call.name === 'build_presentation' ? this.deckMaterial(reply, call) : null
      })
      this.log(`[voice] ${call.name}: ${note.split(/[:;.]/)[0]}`)
      return note
    }
>>>>>>> origin/main
    if (call.name === 'draft_message' && this.compose) {
      const note = this.compose.handle(call)
      this.log(`[voice] draft_message: ${note.split(':')[0].split('.')[0]}`)
      return note
    }
    const outcome = this.prefTools?.handle(call, reply.question)
    if (outcome) this.log(`[voice] ${outcome.tool}: ${outcome.note}`)
    return outcome?.note
  }

  /** The rules for the preference tools (cached with the system prompt) and the saved preferences (sent after it). */
  private preferenceParts(): { guide: string | null; tail: string | undefined } {
    if (!this.deps.preferences) return { guide: null, tail: undefined }
    return { guide: PREFERENCE_TOOL_GUIDE, tail: preferencesBlock(this.deps.preferences.promptBlock()) }
  }

  /**
   * Reasoning per kind of reply. Quick answers skip thinking so the first word comes fast, at low effort (short spoken
   * answers). Whiteboard answers get medium effort for the drawing. Deep explanations may think first: a wait line
   * covers a long silence.
   */
  private reasoningFor(reply: Reply, lesson: boolean): Pick<ChatRequest, 'reasoning' | 'effort'> {
    const cfg = this.deps.config
    if (reply.deep) return { reasoning: 'adaptive', effort: cfg.deepEffort }
    if (reply.tier === 'strong') return { reasoning: cfg.strongThinking, effort: cfg.strongEffort }
    return { reasoning: 'off', effort: lesson || reply.practice ? 'medium' : 'low' }
  }

  /**
   * Fast model or quality-first model for a turn that isn't a deep dive, decided once everything about the turn is
   * known: whether it is taught on the whiteboard, part of a practice activity, about the screen, or a follow-up.
   */
  private chooseTier(reply: Reply, lesson: boolean): void {
    if (this.deps.config.smartRouting && !reply.deep) {
      const route = chooseModelTier({
        question: reply.question,
        screenShared: !!this.deps.contextProvider?.isWatchingScreen?.(),
        lesson,
        practice: reply.practice,
        previousTier: this.lastTier,
        routes: this.deps.config.qualityRoutes
      })
      reply.tier = route.tier
      this.log(`[voice] model route: ${route.tier} (${route.reasons.join(', ')})`)
    }
    this.lastTier = reply.deep ? 'strong' : reply.tier
  }

  /** Sources and failed searches for the transcript; failures are said out loud by the model and shown here too. */
  private onChatResult(reply: Reply, result: ChatResult): void {
    reply.sources = result.sources
    reply.searchFailed = result.searchErrors.length > 0 && !result.sources.some((s) => s.cited)
    if (reply.searchFailed) {
      this.deps.emit({ type: 'lesson-status', status: { level: 'warn', message: 'Web search failed, so that answer is from memory.' } })
    }
  }

  /** App note stored with a reply in history: where it was cut off, and which sites it cited. */
  private historyNote(r: Reply, interrupted: boolean): string | undefined {
    const notes: string[] = []
    const cited = [...new Set(r.sources.filter((s) => s.cited).map((s) => new URL(s.url).hostname.replace(/^www\./, '')))].slice(0, 4)
    if (cited.length) notes.push(`[sources: ${cited.join(', ')}]`)
    if (interrupted) notes.push('[cut off here: the learner interrupted]')
    return notes.length ? notes.join(' ') : undefined
  }

  /**
   * Folds older turns into the running summary once there are more than the configured history limit. Runs in the
   * background; the next replies keep sending the recent turns verbatim until it lands, and stop() cancels it.
   */
  private maybeSummarize(): void {
    if (this.summarizing || !this.active) return
    const plan = this.history.foldPlan(this.deps.config.historyMessages)
    if (!plan) return
    const epoch = this.epoch
    const ctl = new AbortController()
    this.summarizing = ctl
    let text = ''
    this.deps.chat
      .stream({
        system: SUMMARY_SYSTEM,
        cache: false,
        reasoning: 'off',
        effort: 'low',
        maxTokens: SUMMARY_MAX_TOKENS,
        messages: [{ role: 'user', content: summaryRequest(plan.previous, plan.turns) }],
        signal: ctl.signal,
        onText: (d) => (text += d)
      })
      .then(() => {
        if (epoch !== this.epoch || ctl.signal.aborted || !text.trim()) return
        this.history.applyFold(plan.upTo, text.trim())
        this.log(`[voice] folded ${plan.upTo} older turns into the conversation summary`)
      })
      .catch(() => this.log('[voice] conversation summary failed; recent turns are still sent verbatim'))
      .finally(() => {
        if (this.summarizing === ctl) this.summarizing = null
      })
  }

  /** Always the same tools in the same order for a session, so the tool list stays in the cached prefix. */
  private toolsForRequest(): { tools?: ChatTool[] } {
<<<<<<< HEAD
    const tools = [...(this.prefTools ? PREFERENCE_TOOLS : []), ...(this.compose ? composeTools(this.deps.compose!.destinations) : [])]
=======
    const tools = [
      ...(this.prefTools ? PREFERENCE_TOOLS : []),
      ...(this.compose ? composeTools(this.deps.compose!.destinations) : []),
      ...(this.deps.deck ? DECK_TOOLS : [])
    ]
>>>>>>> origin/main
    return tools.length ? { tools } : {}
  }

  private composeGuide(): string | null {
    return this.compose ? composeGuide(this.deps.compose!.destinations) : null
<<<<<<< HEAD
=======
  }

  /** Study material for a deck, looked up by what the deck is about as well as what was said. */
  private deckMaterial(reply: Reply, call: ToolCall): string | null {
    const topic = String((call.input as Record<string, unknown> | null)?.topic ?? '')
    try {
      return this.deps.study?.hasMaterial() ? this.deps.study.contextFor(`${reply.question}\n${topic}`) : null
    } catch {
      return null
    }
  }

  private deckGuide(): string | null {
    return this.deps.deck ? DECK_GUIDE : null
>>>>>>> origin/main
  }

  /**
   * Web search and code execution for this request: the rules for the system prompt and the request fields that turn
   * the tools on. Deep dives get more searches, since they research before they teach.
   */
  private research(
    reply: Reply,
    lesson: boolean
  ): { guide: string; options: Pick<ChatRequest, 'webSearch' | 'onSearchStart' | 'webFetch' | 'onFetchStart' | 'codeExecution'> } {
    const cfg = this.deps.config
    const guides: string[] = []
    const options: Pick<ChatRequest, 'webSearch' | 'onSearchStart' | 'webFetch' | 'onFetchStart' | 'codeExecution'> = {}
    if (cfg.webSearchEnabled) {
      guides.push(reply.deep ? (lesson ? WEB_SEARCH_DEEP_LESSON : WEB_SEARCH_DEEP_VERBAL) : lesson ? WEB_SEARCH_LESSON : WEB_SEARCH_GUIDE)
      options.webSearch = { maxUses: reply.deep ? cfg.webSearchDeepMaxUses : cfg.webSearchMaxUses }
      options.onSearchStart = () => this.setSearching(reply, 'search')
      if (cfg.webFetchEnabled) {
        guides.push(WEB_FETCH_GUIDE)
        options.webFetch = { maxUses: reply.deep ? cfg.webFetchDeepMaxUses : cfg.webFetchMaxUses, maxContentTokens: cfg.webFetchMaxTokens }
        options.onFetchStart = () => this.setSearching(reply, 'fetch')
      }
    }
    if (cfg.codeExecutionEnabled) {
      guides.push(CODE_EXECUTION_GUIDE)
      options.codeExecution = true
    }
    return { guide: guides.join('\n\n'), options }
  }

  /** Instruction packs for this reply (see skills/). Logged, so the selection can be checked in the app log. */
  private skillsFor(reply: Reply, whiteboard: boolean): string {
    const names = selectSkills({ whiteboard, deep: reply.deep, practice: reply.practice })
    this.log(`[voice] skills: ${names.join(', ') || 'none'}`)
    return skillsPrompt(names)
  }

  /** "Searching the web…" / "Reading the page…" while a server tool runs, so a quiet moment doesn't look like a hang. */
  private setSearching(reply: Reply, what: 'search' | 'fetch' | false): void {
    if (this.searching === what || (what && this.reply !== reply)) return
    this.searching = what
    const message = what === 'search' ? 'Searching the web…' : what === 'fetch' ? 'Reading the page…' : null
    this.deps.emit({ type: 'lesson-status', status: { level: 'info', message } })
    if (what) this.log(`[voice] web ${what} started`)
  }

  private async runLessonChat(reply: Reply, epoch: number): Promise<void> {
    const support = this.deps.lesson!
    const alive = (): boolean => epoch === this.epoch && this.reply === reply && !reply.abort.signal.aborted
    const board = support.board()
    const io: TurnIO = {
      signal: reply.abort.signal,
      alive,
      speakSentence: (text, force) => {
        this.speakPhrase(reply, { text, flush: false })
        return this.flushSegment(reply, force)
      },
      finishSpeaking: () => {
        if (alive()) this.endClaude(reply)
      },
      status: (status) => this.deps.emit({ type: 'lesson-status', status }),
      metrics: (metrics) => {
        if (this.deps.config.logMetrics) this.log(`[lesson] metrics ${JSON.stringify(metrics)}`)
        this.deps.emit({ type: 'lesson-metrics', metrics })
      },
      log: (m) => this.log(m),
      now: () => this.now()
    }
    const messages = this.history.toMessages(this.deps.config.historyMessages)
    const question = reply.question
    const turn = new LessonTurn({
      io,
      board,
      lesson: this.lessonState,
      question,
      dialogue: messages.slice(0, -1),
      ...(support.pictures ? { pictures: support.pictures } : {})
    })
    reply.lessonTurn = turn
    const parser = new SegmentStreamParser()
    let first = true
    const deliver = (seg: ParsedSegment): void => {
      turn.onTutorSegment(first ? this.withPicture(reply, seg) : seg)
      first = false
    }
    try {
      const [lessonContext, context] = await Promise.all([
        this.lessonContextFor(board),
        this.deps.contextProvider?.getContext().catch(() => null) ?? null
      ])
      if (!alive()) return
      const research = this.research(reply, true)
      const prefs = this.preferenceParts()
      const study = this.studyParts(reply)
      await this.deps.chat.stream({
<<<<<<< HEAD
        system: buildSystemPrompt(prefs.guide, this.composeGuide(), LESSON_PROMPT_ADDENDUM, this.skillsFor(reply, true), research.guide, study.guide),
=======
        system: buildSystemPrompt(prefs.guide, this.composeGuide(), this.deckGuide(), LESSON_PROMPT_ADDENDUM, this.skillsFor(reply, true), research.guide, study.guide),
>>>>>>> origin/main
        systemTail: prefs.tail,
        // The whiteboard reaches the tutor through <lesson_context>, the screen through <screen_context>.
        turnContext: buildTurnContext(
          context,
          reply.filler,
<<<<<<< HEAD
          [lessonContext, study.context, this.compose?.turnNote(), this.pictureNote(reply, true), this.repairNotes(reply, !!context?.screenImage, true)].filter(Boolean).join('\n\n') || null
=======
          [lessonContext, study.context, this.compose?.turnNote(), this.deps.deck?.turnNote(), this.pictureNote(reply, true), this.repairNotes(reply, !!context?.screenImage, true)].filter(Boolean).join('\n\n') || null
>>>>>>> origin/main
        ),
        maxTokens: Math.max(this.deps.config.claudeMaxTokens, reply.deep ? DEEP_MAX_TOKENS : LESSON_MAX_TOKENS),
        deep: reply.deep,
        tier: reply.tier,
        ...this.reasoningFor(reply, true),
        ...this.toolsForRequest(),
        ...research.options,
        onToolUse: (call) => (alive() ? this.onToolUse(reply, call) : undefined),
        onResult: (result) => alive() && this.onChatResult(reply, result),
        messages,
        image: context?.screenImage,
        signal: reply.abort.signal,
        onText: (delta) => {
          if (!alive()) return
          this.setSearching(reply, false)
          if (reply.tFirstText === undefined) reply.tFirstText = this.now()
          for (const seg of parser.push(delta)) deliver(seg)
        }
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
      this.abandonReply(reply, message)
      return
    }
    if (!alive()) return
    for (const seg of parser.end()) deliver(seg)
    turn.onTutorDone()
  }

  private pictureId(reply: Reply): string {
    return `picture_${reply.id}`
  }

  /**
   * A picture request: look the picture up (opening the whiteboard alongside, if it is closed). The lookup is
   * cached, so placing it on the board later finds it again at once.
   */
  private async preparePicture(reply: Reply): Promise<void> {
    const lesson = this.deps.lesson
    const picture = reply.picture!
    if (!lesson?.pictures) return
    const lookup = lesson.pictures.find({ search: picture.subject }, reply.abort.signal)
    const open = lesson.available() || (lesson.open ? await lesson.open(LESSON_OPEN_TIMEOUT_MS).catch(() => false) : false)
    if (!open) return
    picture.found = await timeout(lookup, PICTURE_WAIT_MS).catch(() => null)
    this.log(`[voice] picture request "${picture.subject}": ${picture.found ? 'found' : 'none found'}`)
  }

  /** What the tutor is told about a picture request: what is on the board, or that there is nothing to show. */
  private pictureNote(reply: Reply, boardOpen: boolean): string | null {
    const p = reply.picture
    if (!p) return null
    if (boardOpen && p.found) {
      return `<picture_request>
The learner asked to see a picture of "${p.subject}". The app found one (Wikimedia Commons file "${p.found.title}") and puts it on the whiteboard with id "${this.pictureId(reply)}" in your first segment. Start by pointing the learner to it in one sentence, then say briefly what it shows. You can't see it, so describe the subject, not this photo. You may label or highlight it; don't draw another picture of it or a shape labelled with its name.
</picture_request>`
    }
    const why = boardOpen ? 'no picture of it could be found' : "pictures can't be shown right now because the whiteboard isn't available"
    return `<picture_request>
The learner asked to see a picture of "${p.subject}", but ${why}. Say so plainly in one sentence, then describe what it looks like in a few spoken sentences. Never present its name, or a shape labelled with it, as the picture.
</picture_request>`
  }

  /** Makes sure the first segment of a picture request shows the picture, whatever the tutor drew. */
  private withPicture(reply: Reply, seg: ParsedSegment): ParsedSegment {
    const p = reply.picture
    if (!p?.found) return seg
    const plan = seg.drawing?.plan
    if (plan && [...plan.setup, ...plan.cues.flatMap((c) => c.ops)].some((op) => op.op === 'image')) return seg
    const image: VisualPlan['setup'][number] = { op: 'image', id: this.pictureId(reply), search: p.subject, size: 'large' }
    const setup = [image, ...(plan?.setup ?? [])].slice(0, 8)
    return { ...seg, drawing: { plan: { ...(plan ?? { cues: [] }), no_visual: false, setup } } }
  }

  /** Notes for the model when the question may have been misheard, or points at something it can't see. */
  private repairNotes(reply: Reply, screenShared: boolean, boardOpen: boolean): string | null {
    const notes = [
      misheardNote(reply.unsure),
      danglingReferenceNote(reply.question, { screenShared, boardOpen, hasHistory: reply.hadHistory })
    ].filter(Boolean)
    return notes.length ? notes.join('\n\n') : null
  }

  /** The guide (system prompt) and this turn's passages (turn context) from the learner's study material. */
  private studyParts(reply: Reply): { guide: string | null; context: string | null } {
    const study = this.deps.study
    if (!study?.hasMaterial()) return { guide: null, context: null }
    // A follow-up ("and the second step?") is searched together with the question before it.
    const previous = this.history
      .toMessages(4)
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .slice(-2, -1)
    try {
      return { guide: STUDY_MATERIAL_GUIDE, context: study.contextFor([reply.question, ...previous].join('\n')) }
    } catch {
      return { guide: STUDY_MATERIAL_GUIDE, context: null }
    }
  }

  /** The tutor only knows about the board through this: topic and progress, what is drawn (with ids), the selection. */
  private async lessonContextFor(board: LessonBoardPort | null): Promise<string | null> {
    const parts: string[] = []
    if (board) {
      try {
        const scene = await timeout(board.getScene(), 1500)
        const selected = await timeout(board.getSelected(), 800).catch(() => [])
        parts.push(`Whiteboard now:\n${describeBoardForTutor(summarizeBoard(scene.elements, scene.viewport), summarizeSelection(selected))}`)
      } catch {
        // No board access this turn: the tutor simply isn't told anything about it.
      }
    }
    const state = this.lessonState.describeForTutor()
    if (state) parts.unshift(state)
    return parts.length ? `<lesson_context>\n${parts.join('\n\n')}\n</lesson_context>` : null
  }

  private async runChat(reply: Reply, epoch: number, needsRoute: boolean): Promise<void> {
    const alive = (): boolean => epoch === this.epoch && this.reply === reply && !reply.abort.signal.aborted
    const lesson = this.deps.lesson
    if (reply.localText !== null) {
      this.speakLocally(reply, reply.localText)
      return
    }
    if (needsRoute) {
      const action = await this.routeLesson(reply)
      if (!alive()) return
      if (action === 'close_lesson') return this.closeLessonByVoice(reply)
      reply.deep = action === 'deep_dive'
      if (action === 'practice') this.practiceTurnsLeft = PRACTICE_MAX_TURNS
      if (action === 'end_practice') this.practiceTurnsLeft = 0
    }
    // A practice activity keeps its pack loaded while the learner answers, up to PRACTICE_MAX_TURNS turns.
    if (this.practiceTurnsLeft > 0) {
      reply.practice = true
      this.practiceTurnsLeft -= 1
    }
    if (reply.deep && lesson?.open && !lesson.available()) {
      // The lesson starts as soon as the board can be drawn on (a wait line covers a slow open).
      const opened = await lesson.open(LESSON_OPEN_TIMEOUT_MS).catch(() => false)
      if (!alive()) return
      if (!opened) this.log('[voice] lesson window did not open in time; explaining without the whiteboard')
    }
    if (reply.picture) {
      await this.preparePicture(reply)
      if (!alive()) return
    }
    this.chooseTier(reply, !!lesson?.available())
    if (lesson?.available()) return this.runLessonChat(reply, epoch)
    try {
      const context = (await this.deps.contextProvider?.getContext().catch(() => null)) ?? null
      if (!alive()) return
      const research = this.research(reply, false)
      const prefs = this.preferenceParts()
      const study = this.studyParts(reply)
      await this.deps.chat.stream({
<<<<<<< HEAD
        system: buildSystemPrompt(prefs.guide, this.composeGuide(), this.skillsFor(reply, false), research.guide, study.guide),
=======
        system: buildSystemPrompt(prefs.guide, this.composeGuide(), this.deckGuide(), this.skillsFor(reply, false), research.guide, study.guide),
>>>>>>> origin/main
        systemTail: prefs.tail,
        turnContext: buildTurnContext(
          context,
          reply.filler,
<<<<<<< HEAD
          [study.context, this.compose?.turnNote(), this.pictureNote(reply, false), this.repairNotes(reply, !!context?.screenImage, false)].filter(Boolean).join('\n\n') || null
=======
          [study.context, this.compose?.turnNote(), this.deps.deck?.turnNote(), this.pictureNote(reply, false), this.repairNotes(reply, !!context?.screenImage, false)].filter(Boolean).join('\n\n') || null
>>>>>>> origin/main
        ),
        ...(reply.deep ? { maxTokens: Math.max(this.deps.config.claudeMaxTokens, DEEP_VERBAL_MAX_TOKENS), deep: true } : { tier: reply.tier }),
        ...this.reasoningFor(reply, false),
        ...this.toolsForRequest(),
        ...research.options,
        onToolUse: (call) => (alive() ? this.onToolUse(reply, call) : undefined),
        onResult: (result) => alive() && this.onChatResult(reply, result),
        messages: this.history.toMessages(this.deps.config.historyMessages),
        image: context?.screenImage,
        signal: reply.abort.signal,
        onText: (delta) => {
          if (!alive()) return
          this.setSearching(reply, false)
          this.onClaudeText(reply, delta)
        }
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
      // The transcript keeps what was written; the voice gets it as a speaker would say it.
      const spoken = normalizeForSpeech(phrase.text)
      this.echo.noteSpoken(spoken, this.now())
      this.tts?.speak(spoken + ' ')
      this.updateReplyEntry(reply)
    }
    if (phrase.flush) this.flushSegment(reply, false)
  }

  /** Returns the audio segment index that was flushed, or null when nothing was (empty, or out of flush budget). */
  private flushSegment(reply: Reply, force: boolean): number | null {
    if (!reply.sinceFlush || !this.tts) return null
    // Deepgram allows only ~20 flushes a minute: hold text for a bigger group when out of budget.
    if (!force && !this.tts.canFlush()) return null
    const index = this.tts.flush()
    reply.segments[index] = { end: reply.fullText.length }
    reply.sinceFlush = ''
    return index
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
    if (r.waitTimer) clearTimeout(r.waitTimer)
    r.waitTimer = null
    this.setSearching(r, false)
    if (!interrupted) r.lessonTurn?.onComplete()
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
      this.history.commitAssistant(this.withoutFiller(r, delivered), this.historyNote(r, false))
      this.maybeSummarize()
    }
    const entry = this.entries.find((e) => e.id === r.id)
    if (entry) {
      this.upsertEntry({
        ...entry,
        text: r.fullText,
        final: true,
        interrupted,
        spokenChars: interrupted ? delivered.length : r.fullText.length,
        ...(r.sources.length ? { sources: r.sources } : {}),
        ...(r.searchFailed ? { searchFailed: true } : {})
      })
    }
    this.refresh()
    this.onPreferencesChanged() // a voice change made during this reply applies from the next one
    this.scheduleAnnouncement()
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
    this.history.commitAssistant(heard, this.historyNote(r, true))
    this.maybeSummarize()
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
    this.compose?.reset()
    this.summarizing?.abort()
    this.summarizing = null
    this.announcement = null
    this.searching = false
    this.clearDuckTimer()
    if (this.releaseTimer) clearTimeout(this.releaseTimer)
    this.releaseTimer = null
    this.reply?.abort.abort()
    if (this.reply?.waitTimer) clearTimeout(this.reply.waitTimer)
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

const timeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out')), ms)
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e))
    )
  })

export { IDLE_SNAPSHOT }
