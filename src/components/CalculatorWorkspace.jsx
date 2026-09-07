import { useState } from 'react'
import { useTheme } from '../theme/ThemeContext'

const KEYS = [
  ['clear', 'C', 'utility'], ['sign', '+/−', 'utility'], ['percent', '%', 'utility'], ['÷', '÷', 'operator'],
  ['7', '7'], ['8', '8'], ['9', '9'], ['×', '×', 'operator'],
  ['4', '4'], ['5', '5'], ['6', '6'], ['−', '−', 'operator'],
  ['1', '1'], ['2', '2'], ['3', '3'], ['+', '+', 'operator'],
  ['0', '0', 'wide'], ['.', '.'], ['equals', '=', 'operator'],
]

const toExpression = (value) => value.replaceAll('×', '*').replaceAll('÷', '/').replaceAll('−', '-')

function evaluate(value, precision) {
  const expression = toExpression(value)
  if (!expression || !/^[0-9+\-*/.()\s]+$/.test(expression)) return null
  try {
    const result = Function('"use strict"; return (' + expression + ')')()
    return Number.isFinite(result) ? String(Number(result.toFixed(precision))) : null
  } catch {
    return null
  }
}

export default function CalculatorWorkspace({ onBack }) {
  const { prefs } = useTheme()
  const [expression, setExpression] = useState('')
  const [display, setDisplay] = useState('0')

  const commit = (next) => {
    setExpression(next)
    setDisplay(next || '0')
  }

  const press = (value) => {
    if (value === 'clear') return commit('')
    if (value === 'sign') return commit(expression.startsWith('−') ? expression.slice(1) : '−' + (expression || '0'))
    if (value === 'percent') {
      const result = evaluate(expression || display, prefs.calcPrecision)
      return commit(result == null ? expression : String(Number(result) / 100))
    }
    if (value === 'equals') {
      const result = evaluate(expression, prefs.calcPrecision)
      if (result == null) return setDisplay('Error')
      return commit(result)
    }
    const operator = ['+', '−', '×', '÷'].includes(value)
    const next = display === 'Error' ? value : expression + value
    if (operator && !expression) return commit(display + value)
    commit(next)
  }

  return (
    <section style={S.overlay} onMouseDown={onBack} aria-label="Calculator overlay">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Calculator"
        style={{ ...S.calculator, width: prefs.calcWidth }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div style={{ ...S.display, minHeight: prefs.calcDisplayHeight }}>
          <span style={S.expression}>{expression || ' '}</span>
          <output style={S.result}>{display}</output>
        </div>

        <div style={{ ...S.keypad, gap: prefs.calcGap }}>
          {KEYS.map(([value, label, kind]) => (
            <button
              key={value}
              type="button"
              onClick={() => press(value)}
              style={{
                ...S.key,
                height: prefs.calcKeySize,
                ...(kind === 'utility' ? S.utility : {}),
                ...(kind === 'operator' ? S.operator : {}),
                ...(kind === 'wide' ? { ...S.wide, borderRadius: prefs.calcKeySize / 2 } : {}),
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

const S = {
  overlay: { position: 'fixed', inset: 0, zIndex: 70, padding: 24, display: 'grid', placeItems: 'center', overflow: 'auto', background: 'rgba(0,0,0,.48)', backdropFilter: 'blur(5px)' },
  calculator: { padding: 18, borderRadius: 'var(--radius-lg)', background: 'var(--surface)', border: '1px solid var(--line)', boxShadow: '0 24px 70px -18px rgba(0,0,0,.68)' },
  display: { padding: '8px 10px 18px', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', justifyContent: 'flex-end', overflow: 'hidden', color: 'var(--text)' },
  expression: { minHeight: 22, fontSize: 18, color: 'var(--muted)', whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' },
  result: { marginTop: 2, fontSize: 48, lineHeight: 1.12, letterSpacing: '-1.5px', fontWeight: 400, whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' },
  keypad: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)' },
  key: { borderRadius: '50%', background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 25, fontWeight: 500, boxShadow: '0 5px 10px -8px rgba(0,0,0,.75)' },
  utility: { background: 'var(--line)', color: 'var(--text)', fontSize: 22 },
  operator: { background: 'var(--accent)', color: 'var(--accent-fg)', borderColor: 'transparent', fontSize: 31, fontWeight: 700 },
  wide: { gridColumn: 'span 2' },
}
