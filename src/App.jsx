import { useState, useMemo, useEffect, useRef } from 'react'
import Sidebar, { NAV } from './components/Sidebar'
import Topbar, { TOOLS } from './components/Topbar'
import Settings from './pages/Settings'
import Blank from './pages/Blank'
import ChatPage from './pages/ChatPage'
import CommandPalette from './components/CommandPalette'
import FilesWorkspace from './components/FilesWorkspace'
import { getBrowserBridge } from './lib/bridge'
import { getDeepSeekConnector } from './lib/bridge/DeepSeekConnector.js'
import { startNewChat } from './lib/chat/history.js'

export default function App() {
  const [view, setView] = useState('overview')
  const [previousView, setPreviousView] = useState('overview')
  // Set to a panel id when the palette jumps straight into Advanced settings.
  const [advancedPage, setAdvancedPage] = useState(null)
  // Chat history sidebar (right rail) visibility. Lives here so the header
  // toggle and ChatPage stay in sync.
  const [historyOpen, setHistoryOpen] = useState(true)
  // Full-panel runtime details overlay, opened by holding the header status
  // container. Lives here so the header trigger and ChatPage stay in sync.
  const [runtimeDetailsOpen, setRuntimeDetailsOpen] = useState(false)
  const runtimeStatusRef = useRef(null)

  const navigate = (nextView) => {
    if (nextView === 'files') setPreviousView(view)
    setView(nextView)
  }

  // Details live in the chat area: opening from any page lands in chat.
  const openRuntimeDetails = () => {
    if (view !== 'aiagents') navigate('aiagents')
    setRuntimeDetailsOpen(true)
  }

  // Closing returns focus to the header status container.
  const closeRuntimeDetails = () => {
    setRuntimeDetailsOpen(false)
    requestAnimationFrame(() => runtimeStatusRef.current?.focus())
  }

  // Browser bridge handshake, then DeepSeek tab detect. Safe no-op if extension absent.
  useEffect(() => {
    const bridge = getBrowserBridge()
    const ds = getDeepSeekConnector()
    const off = bridge.onStatus((s) => {
      if (s === 'connected') ds.connect().catch(() => {})
      else ds.disconnect()
    })
    bridge.connect().catch(() => {})
    return off
  }, [])

  const allNav = useMemo(() => {
    const out = []
    NAV.forEach((n) => {
      out.push(n)
      if (n.children) n.children.forEach((c) => out.push(c))
    })
    return out
  }, [])

  // NOTE: all hooks must stay above this early return — otherwise React
  // throws "rendered fewer hooks" and unmounts the whole tree (blank screen).
  if (view === 'files') {
    return <FilesWorkspace onBack={() => setView(previousView)} />
  }

  const title =
    allNav.find((n) => n.id === view)?.label ??
    TOOLS.find((t) => t.id === view)?.label ??
    ''

  // True for both top-level nav items and their nested children.
  const inRail = allNav.some((n) => n.id === view)

  // Pass child id to sidebar (so highlight can track child + parent state).
  const activeInSidebar = inRail ? view : null

  return (
    <div style={S.shell}>
      <Sidebar active={activeInSidebar} onChange={navigate} />

      <main style={S.main}>
        <Topbar
          title={title}
          active={inRail ? null : view}
          onNavigate={navigate}
          onNewChat={view === 'aiagents' ? () => { startNewChat() } : undefined}
          historyOpen={historyOpen}
          onToggleHistory={view === 'aiagents' ? () => setHistoryOpen((v) => !v) : undefined}
          onOpenRuntimeDetails={openRuntimeDetails}
          runtimeStatusRef={runtimeStatusRef}
        />

        {view === 'settings'
          ? <Settings
              jumpTo={advancedPage}
              onJumped={() => setAdvancedPage(null)}
            />
          : view === 'aiagents'
            ? <ChatPage
              historyOpen={historyOpen}
              onCloseHistory={() => setHistoryOpen(false)}
              detailsOpen={runtimeDetailsOpen}
              onBackFromDetails={closeRuntimeDetails}
            />
            : <Blank />}
      </main>

      <CommandPalette
        onNavigate={navigate}
        onOpenAdvanced={(panel) => { setView('settings'); setAdvancedPage(panel) }}
      />
    </div>
  )
}

const S = {
  shell: {
    height: '100vh', width: '100vw',
    display: 'flex', overflow: 'hidden',
    background: 'var(--bg)',
  },
  main: {
    flex: 1, minWidth: 0,
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
  },
}
