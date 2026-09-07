import { useTheme } from '../theme/ThemeContext'
import { Card, Row, Toggle } from './ui/Bits'

export default function CalculatorPanel() {
  const { prefs, set } = useTheme()
  const slider = (key, min, max, value, suffix = 'px') => (
    <div style={S.slider}>
      <input type="range" min={min} max={max} value={value} onChange={(e) => set(key, +e.target.value)} />
      <output style={S.value}>{value}{suffix}</output>
    </div>
  )

  return (
    <Card>
      <Row label="Popup width" hint="Controls the overall width of the calculator popup.">
        {slider('calcWidth', 280, 520, prefs.calcWidth)}
      </Row>
      <Row label="Key size" hint="Changes the height and roundness of calculator keys.">
        {slider('calcKeySize', 48, 84, prefs.calcKeySize)}
      </Row>
      <Row label="Display area" hint="Changes the height of the number display above the keys.">
        {slider('calcDisplayHeight', 96, 200, prefs.calcDisplayHeight)}
      </Row>
      <Row label="Key spacing" hint="Space between calculator buttons.">
        {slider('calcGap', 4, 18, prefs.calcGap)}
      </Row>
      <Row label="Calculation history" hint="Keeps this option ready for saved backend history.">
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
  slider: { display: 'flex', alignItems: 'center', gap: 10, width: 210 },
  value: { minWidth: 46, textAlign: 'center', fontSize: 12, fontWeight: 800, background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', padding: '5px 0' },
  select: { height: 32, minWidth: 104, padding: '0 9px', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, fontWeight: 600 },
}
