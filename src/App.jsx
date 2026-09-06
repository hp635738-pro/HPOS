import { useState } from 'react'
import Sidebar, { NAV } from './components/Sidebar'
import Topbar, { TOOLS } from './components/Topbar'
import Settings from './pages/Settings'
import Blank from './pages/Blank'
import CommandPalette from './components/CommandPalette'

export default function App() {
  const [view, setView] = useState('overview')
  // Set to a panel id when the palette jumps straight into Advanced settings.
  const [advancedPage, setAdvancedPage] = useState(null)

  const title =
    NAV.find((n) => n.id === view)?.label ??
    TOOLS.find((t) => t.id === view)?.label ??
    ''

  const inRail = NAV.some((n) => n.id === view)

  return (
    <div style={S.shell}>
      <Sidebar active={inRail ? view : null} onChange={setView} />

      <main style={S.main}>
        <Topbar
          title={title}
          active={inRail ? null : view}
          onNavigate={setView}
        />

        {view === 'settings'
          ? <Settings
              jumpTo={advancedPage}
              onJumped={() => setAdvancedPage(null)}
            />
          : <Blank />}
      </main>

      <CommandPalette
        onNavigate={setView}
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
