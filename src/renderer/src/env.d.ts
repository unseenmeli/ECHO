/// <reference types="vite/client" />
import type { CompanionApi } from '../../preload'

declare global {
  interface Window {
    companion: CompanionApi
  }
}
