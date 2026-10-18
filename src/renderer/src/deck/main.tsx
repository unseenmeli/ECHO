import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DeckWindow } from './DeckWindow'
import './deck.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DeckWindow />
  </StrictMode>
)
