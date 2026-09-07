import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { ThemeProvider } from './theme/ThemeContext.jsx'
import { ToastProvider } from './components/ui/Toast.jsx'
import { ModalProvider } from './components/ui/Modal.jsx'
import './index.css'

document.documentElement.dataset.hposApp = 'hpos'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <ModalProvider>
          <App />
        </ModalProvider>
      </ToastProvider>
    </ThemeProvider>
  </React.StrictMode>
)
