/// <reference types="electron-vite/node" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** ECHO's server, baked in at build time: MAIN_VITE_ECHO_BACKEND_URL=https://… npm run app:mac */
  readonly MAIN_VITE_ECHO_BACKEND_URL?: string
}
