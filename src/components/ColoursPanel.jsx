import { useTheme, TOKENS } from '../theme/ThemeContext'
import ColourField from './ColourField'

// Text colours live in the System text page.
const GROUPS = ['Surfaces', 'Sidebar', 'Status']

/**
 * Full palette editor. Overrides are stored per theme, so light and dark
 * are edited independently — the active theme decides which set you touch.
 */
export default function ColoursPanel() {
  const { resolved, basePalette, token, setToken, clearTokens, prefs } = useTheme()

  const overrides = (resolved === 'dark' ? prefs.customDark : prefs.customLight) || {}
  const count = Object.keys(overrides).length

  return (
    <>
      <section style={S.bar}>
        <span style={S.tag}>
          Editing <b style={{ textTransform: 'capitalize' }}>{resolved}</b> theme
        </span>
        <span style={S.hint}>
          Switch the theme to edit the other palette. Text colours are in System text.
        </span>
        <button
          onClick={clearTokens}
          disabled={!count}
          style={{ ...S.clear, opacity: count ? 1 : 0.35 }}
        >
          Restore defaults{count ? ` (${count})` : ''}
        </button>
      </section>

      {GROUPS.map((g) => (
        <section key={g} style={S.card}>
          <div style={S.groupHead}>{g}</div>
          {TOKENS.filter((t) => t.group === g).map((t, i, arr) => (
            <div
              key={t.key}
              style={{
                ...S.row,
                borderBottom: i === arr.length - 1 ? 'none' : '1px solid var(--line)',
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={S.label}>{t.name}</span>
                <span style={S.code}>{t.key}</span>
              </span>
              <ColourField
                value={token(t.key)}
                dirty={token(t.key) !== basePalette[t.key]}
                onChange={(v) => setToken(t.key, v)}
                onReset={() => setToken(t.key, null)}
              />
            </div>
          ))}
        </section>
      ))}
    </>
  )
}

const S = {
  bar: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '12px 16px', marginBottom: 6,
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 8,
  },
  tag: {
    fontSize: 12, fontWeight: 600, color: 'var(--text)',
    flexShrink: 0,
  },
  hint: {
    fontSize: 11.5, color: 'var(--muted)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  clear: {
    marginLeft: 'auto', flexShrink: 0,
    height: 30, padding: '0 13px',
    border: '1px solid var(--line)', borderRadius: 4,
    background: 'var(--surface-2)',
    fontSize: 11.5, fontWeight: 600, color: 'var(--text)',
  },

  card: {
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 8, marginBottom: 6,
    padding: '0 16px',
  },
  groupHead: {
    fontSize: 10.5, fontWeight: 800, letterSpacing: '.5px',
    color: 'var(--muted)', textTransform: 'uppercase',
    padding: '14px 0 4px',
  },
  row: {
    display: 'flex', alignItems: 'center', gap: 16,
    padding: '12px 0',
  },
  label: { display: 'block', fontSize: 13, fontWeight: 600 },
  code: {
    display: 'block', fontSize: 11, color: 'var(--muted)', marginTop: 2,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
}
