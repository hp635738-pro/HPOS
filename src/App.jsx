import { useState, useMemo } from 'react'
import Sidebar, { NAV } from './components/Sidebar'
import Topbar, { TOOLS } from './components/Topbar'
import Settings from './pages/Settings'
import Blank from './pages/Blank'
import CommandPalette from './components/CommandPalette'
import FilesWorkspace from './components/FilesWorkspace'

export default function App() {
  const [view, setView] = useState('overview')
  const [previousView, setPreviousView] = useState('overview')
  // Set to a panel id when the palette jumps straight into Advanced settings.
  const [advancedPage, setAdvancedPage] = useState(null)

  const navigate = (nextView) => {
    if (nextView === 'files') setPreviousView(view)
    setView(nextView)
  }

  if (view === 'files') {
    return <FilesWorkspace onBack={() => setView(previousView)} />
  }

  const allNav = useMemo(() => {
    const out = []
    NAV.forEach((n) => {
      out.push(n)
      if (n.children) n.children.forEach((c) => out.push(c))
    })
    return out
  }, [])

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
        />

        {view === 'settings'
          ? <Settings
              jumpTo={advancedPage}
              onJumped={() => setAdvancedPage(null)}
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
