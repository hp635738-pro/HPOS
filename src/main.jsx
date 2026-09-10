import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { ThemeProvider } from './theme/ThemeContext.jsx'
import { ToastProvider } from './components/ui/Toast.jsx'
import { ModalProvider } from './components/ui/Modal.jsx'
import './index.css'

document.documentElement.dataset.hposApp = 'hpos'

/**
 * Last line of defence against a blank screen. If anything in the tree throws
 * (render or effect), show the error instead of silently unmounting to grey.
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    // eslint-disable-next-line no-console
    console.error('[hpos] crashed:', error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div data-hpos-crash-boundary style={{ padding: 24, fontFamily: 'monospace', fontSize: 13, color: '#16171a' }}>
        <h2 style={{ margin: '0 0 8px' }}>HPOS hit a problem</h2>
        <pre style={{ whiteSpace: 'pre-wrap', color: '#a33' }}>
          {String(this.state.error && this.state.error.message || this.state.error)}
        </pre>
      </div>
    )
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <ToastProvider>
          <ModalProvider>
            <App />
          </ModalProvider>
        </ToastProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
