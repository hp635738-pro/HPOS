import { useRef, useState } from 'react'
import { useTheme, DEFAULTS } from '../theme/ThemeContext'
import { Card, Expander, Row, Button, S } from './ui/Bits'

/**
 * Export every preference to a JSON file and read one back. The import
 * validates the payload and only merges keys the app actually knows about,
 * so an old or hand-edited file can never corrupt the store.
 */

const FORMAT = 1

export default function BackupPanel() {
  const { prefs, replace } = useTheme()
  const [status, setStatus] = useState(null)   // { tone, text }
  const [pending, setPending] = useState(null) // parsed file awaiting confirm
  const fileRef = useRef(null)

  const say = (tone, text) => {
    setStatus({ tone, text })
    setTimeout(() => setStatus(null), 4000)
  }

  const payload = () => ({
    app: 'HPOS',
    format: FORMAT,
    exported: new Date().toISOString(),
    prefs,
  })

  const download = () => {
    const blob = new Blob([JSON.stringify(payload(), null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const stamp = new Date().toISOString().slice(0, 10)
    a.href = url
    a.download = `hpos-settings-${stamp}.json`
    a.click()
    URL.revokeObjectURL(url)
    say('ok', 'Settings exported.')
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload(), null, 2))
      say('ok', 'Copied to clipboard.')
    } catch {
      say('bad', 'Clipboard blocked by the browser.')
    }
  }

  const read = (file) => {
    if (!file) return
    const r = new FileReader()
    r.onload = () => {
      try {
        const data = JSON.parse(r.result)
        const incoming = data.prefs ?? data
        if (typeof incoming !== 'object' || Array.isArray(incoming)) {
          throw new Error('shape')
        }
        // Keep only keys the current build understands.
        const known = Object.keys(DEFAULTS)
        const clean = {}
        let skipped = 0
        Object.entries(incoming).forEach(([k, v]) => {
          if (known.includes(k)) clean[k] = v
          else skipped += 1
        })
        if (!Object.keys(clean).length) throw new Error('empty')
        setPending({ clean, skipped, name: file.name, count: Object.keys(clean).length })
      } catch {
        say('bad', 'That file is not a valid settings export.')
      }
    }
    r.readAsText(file)
  }

  const confirmImport = () => {
    replace({ ...DEFAULTS, ...pending.clean })
    say('ok', `Imported ${pending.count} settings.`)
    setPending(null)
  }

  const changed = Object.keys(DEFAULTS)
    .filter((k) => JSON.stringify(prefs[k]) !== JSON.stringify(DEFAULTS[k])).length

  return (
    <>
      {status && (
        <div style={{
          ...L.status,
          borderColor: status.tone === 'ok' ? '#2ea86b' : 'var(--danger)',
          color: status.tone === 'ok' ? '#2ea86b' : 'var(--danger)',
        }}>
          {status.text}
        </div>
      )}

      <Card>
        <div style={S.head}>
          <span style={S.rowLabel}>Export</span>
          <span style={S.rowHint}>
            Saves every preference — theme, colours, type, sidebar, header and
            shortcuts — into one file.
          </span>
        </div>
        <div style={{ ...S.row, margin: 0, paddingTop: 8 }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={S.rowLabel}>{changed} settings differ from default</span>
            <span style={S.rowHint}>Format v{FORMAT} · JSON</span>
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <Button onClick={copy}>Copy</Button>
            <Button tone="solid" onClick={download}>Download file</Button>
          </div>
        </div>
      </Card>

      <Card>
        <div style={S.head}>
          <span style={S.rowLabel}>Import</span>
          <span style={S.rowHint}>
            Reads a settings file and replaces your current preferences.
            Unknown keys are ignored.
          </span>
        </div>

        <div style={{ ...S.row, margin: 0, paddingTop: 8 }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={S.rowLabel}>Choose a file</span>
            <span style={S.rowHint}>You will see a summary before anything changes.</span>
          </span>
          <Button onClick={() => fileRef.current?.click()}>Select JSON…</Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            onChange={(e) => { read(e.target.files?.[0]); e.target.value = '' }}
            style={{ display: 'none' }}
          />
        </div>

        {pending && (
          <div style={L.confirm}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={S.rowLabel}>{pending.name}</div>
              <div style={S.rowHint}>
                {pending.count} settings will be applied
                {pending.skipped ? ` · ${pending.skipped} unknown keys ignored` : ''}.
                Anything not in the file returns to its default.
              </div>
            </div>
            <Button onClick={() => setPending(null)}>Cancel</Button>
            <Button tone="solid" onClick={confirmImport}>Apply</Button>
          </div>
        )}
      </Card>

      <Expander title="Reset everything" hint="Return every preference to default">
        <div style={S.sub}>
          <Row
            label="Restore defaults"
            hint="Clears all customisation across every panel. This cannot be undone."
            last
          >
            <Button
              tone="danger"
              onClick={() => { replace({ ...DEFAULTS }); say('ok', 'All settings reset.') }}
            >
              Reset all settings
            </Button>
          </Row>
        </div>
      </Expander>
    </>
  )
}

const L = {
  status: {
    padding: '10px 14px', marginBottom: 6,
    border: '1px solid', borderRadius: 6,
    fontSize: 12.5, fontWeight: 600,
    background: 'var(--surface)',
  },
  confirm: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '13px 16px',
    borderTop: '1px solid var(--line)',
    background: 'var(--surface-2)',
  },
}
