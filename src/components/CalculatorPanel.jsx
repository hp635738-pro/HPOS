import { useTheme } from '../theme/ThemeContext'
import { Card, Row, Toggle } from './ui/Bits'

export default function CalculatorPanel() {
  const { prefs, set } = useTheme()

  return (
    <Card>
      <Row label="Calculation history" hint="Keep recent calculations in the calculator while it is open.">
        <Toggle value={prefs.calcHistory} onChange={(value) => set('calcHistory', value)} />
      </Row>
      <Row label="Decimal precision" hint="Maximum decimal places shown after an answer." last>
        <select value={prefs.calcPrecision} onChange={(e) => set('calcPrecision', +e.target.value)} style={S.select}>
          {[0, 2, 4, 6, 8].map((value) => <option key={value} value={value}>{value} places</option>)}
        </select>
      </Row>
    </Card>
  )
}

const S = {
  select: { height: 32, minWidth: 104, padding: '0 9px', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, fontWeight: 600 },
}