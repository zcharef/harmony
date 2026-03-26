import '@fontsource-variable/nunito'
import '@fontsource-variable/jetbrains-mono'
import '@/lib/i18n'
import '@/lib/api-interceptors'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { env } from '@/lib/env'
import { initSentry } from '@/lib/sentry'
import App from './App'
import './App.css'

initSentry(env.VITE_SENTRY_DSN)

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
