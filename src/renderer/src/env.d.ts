/// <reference types="vite/client" />
import type { CompanionApi } from '../../preload'
import type { TutorApi } from '../../preload/tutor'

declare global {
  interface Window {
    companion: CompanionApi
    tutor: TutorApi
  }
}
