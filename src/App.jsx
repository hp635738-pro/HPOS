import { useState, useMemo, useRef } from 'react'
import Sidebar, { NAV } from './components/Sidebar'
import Topbar, { TOOLS } from './components/Topbar'
import Settings from './pages/Settings'
import Blank from './pages/Blank'
import Notes from './pages/Notes'
import GameView from './pages/GameView'
import Chats from './pages/Chats'
import RuntimeDetailsPanel from './components/RuntimeDetailsPanel'
import CommandPalette from './components/CommandPalette'
import FilesWorkspace from './components/FilesWorkspace'
import { usePanelExit } from './lib/panelTransition'

// Rail destinations with real page content. Everything else renders the
// Blank canvas. Add a sidebar entry in Sidebar.NAV + map its id here.
const PAGES = {
  notes: Notes,
  gameview: GameView,
  messages: Chats,
}

export default function App() {
  const [view, setView] = useState('overview')
  const [previousView, setPreviousView] = useState('overview')
  // Set to a panel id when the palette jumps straight into Advanced settings.
  const [advancedPage, setAdvancedPage] = useState(null)
  // Full-panel runtime details overlay, opened by holding the header status
  // container. Rendered above the main view so it works from any page.
  const [runtimeDetailsOpen, setRuntimeDetailsOpen] = useState(false)
  const runtimeStatusRef = useRef(null)

  const navigate = (nextView) => {
    if (nextView === 'files') setPreviousView(view)
    setView(nextView)
  }

  // page transition key — triggers re-animation on view change

  const openRuntimeDetails = () => {
    setRuntimeDetailsOpen(true)
  }

  // Closing returns focus to the header status container.
  const closeRuntimeDetails = () => {
    setRuntimeDetailsOpen(false)
    requestAnimationFrame(() => runtimeStatusRef.current?.focus())
  }

  const allNav = useMemo(() => {
    const out = []
    NAV.forEach((n) => {
      out.push(n)
      if (n.children) n.children.forEach((c) => out.push(c))
    })
    return out
  }, [])

  // The File section is a full-panel destination that slides + fades in
  // instead of appearing instantly. It stays mounted while its exit
  // animation plays (see lib/panelTransition.js).
  const filesPanel = usePanelExit(view === 'files')

  const filesStage = (exiting) => (
    <div className={exiting ? 'file-out' : 'file-in'} style={S.filesStage}>
      <FilesWorkspace onBack={exiting ? () => {} : () => setView(previousView)} />
    </div>
  )

  // NOTE: all hooks must stay above this early return — otherwise React
  // throws "rendered fewer hooks" and unmounts the whole tree (blank screen).
  if (view === 'files') {
    return filesStage(filesPanel.exiting)
  }
  if (filesPanel.exiting && filesPanel.mounted) {
    return filesStage(true)
  }

  const title =
    allNav.find((n) => n.id === view)?.label ??
    TOOLS.find((t) => t.id === view)?.label ??
    ''

  // True for both top-level nav items and their nested children.
  // Settings is excluded on purpose: it is a header destination, so the
  // Topbar (never the rail) owns its active state and the header gear stays
  // the Settings entry point.
  const inRail = view !== 'settings' && allNav.some((n) => n.id === view)

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
          onOpenRuntimeDetails={openRuntimeDetails}
          runtimeStatusRef={runtimeStatusRef}
        />

{runtimeDetailsOpen
  ? <div key="runtime" className="page-transition" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}><RuntimeDetailsPanel onBack={closeRuntimeDetails} /></div>
  : view === 'settings'
    ? <div key="settings" className="page-transition" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}><Settings
      jumpTo={advancedPage}
      onJumped={() => setAdvancedPage(null)}
    /></div>
    : (() => {
        const Page = PAGES[view]
        return <div key={view} className="page-transition" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>{Page ? <Page /> : <Blank />}</div>
      })()}
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
    background: 'var(--app-bg, var(--bg))',
    transition: 'background var(--motion-duration) var(--motion-easing)',
  },
  main: {
    flex: 1, minWidth: 0,
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
  },
  filesStage: {
    position: 'fixed', inset: 0, zIndex: 40,
    background: 'var(--app-bg, var(--bg))',
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
  },
}
