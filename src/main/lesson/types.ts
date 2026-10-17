// Shared lesson contract between the tutor agent, the visuals agent and the
// lesson controller. The tutor owns the content; the visuals agent owns how
// it is drawn; the controller owns timing.

/** Numeric data the tutor supplies for charts. The visuals agent can only reference it by id, never type numbers. */
export interface DataSeries {
  id: string
  label: string
  unit: string
  xLabel: string
  /** True when the numbers are an example rather than measurements; charts then say so on the board. */
  illustrative: boolean
  source: string | null
  points: Array<{ x: string; y: number }>
}

/** One short unit of teaching: narration plus what the visuals should convey. */
export interface TeachingSegment {
  /** Stable for the whole lesson, e.g. "s3". */
  id: string
  /** Position within this answer (0-based). */
  index: number
  objective: string
  narration: string
  /** Narration split into sentences; visual cues refer to these by index. */
  sentences: string[]
  facts: string[]
  data: DataSeries[]
  /** The tutor's hint that a visual would help. The visuals agent can still decline. */
  wantsVisual: boolean
  /** The user moved to an unrelated subject: draw in a fresh region. */
  newTopic: boolean
}

export type LessonLevel = 'info' | 'warn'

export interface LessonStatus {
  level: LessonLevel
  /** Subtle one-line status, or null to clear it. */
  message: string | null
}

/** Dev timings for one teaching segment (all in ms, relative to when the tutor finished the segment). */
export interface SegmentMetrics {
  segmentId: string
  prepMs?: number
  validatedMs?: number
  setupAppliedMs?: number
  ttsSentMs?: number
  audioStartMs?: number
  /** Cue application delay after the audio for that sentence actually began. */
  cueDelaysMs?: number[]
  mode: 'visual' | 'verbal-only' | 'no-visual-needed'
}
