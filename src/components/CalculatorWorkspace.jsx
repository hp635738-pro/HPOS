import { useState } from 'react'
import { Chevron, Grid } from './Icons'
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
    if (!Number.isFinite(result)) return null
    return String(Number(result.toFixed(precision)))
  } catch {
    return null
  }
}

export default function CalculatorWorkspace({ onBack }) {
  const { prefs } = useTheme()
  const [expression, setExpression] = useState('')
  const [display, setDisplay] = useState('0')
  const [history, setHistory] = useState([])

  const commit = (next) => {
    setExpression(next)
    setDisplay(next || '0')
  }

  const press = (value) => {
    if (value === 'clear') return commit('')
    if (value === 'sign') {
      const next = expression.startsWith('−') ? expression.slice(1) : '−' + (expression || '0')
      return commit(next)
    }
    if (value === 'percent') {
      const result = evaluate(expression || display, prefs.calcPrecision)
      return commit(result == null ? expression : String(Number(result) / 100))
    }
    if (value === 'equals') {
      const result = evaluate(expression, prefs.calcPrecision)
      if (result == null) return setDisplay('Error')
      if (prefs.calcHistory) setHistory((items) => [{ expression, result }, ...items].slice(0, 8))
      setExpression(result)
      return setDisplay(result)
    }
    const isOperator = ['+', '−', '×', '÷'].includes(value)
    const next = display === 'Error' ? value : expression + value
    if (isOperator && !expression) return commit(display + value)
    commit(next)
  }

  return (
    <section style={S.screen} aria-label="Calculator">
      <header style={S.header}>
        <button type="button" onClick={onBack} style={S.back}>
          <Chevron size={18} dir="left" />
          <span>Back</span>
        </button>
        <div style={S.title}>
          <span style={S.icon}><Grid size={20} /></span>
          <div>
            <h1 style={S.h1}>Calculator</h1>
            <p style={S.sub}>Fast calculations, ready for saved history.</p>
          </div>
        </div>
      </header>

      <main style={S.main}>
        <div style={S.calculator}>
          <div style={S.display}>
            <span style={S.expression}>{expression || ' '}</span>
            <output style={S.result}>{display}</output>
          </div>

          <div style={S.keypad}>
            {KEYS.map(([value, label, kind]) => (
              <button
                key={value}
                type="button"
                onClick={() => press(value)}
                style={{
                  ...S.key,
                  ...(kind === 'utility' ? S.utility : {}),
                  ...(kind === 'operator' ? S.operator : {}),
                  ...(kind === 'wide' ? S.wide : {}),
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {prefs.calcHistory && history.length > 0 && (
          <aside style={S.history}>
            <h2 style={S.historyTitle}>Recent calculations</h2>
            {history.map((item, index) => (
              <button key={index} type="button" onClick={() => commit(item.result)} style={S.historyRow}>
                <span>{item.expression}</span>
                <strong>{item.result}</strong>
              </button>
            ))}
          </aside>
        )}
      </main>
    </section>
  )
}

const S = {
  screen: { width: '100vw', height: '100vh', overflow: 'auto', background: 'var(--bg)', color: 'var(--text)' },
  header: { minHeight: 72, padding: '0 28px', display: 'flex', alignItems: 'center', gap: 22, background: 'var(--surface)', borderBottom: '1px solid var(--line)' },
  back: { display: 'inline-flex', alignItems: 'center', gap: 8, height: 38, padding: '0 13px 0 10px', borderRadius: 'var(--radius-sm)', color: 'var(--text-2)', background: 'var(--surface-2)', border: '1px solid var(--line)', fontSize: 13, fontWeight: 700 },
  title: { display: 'flex', alignItems: 'center', gap: 12 },
  icon: { width: 38, height: 38, display: 'grid', placeItems: 'center', borderRadius: 'var(--radius-sm)', color: 'var(--accent)', background: 'var(--accent-soft)' },
  h1: { margin: 0, fontSize: 18, fontWeight: 800 },
  sub: { margin: '1px 0 0', color: 'var(--muted)', fontSize: 12 },
  main: { maxWidth: 880, margin: '0 auto', padding: '42px 28px', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', gap: 26, flexWrap: 'wrap' },
  calculator: { width: 352, padding: 18, borderRadius: 'var(--radius-lg)', background: 'var(--surface)', border: '1px solid var(--line)', boxShadow: 'var(--shadow)' },
  display: { minHeight: 128, padding: '8px 10px 18px', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', justifyContent: 'flex-end', overflow: 'hidden' },
  expression: { minHeight: 22, fontSize: 18, color: 'var(--muted)', whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' },
  result: { marginTop: 2, fontSize: 48, lineHeight: 1.12, letterSpacing: '-1.5px', fontWeight: 400, whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' },
  keypad: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 },
  key: { height: 64, borderRadius: '50%', background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 25, fontWeight: 500, boxShadow: '0 5px 10px -8px rgba(0,0,0,.75)' },
  utility: { background: 'var(--line)', color: 'var(--text)', fontSize: 22 },
  operator: { background: 'var(--accent)', color: 'var(--accent-fg)', borderColor: 'transparent', fontSize: 31, fontWeight: 700 },
  wide: { gridColumn: 'span 2', borderRadius: 32 },
  history: { width: 250, padding: 18, borderRadius: 'var(--radius-lg)', background: 'var(--surface)', border: '1px solid var(--line)' },
  historyTitle: { margin: '0 0 10px', fontSize: 13, fontWeight: 800 },
  historyRow: { width: '100%', display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderTop: '1px solid var(--line)', color: 'var(--text-2)', fontSize: 12, textAlign: 'left' },
}