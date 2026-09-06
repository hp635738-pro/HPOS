import { useTheme } from '../theme/ThemeContext'
import { Sun, Moon } from './Icons'
import Notch, { TOOLS } from './Notch'

export { TOOLS }

/**
 * Top bar. The "notch" is an inline pill inside the header holding the
 * primary workspace actions, sat beside the theme and bell buttons.
 */
export default function Topbar({ title, active, onNavigate }) {
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
}
