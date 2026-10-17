// Contract for screen context. The companion renderer owns the capture stream
// and samples frames; the main process stores them (see src/main/screenContext.ts)
// and hands them to agents.

export type SharingStatus = 'off' | 'sharing' | 'paused'

export interface SharingState {
  status: SharingStatus
  /** What is being shared, e.g. "Built-in Retina Display" or a window title. */
  sourceLabel: string | null
}

/** Why a frame was taken: periodic sampling, or on demand (e.g. a question). */
export type FrameTrigger = 'interval' | 'fresh'

/** A frame as sent from the renderer to the main process. */
export interface FramePayload {
  /** Set when answering a fresh-capture request from the main process. */
  requestId: string | null
  trigger: FrameTrigger
  capturedAt: number
  width: number
  height: number
  mimeType: 'image/jpeg'
  bytes: Uint8Array
}
