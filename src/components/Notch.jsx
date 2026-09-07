import { useTheme } from '../theme/ThemeContext'
import { Gear, Folder } from './Icons'

export const TOOLS = [
  { id: 'settings', label: 'Settings', Icon: Gear },
  { id: 'files',      label: 'File',       Icon: Folder },
]

/**
 * The header pill. Extracted so the advanced editor can show a live copy
 * of it while the real header is covered by the full-screen overlay.
 */
export default function Notch({ active, onNavigate }) {
  const { prefs } = useTheme()

  return (
    <div className="notch">
      {TOOLS.map(({ id, label, Icon }) => (
        <button
          key={id}
          className="notch-btn"
          data-on={active === id}
          title={prefs.notchLabels ? undefined : label}
          onClick={() => onNavigate?.(id)}
        >
          <Icon size={prefs.notchIcon} />
          {prefs.notchLabels && label}
        </button>
      ))}
    </div>
  )
}
