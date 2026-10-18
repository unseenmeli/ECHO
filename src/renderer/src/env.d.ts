/// <reference types="vite/client" />
import type { CompanionApi } from '../../preload'
<<<<<<< HEAD
=======
import type { DeckApi } from '../../preload/deck'
>>>>>>> origin/main
import type { DraftApi } from '../../preload/draft'
import type { AccessApi } from '../../preload/preferences'
import type { TutorApi } from '../../preload/tutor'
import type { PreferencesApi } from '../../preload/preferencesBridge'
import type { VoiceApi } from '../../preload/voiceBridge'
import type { VoiceEngineApi } from '../../preload/voiceEngine'

declare global {
  interface Window {
    companion: CompanionApi
    tutor: TutorApi
    voice: VoiceApi
    preferences: PreferencesApi
    voiceEngine: VoiceEngineApi
    draft: DraftApi
<<<<<<< HEAD
=======
    deck: DeckApi
>>>>>>> origin/main
    access: AccessApi
  }
}
