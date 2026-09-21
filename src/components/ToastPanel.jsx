import { useTheme } from '../theme/ThemeContext'
import { useToast } from './ui/Toast'
import { Card, Expander, Row, Segmented, Slider, Toggle, Button, S } from './ui/Bits'

const TIMING = [
  { key: 'toastDuration', label: 'Duration', min: 2000, max: 8000, step: 250, unit: 'ms',
    hint: 'Auto-dismiss time. Errors stay 50% longer.' },
  { key: 'toastLimit', label: 'Max visible', min: 1, max: 5,
    hint: 'Toasts shown at once; older ones wait behind.' },
]

const POSITIONS = ['bottom-right', 'bottom-center', 'bottom-left']
const POSITION_LABELS = {
  'bottom-right': 'Bottom right',
  'bottom-center': 'Bottom center',
  'bottom-left': 'Bottom left',
}

/**
 * Toast settings. The shadcn/Base UI toast is mounted app-wide; every knob
 * here writes straight to prefs and the preview button shows a live toast
 * (the shadcn docs demo: title + description + Undo action).
 */
export default function ToastPanel() {
  const { prefs, set } = useTheme()
  const toast = useToast()

  return (
    <>
      <Card>
        <div style={S.head}>
          <span style={S.rowLabel}>Toasts</span>
          <span style={S.rowHint}>
            Short messages that appear temporarily and disappear on their own.
          </span>
        </div>
        <div style={{ padding: '4px 16px 16px' }}>
          <Row label="Preview" hint="The exact shadcn demo — title, description and an Undo action." last>
            <Button
              onClick={() => {
                toast?.push('info', 'Sunday, December 3 at 9:00 AM', {
                  title: 'Event created',
                  action: { label: 'Undo', onClick: () => {} },
                })
              }}
            >
              Show toast
            </Button>
          </Row>
        </div>
      </Card>

      <Expander title="Position" hint="Where the stack lives on screen" defaultOpen>
        <div style={S.sub}>
          <Row label="Corner" hint="Bottom-anchored positions only." last>
            <Segmented
              value={prefs.toastPosition}
              options={POSITIONS}
              labels={POSITION_LABELS}
              onChange={(v) => set('toastPosition', v)}
            />
          </Row>
        </div>
      </Expander>

      <Expander title="Timing" hint="How long toasts stay" defaultOpen>
        {TIMING.map((f) => (
          <Slider key={f.key} field={f} value={prefs[f.key]} onChange={(v) => set(f.key, v)} />
        ))}
      </Expander>

      <Expander title="Chrome" hint="What each toast shows" defaultOpen>
        <div style={S.sub}>
          <Row label="Status icons" hint="Check, info, warning, error and loading glyphs.">
            <Toggle value={prefs.toastIcons} onChange={(v) => set('toastIcons', v)} />
          </Row>
          <Row label="Close button" hint="The × on every toast." last>
            <Toggle value={prefs.toastClose} onChange={(v) => set('toastClose', v)} />
          </Row>
        </div>
      </Expander>
    </>
  )
}
