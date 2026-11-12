import '@fontsource-variable/inter'
import './styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { OverlayApp } from './OverlayApp'
import { SettingsWindow } from './components/SettingsWindow'

// Stesso bundle per le due finestre: la vista arriva nell'hash dell'URL (#overlay, #settings).
const view = window.location.hash.slice(1) || 'overlay'
document.body.classList.add(`view-${view}`)
const root = createRoot(document.getElementById('root')!)

if (import.meta.env.DEV && view === 'demo') {
  // Galleria degli stati con dati di esempio (solo in sviluppo, per controllare l'aspetto).
  void import('./demo').then((m) => m.renderDemo(root))
} else {
  root.render(
    <StrictMode>
      {view === 'settings' ? <SettingsWindow /> : <OverlayApp api={window.poe} />}
    </StrictMode>
  )
}
