import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { applyTheme, loadThemeSettings, watchSystemTheme } from './theme'

// Before first paint, so the app never flashes the previous skin.
applyTheme(loadThemeSettings())
watchSystemTheme(loadThemeSettings)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
