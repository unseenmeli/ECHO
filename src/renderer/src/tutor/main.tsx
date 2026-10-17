import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TutorWindow } from './TutorWindow'
import './tutor.css'

// Must be set before Excalidraw loads: where it fetches fonts from.
;(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = new URL(
  './excalidraw-assets/',
  location.href
).href

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TutorWindow />
  </StrictMode>
)
