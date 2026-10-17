import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PreferencesWindow } from './PreferencesWindow'
import './preferences.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PreferencesWindow />
  </StrictMode>
)
