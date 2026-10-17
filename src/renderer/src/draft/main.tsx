import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DraftCard } from './DraftCard'
import './draft.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DraftCard />
  </StrictMode>
)
