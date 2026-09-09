import { useTheme } from '../theme/ThemeContext'
import { Sun, Moon, Plus } from './Icons'
import Notch, { TOOLS } from './Notch'
import RuntimeStatus from './RuntimeStatus.jsx'

export { TOOLS }

/**
 * Top bar. The "notch" is an inline pill inside the header holding the
 * primary workspace actions, sat beside the theme and bell buttons.
 * Page-specific actions (e.g. New chat) sit in the same right cluster as
 * independent controls — never inside the notch pill.
 */
export default function Topbar({ title, active, onNavigate, onNewChat }) {
  const { prefs, resolved, set } = useTheme()

  return (
    <header style={{
      ...S.wrap,
      height: prefs.barH,
      padding: `0 ${prefs.barPadX}px`,
      borderBottom: prefs.barBorder ? '1px solid var(--line)' : 'none',
      borderRadius: prefs.barRadius,
      position: prefs.barSticky ? 'sticky' : 'relative',
      top: 0, zIndex: 20,
    }}>
      {prefs.barShowTitle && (
        <h1 style={{
          ...S.title,
          fontSize: prefs.barTitle,
          fontWeight: prefs.barTitleWeight,
        }}>{title}</h1>
      )}

      <div style={{ ...S.right, gap: prefs.barGap }}>
        {prefs.barShowNotch && <Notch active={active} onNavigate={onNavigate} />}

        <RuntimeStatus />

        {onNewChat && (
          <button
            type="button"
            onClick={onNewChat}
            className="hdr-action"
            title="Start a new chat"
            aria-label="New chat"
            style={{ ...S.newChat, height: prefs.barBtn }}
          >
            <Plus size={15} />
            <span>New chat</span>
          </button>
        )}

        {prefs.barShowTheme && (
          <button
            onClick={() => set('theme', resolved === 'dark' ? 'light' : 'dark')}
            title={resolved === 'dark' ? 'Switch to light' : 'Switch to dark'}
            style={{ ...S.iconBtn, width: prefs.barBtn, height: prefs.barBtn }}
          >
            {resolved === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </button>
        )}

      </div>
    </header>
  )
}

const S = {
  wrap: {
    position: 'relative',
    display: 'flex', alignItems: 'center', gap: 16,
    flexShrink: 0,
    background: 'var(--surface)',
    transition: 'background .22s, border-color .22s, height .18s, border-radius .18s',
  },
  title: {
    margin: 0, letterSpacing: '-.3px',
    whiteSpace: 'nowrap', minWidth: 90, zIndex: 2,
  },
  right: { display: 'flex', alignItems: 'center', marginLeft: 'auto', zIndex: 2 },
  iconBtn: {
    position: 'relative',
    borderRadius: 'var(--radius-sm)', flexShrink: 0,
    display: 'grid', placeItems: 'center',
    color: 'var(--text-2)',
    border: '1px solid var(--line)',
    background: 'var(--surface-2)',
    transition: 'border-radius .18s, background .22s',
  },
  newChat: {
    padding: '0 11px', flexShrink: 0, width: 'auto',
    display: 'inline-flex', alignItems: 'center', gap: 6,
    fontSize: 12.5, fontWeight: 700, letterSpacing: '-.1px',
    lineHeight: 1, whiteSpace: 'nowrap',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-2)',
    border: '1px solid var(--line)',
    background: 'var(--surface-2)',
    cursor: 'pointer',
    transition: 'background .16s, color .16s',
  },
}
