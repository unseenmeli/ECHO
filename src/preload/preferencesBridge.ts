import type { PreferenceCommand, PreferenceCommandResult, PreferenceEvent, PreferencesView } from '../shared/preferences'

// What a UI window may do with the saved preferences: read them, send a small set of validated commands
// (edit, forget, undo) and subscribe to changes.
//
// Type-only on purpose. The implementation is a few lines in each UI preload (index.ts, tutor.ts,
// preferences.ts): sandboxed preload scripts cannot require shared chunks.
export interface PreferencesApi {
  get(): Promise<PreferencesView | null>
  command(cmd: PreferenceCommand): Promise<PreferenceCommandResult>
  onEvent(cb: (event: PreferenceEvent) => void): () => void
}
