import '@fontsource-variable/nunito'
import '@fontsource-variable/jetbrains-mono'
import '@/lib/i18n'
import '@/lib/api-interceptors'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './App.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
