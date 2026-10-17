// Contracts for the voice conversation feature. Shared by the main process
// (which owns credentials, STT, Claude and TTS), the hidden audio engine
// window (microphone, VAD, playback) and the UI windows.

export type VoiceState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'user-speaking'
  | 'thinking'
  | 'speaking'
  | 'paused'
  | 'error'

export interface VoiceSnapshot {
  state: VoiceState
  /** Microphone muted by the user. */
  muted: boolean
  /** Hold-to-talk mode: the mic only transmits while the talk button is held. */
  pushToTalk: boolean
  /** Talk button currently held. */
  talking: boolean
  /** Human-readable status line (errors, reconnecting…). Never contains credentials. */
  message: string | null
}

export const IDLE_SNAPSHOT: VoiceSnapshot = {
  state: 'idle',
  muted: false,
  pushToTalk: false,
  talking: false,
  message: null
}

export interface TranscriptEntry {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** User entries: false while still being transcribed. Assistant: false while generating/speaking. */
  final: boolean
  /** Assistant entries: how many leading characters of `text` have actually been played. */
  spokenChars?: number
  /** Assistant entries: the user cut this reply off. */
  interrupted?: boolean
}

export interface VoiceMetrics {
  responseId: string
  /** ms after the end of the user's turn was detected. */
  firstClaudeText?: number
  firstTtsAudio?: number
  firstAudioPlayed?: number
  /** ms from interruption detection until playback was silenced. */
  interruptToStop?: number
}

/** Subtle status about the whiteboard side of a lesson (e.g. "Preparing the drawing…"). */
export interface LessonStatus {
  level: 'info' | 'warn'
  /** null clears the status. */
  message: string | null
}

/** Development timings for one teaching segment (ms; see src/main/lesson/controller.ts). */
export interface LessonSegmentMetrics {
  segmentId: string
  mode: 'visual' | 'verbal-only' | 'no-visual-needed'
  prepMs?: number
  setupAppliedMs?: number
  ttsSentMs?: number
  audioStartMs?: number
  cueDelaysMs?: number[]
}

export type VoiceEvent =
  | { type: 'state'; snapshot: VoiceSnapshot }
  | { type: 'lesson-status'; status: LessonStatus }
  | { type: 'lesson-metrics'; metrics: LessonSegmentMetrics }
  | { type: 'entry'; entry: TranscriptEntry }
  | { type: 'metrics'; metrics: VoiceMetrics }
  | { type: 'reset' }

export type VoiceCommand =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'toggle' }
  | { type: 'mute'; muted: boolean }
  | { type: 'interrupt' }
  | { type: 'push-to-talk-mode'; enabled: boolean }
  | { type: 'talk'; pressed: boolean }

export interface VoiceStateReply {
  snapshot: VoiceSnapshot
  entries: TranscriptEntry[]
}

/** Runtime validation for commands arriving over IPC. */
export function parseVoiceCommand(raw: unknown): VoiceCommand | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  switch (c.type) {
    case 'start':
    case 'stop':
    case 'toggle':
    case 'interrupt':
      return { type: c.type }
    case 'mute':
      return typeof c.muted === 'boolean' ? { type: 'mute', muted: c.muted } : null
    case 'push-to-talk-mode':
      return typeof c.enabled === 'boolean' ? { type: 'push-to-talk-mode', enabled: c.enabled } : null
    case 'talk':
      return typeof c.pressed === 'boolean' ? { type: 'talk', pressed: c.pressed } : null
    default:
      return null
  }
}

// --- Main <-> audio engine window -------------------------------------------

/** Audio the engine sends to Deepgram STT. */
export const MIC_SAMPLE_RATE = 16000
/** Audio Deepgram TTS sends back for playback (linear16 mono). */
export const TTS_SAMPLE_RATE = 24000

export type EnginePlaybackReport =
  | { kind: 'started'; responseId: string; at: number }
  | { kind: 'segment'; responseId: string; segment: number; at: number }
  | { kind: 'segmentStart'; responseId: string; segment: number; at: number }
  | { kind: 'ended'; responseId: string; at: number }
  | { kind: 'stopped'; responseId: string; at: number; partial?: { segment: number; fraction: number } }

export interface EngineStartOptions {
  muted: boolean
  /** Sustained local speech (ms) that counts as interrupting ECHO; 0 disables local barge-in. */
  bargeInMs: number
}

export type EngineErrorCode = 'permission-denied' | 'no-microphone' | 'mic-error' | 'audio-error'

export interface EngineError {
  code: EngineErrorCode
  message: string
}
