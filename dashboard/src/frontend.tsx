import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './index.css'

const media = matchMedia('(prefers-color-scheme: dark)')
media.addEventListener('change', e => document.documentElement.classList.toggle('dark', e.matches))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
