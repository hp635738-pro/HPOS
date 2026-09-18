import { useTheme, ACCENTS } from '../../theme/ThemeContext'
import { PRESETS, PRESET_ORDER } from '../../theme/presets'
import { Check } from '../Icons'

/**
 * Reusable preset chooser — shows 5 distinct presets with live thumbnails.
 * Driven by centralized PRESETS config and ThemeContext.
 */
export function PresetGrid({ onPick }) {
  const { prefs, resolved, setPreset } = useTheme()
  const active = prefs.preset || 'minimal'
  const handle = onPick || setPreset

  return (
    <div style={S.grid}>
      {PRESET_ORDER.map(id => {
        const preset = PRESETS[id]
        const isActive = active === id
        const tokens = preset.tokens[resolved] || preset.tokens.light
        const bg = tokens['--bg']
        const surface = tokens['--surface']
        const rail = tokens['--rail']
        const line = tokens['--line']
        const accent = ACCENTS.find(a => a.id === preset.accent)?.hex || '#2383e2'
        return (
          <button
            key={id}
            onClick={() => handle(id)}
            style={{
              ...S.card,
              borderColor: isActive ? 'var(--accent)' : 'var(--line)',
              background: isActive ? 'var(--accent-soft)' : 'var(--surface)',
              boxShadow: isActive ? '0 0 0 3px var(--accent-soft), 0 8px 24px -12px rgba(0,0,0,.18)' : 'var(--shadow)',
              transform: isActive ? 'translateY(-1px)' : 'none',
            }}
          >
            <span style={{
              ...S.preview,
              background: bg,
              borderColor: line,
              borderRadius: preset.prefs.radius > 14 ? 14 : preset.prefs.radius > 8 ? 10 : 7,
            }}>
              <span style={{
                ...S.miniRail,
                background: rail,
                borderRight: `1px solid ${line}`,
                borderRadius: preset.prefs.railRadius > 10 ? 7 : 5,
              }}>
                <span style={{ ...S.miniMark, background: accent }} />
                <span style={{ ...S.miniLine, opacity: .6 }} />
                <span style={{ ...S.miniLine, opacity: .35 }} />
              </span>
              <span style={S.miniBody}>
                <span style={{
                  ...S.miniHeader,
                  background: surface,
                  borderColor: line,
                  borderRadius: preset.prefs.barRadius ? Math.min(preset.prefs.barRadius, 8) : 5,
                }} />
                <span style={{
                  ...S.miniCard,
                  background: surface,
                  borderColor: line,
                  borderRadius: preset.prefs.radius > 14 ? 12 : 8,
                  boxShadow: preset.effects.shadowStyle === 'deep' ? '0 2px 10px rgba(0,0,0,.14)' :
                             preset.effects.shadowStyle === 'glow' ? '0 4px 16px rgba(139,92,246,.12)' :
                             preset.effects.shadowStyle === 'soft' ? '0 2px 12px rgba(0,0,0,.08)' : 'none',
                }}>
                  <span style={{ ...S.miniPill, background: accent }} />
                </span>
              </span>
              {preset.id === 'aurora' && <span style={S.auroraGlow} />}
            </span>
            <span style={S.cardHead}>
              <span style={{ ...S.cardTitle, color: isActive ? 'var(--accent)' : 'var(--text)' }}>{preset.label}</span>
              {isActive && <span style={S.activeDot}><Check size={10} /></span>}
            </span>
            <span style={S.cardDesc}>{preset.desc}</span>
            <span style={S.cardChar}>{preset.character}</span>
          </button>
        )
      })}
    </div>
  )
}

const S = {
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 },
  card: {
    textAlign: 'left',
    padding: 10,
    border: '2px solid',
    borderRadius: 'var(--radius)',
    transition: 'border-color var(--motion-duration) var(--motion-easing), background var(--motion-duration) var(--motion-easing), box-shadow var(--motion-duration) var(--motion-easing), transform var(--motion-duration) var(--motion-easing)',
    display: 'flex', flexDirection: 'column', gap: 7,
  },
  preview: {
    position: 'relative', display: 'flex', height: 78, borderRadius: 8, overflow: 'hidden', border: '1px solid', flexShrink: 0,
  },
  miniRail: { width: 32, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, paddingTop: 8 },
  miniMark: { width: 10, height: 10, borderRadius: 3 },
  miniLine: { width: 16, height: 2.5, borderRadius: 99, background: 'currentColor', opacity: .25 },
  miniBody: { flex: 1, padding: 6, display: 'flex', flexDirection: 'column', gap: 5 },
  miniHeader: { height: 10, borderRadius: 4, border: '1px solid' },
  miniCard: { flex: 1, borderRadius: 6, border: '1px solid', display: 'flex', alignItems: 'flex-end', padding: 5 },
  miniPill: { width: 22, height: 5, borderRadius: 99 },
  auroraGlow: {
    position: 'absolute', inset: 0, pointerEvents: 'none',
    background: 'radial-gradient(60% 50% at 50% 30%, rgba(139,92,246,.14), transparent 70%)',
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: 6, padding: '0 2px' },
  cardTitle: { fontSize: 13, fontWeight: 800, letterSpacing: '-.2px', flex: 1 },
  activeDot: { width: 16, height: 16, borderRadius: '50%', background: 'var(--accent)', color: 'var(--accent-fg)', display: 'grid', placeItems: 'center' },
  cardDesc: { fontSize: 11.5, color: 'var(--text-2)', fontWeight: 600, padding: '0 2px', lineHeight: 1.35 },
  cardChar: { fontSize: 10.5, color: 'var(--muted)', padding: '0 2px', lineHeight: 1.45, minHeight: 32 },
}
