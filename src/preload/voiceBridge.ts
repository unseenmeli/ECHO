import type { VoiceCommand, VoiceEvent, VoiceStateReply } from '../shared/voice'

// Type of what the pet and lesson windows may do with the voice session: send
// a small set of validated commands, read state, and subscribe to events.
//
// Type-only on purpose. The implementation is a few lines in each UI preload
// (index.ts, tutor.ts): sandboxed preload scripts cannot require shared chunks.
export interface VoiceApi {
  command(cmd: VoiceCommand): void
  getState(): Promise<VoiceStateReply | null>
  onEvent(cb: (event: VoiceEvent) => void): () => void
  /** Opens a source link in the default browser (http/https only; checked again in the main process). */
  openLink(url: string): void
}
