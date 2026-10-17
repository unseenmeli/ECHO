import type { ChatMessage } from './history'

// Narrow interfaces the session depends on. The real implementations talk to
// Deepgram and Anthropic; the session tests plug in controllable fakes here.

export type TurnEventName = 'StartOfTurn' | 'Update' | 'EagerEndOfTurn' | 'TurnResumed' | 'EndOfTurn'

export interface TurnInfo {
  event: TurnEventName
  turnIndex: number
  transcript: string
}

export type LinkStatus =
  | { kind: 'connected' }
  | { kind: 'reconnecting'; attempt: number }
  | { kind: 'fatal'; message: string }

export interface SttPort {
  connect(): void
  sendAudio(pcm16: Buffer): void
  /** Ask the model to end the current turn now (push-to-talk release). */
  forceEndTurn(): void
  close(): void
}

export interface SttHooks {
  onTurn(info: TurnInfo): void
  onStatus(status: LinkStatus): void
}

export interface TtsPort {
  /** Open the socket ahead of time so the first phrase doesn't pay the handshake. */
  ensureConnected(): void
  /** Start a new response; audio and flush acks from now on belong to it. */
  begin(responseId: string): void
  speak(text: string): void
  canFlush(): boolean
  /** Synthesize everything sent since the last flush. Returns the segment index. */
  flush(): number
  /** Drop queued text and any audio still in flight. */
  clear(): void
  close(): void
}

export interface TtsHooks {
  onAudio(responseId: string, pcm16: Buffer): void
  /** Audio for flush segment `segment` has been fully delivered. */
  onFlushed(responseId: string, segment: number): void
  onError(responseId: string | null, message: string, fatal: boolean): void
}

export interface ScreenImage {
  mediaType: 'image/jpeg'
  /** Base64-encoded image bytes. */
  data: string
}

export interface ChatRequest {
  system: string
  /** Overrides the configured reply budget (lesson replies carry segment markup). */
  maxTokens?: number
  /** Use the deep-dive model for this request. */
  deep?: boolean
  messages: ChatMessage[]
  /** Screenshot for this turn only; attached to the latest user message, never stored in history. */
  image?: ScreenImage
  signal: AbortSignal
  onText(delta: string): void
}

export interface ChatPort {
  stream(req: ChatRequest): Promise<void>
}

export type ChatErrorKind = 'auth' | 'rate-limit' | 'network' | 'other'

export class ChatError extends Error {
  constructor(
    readonly kind: ChatErrorKind,
    message: string
  ) {
    super(message)
  }
}

/** Commands from the session to the hidden audio engine window. */
export interface EnginePort {
  start(muted: boolean, bargeInMs: number): void
  stop(): void
  setMuted(muted: boolean): void
  sendAudio(responseId: string, pcm16: Buffer): void
  segmentMarker(responseId: string, segment: number): void
  /** No more audio is coming for this response; report when playback drains. */
  responseDone(responseId: string): void
  /** Silence playback immediately and discard anything queued for this response. */
  clearPlayback(responseId: string): void
  duck(on: boolean): void
}

export interface VoiceContext {
  /** What the app knows about the screen, for the system prompt. */
  screen?: string
  screenImage?: ScreenImage
  board?: string
}

/** Screen / whiteboard context, fetched once per reply. */
export interface VoiceContextProvider {
  /** True when getContext() will include a screenshot. Must be cheap: it's checked as the turn ends. */
  isWatchingScreen?(): boolean
  getContext(): Promise<VoiceContext | null>
}
