import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Companion } from './Companion'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Companion />
  </StrictMode>
)
