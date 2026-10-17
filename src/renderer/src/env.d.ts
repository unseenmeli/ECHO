/// <reference types="vite/client" />
import type { CompanionApi } from '../../preload'
import type { TutorApi } from '../../preload/tutor'
import type { VoiceApi } from '../../preload/voiceBridge'
import type { VoiceEngineApi } from '../../preload/voiceEngine'

declare global {
  interface Window {
    companion: CompanionApi
    tutor: TutorApi
    voice: VoiceApi
    voiceEngine: VoiceEngineApi
  }
}
