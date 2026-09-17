import { useEffect, useState } from 'react'
import { useTheme, ACCENTS, DENSITY, isLight } from '../theme/ThemeContext'
import { DARK_TOKENS, LIGHT_TOKENS } from '../theme/tokens.js'
import ColourField from '../components/ColourField'
import AdvancedEditor from '../components/AdvancedEditor'
import { Sun, Moon, Monitor, Check, Chevron } from '../components/Icons'

/**
 * Settings → App → "Update from GitHub" (one-click self-update).
 *
 * The single button runs the whole fixed flow in the main process:
 * check origin/main → fast-forward pull → npm install (if dependency
 * files changed) → production frontend build (if sources changed and no
 * Vite dev server is serving) → window reload or full app restart.
 * The renderer presses the button and displays progress — run() takes
 * no arguments, so nothing renderer-controlled reaches git or npm.
 * Local (uncommitted) changes make the update refuse safely.
 *
 * Rendered only in development shells: packaged installs get their shell
 * updates from the Releases updater (UpdatesPanel below) and plain
 * browser windows have no bridge at all — both render nothing here.
 */
function GitHubUpdatePanel() {
  const bridge = (typeof window !== 'undefined' && window.hpos) || null
  const canRun =
    bridge &&
    typeof bridge.appUpdateRun === 'function' &&
    typeof bridge.onAppUpdateEvent === 'function' &&
    typeof bridge.offAppUpdateEvent === 'function' &&
    typeof bridge.appInfo === 'function'

  const [appInfo, setAppInfo] = useState(null)
  const [running, setRunning] = useState(false)
  const [phase, setPhase] = useState(null)
  const [steps, setSteps] = useState(null)
  const [done, setDone] = useState(null)

  useEffect(() => {
    if (!canRun) return undefined
    bridge.appInfo().then(setAppInfo).catch(() => setAppInfo(null))
    const cb = (payload) => {
      if (!payload || typeof payload.type !== 'string') return
      if (payload.type === 'phase') {
        setRunning(true)
        setPhase(payload.phase)
      } else if (payload.type === 'plan') {
        setSteps(payload.actions || null)
      } else if (payload.type === 'done') {
        setRunning(false)
        setPhase(null)
        setDone({
          ok: payload.state === 'updated' || payload.state === 'up-to-date',
          state: payload.state,
          message: payload.message || 'Update flow finished.',
        })
      }
    }
    bridge.onAppUpdateEvent(cb)
    return () => {
      bridge.offAppUpdateEvent(cb)
    }
  }, [])

  if (!canRun) return null
  if (appInfo && appInfo.isPackaged) return null

  async function startUpdate() {
    if (running) return
    setRunning(true)
    setDone(null)
    setSteps(null)
    setPhase('check')
    try {
      const result = await bridge.appUpdateRun()
      const state = result && typeof result.state === 'string' ? result.state : null
      if (state === 'relaunching') {
        setPhase('relaunch')
      } else if (state === 'updated' || state === 'up-to-date') {
        setDone({ ok: true, state: state, message: (result && result.message) || 'Update applied.' })
        setPhase(null)
      } else {
        setDone({
          ok: false,
          state: state || 'error',
          message: (result && (result.message || result.error)) || 'Update nahi ho paya — detail ke liye message dekho.',
        })
        setPhase(null)
      }
    } catch {
      setDone({ ok: false, state: 'error', message: 'Update flow fail ho gaya — dobara try karo.' })
      setPhase(null)
    } finally {
      setRunning(false)
    }
  }

  const ORDER = ['check', 'pull', 'install', 'build', 'finish']
  const phaseStep = phase === 'reload' || phase === 'relaunch' ? 'finish' : phase
  const activeIdx = phaseStep ? ORDER.indexOf(phaseStep) : -1
  const stepDefs = [
    { id: 'check', label: 'GitHub check (origin/main)' },
    { id: 'pull', label: 'Pull — fast-forward only' },
    { id: 'install', label: 'npm install', skipped: !!(steps && !steps.deps) },
    { id: 'build', label: 'Frontend build', skipped: !!(steps && !steps.build) },
    {
      id: 'finish',
      label: steps
        ? steps.mode === 'relaunch'
          ? 'App restart'
          : steps.mode === 'reload'
            ? 'Windows reload'
            : 'Files update ho gaye'
        : 'Apply',
      skipped: !!(steps && steps.mode === 'none'),
    },
  ]
  function stepState(id, skipped) {
    if (skipped) return 'skipped'
    if (done) return done.ok ? 'done' : id === 'check' ? 'done' : 'pending'
    const idx = ORDER.indexOf(id)
    if (activeIdx === -1) return 'pending'
    if (idx < activeIdx) return 'done'
    if (idx === activeIdx) return 'active'
    return 'pending'
  }

  return (
    <div style={U.block}>
      <div style={U.row}>
        <span style={U.version}>Update from GitHub</span>
        <span style={U.flex1} />
        <button style={U.btn} disabled={running} onClick={startUpdate}>Update</button>
      </div>
      <p style={U.text}>
        origin/main ke saare changes laata hai aur running app pe apply karta hai —
        pull, install, build aur (zarurat ho toh) restart, sab ek click mein.
        Uncommitted local changes hone par update safe refuse ho jata hai.
      </p>
      {(running || done) && (
        <div style={U.block}>
          {stepDefs.map(({ id, label, skipped }) => {
            const st = stepState(id, skipped)
            const tint =
              st === 'done' ? 'var(--text-2)' : st === 'active' ? 'var(--text)' : 'var(--muted)'
            return (
              <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: tint }}>
                <span style={{ width: 14, textAlign: 'center' }}>
                  {st === 'done' ? '✓' : st === 'active' ? '…' : st === 'skipped' ? '–' : '·'}
                </span>
                <span>{label}{st === 'skipped' ? ' (skip)' : ''}</span>
              </div>
            )
          })}
        </div>
      )}
      {done && (
        <div style={U.notes}>{done.message}</div>
      )}
    </div>
  )
}

/**
 * Settings → App → Updates (task §6/§7).
 *
 * Explicit flow only: Check for Updates → (available) Download →
 * Restart to Update. The state machine lives in the main process
 * (updater.js over electron-updater); this panel only displays states
 * and calls the three argument-free actions. In a plain browser window
 * (no preload bridge) it renders the version-less note instead of
 * faking anything.
 */
function UpdatesPanel() {
  const bridge = (typeof window !== 'undefined' && window.hpos) || null
  const up =
    bridge &&
    bridge.updater &&
    typeof bridge.updater.check === 'function' &&
    typeof bridge.updater.status === 'function'
      ? bridge.updater
      : null

  const [appInfo, setAppInfo] = useState(null)
  const [u, setU] = useState(null)
  const [acting, setActing] = useState(false)

  useEffect(() => {
    if (bridge && typeof bridge.appInfo === 'function') {
      bridge.appInfo().then(setAppInfo).catch(() => setAppInfo(null))
    }
    if (!up) return undefined
    if (typeof up.status === 'function') {
      up.status().then(setU).catch(() => {})
    }
    const cb = (payload) => {
      if (payload && typeof payload.state === 'string') setU(payload)
    }
    if (typeof up.onEvent === 'function') up.onEvent(cb)
    return () => {
      if (typeof up.offEvent === 'function') up.offEvent(cb)
    }
  }, [])

  const busy = acting || (u && (u.state === 'checking' || u.state === 'installing'))
  const downloading = u && u.state === 'downloading'
  const progress = downloading ? Math.max(0, Math.min(100, Math.round(u.progress || 0))) : 0

  const act = (fn) => {
    if (!up || acting) return
    setActing(true)
    Promise.resolve(fn())
      .catch(() => {})
      .then(() => setActing(false))
  }

  /* ------------------------------------------------------------- no bridge */
  if (!up) {
    return (
      <div style={U.block}>
        <div style={U.row}>
          <span style={U.version}>{appInfo ? `HPOS ${appInfo.version}` : 'HPOS'}</span>
          <span style={U.note}>This window has no desktop shell bridge — updates are managed by the installed app.</span>
        </div>
      </div>
    )
  }

  /* ---------------------------------------------------- dev instance (no updater) */
  if (appInfo && !appInfo.isPackaged) {
    return (
      <div style={U.block}>
        <div style={U.row}>
          <span style={U.version}>HPOS {appInfo.version} · development instance</span>
        </div>
        <p style={U.text}>
          Updates are only available in the installed (packaged) app. This development instance runs
          directly from source, so it is already on the code you are editing.
        </p>
      </div>
    )
  }

  /* -------------------------------------------------------------- state body */
  let statusNode
  let actionNode

  switch (u ? u.state : 'idle') {
    case 'checking':
      statusNode = <span style={U.note}>Checking the release source for a newer version…</span>
      actionNode = <button style={{ ...U.btn, opacity: 0.6, cursor: 'default' }} disabled>Checking…</button>
      break

    case 'up-to-date':
      statusNode = (
        <span style={{ ...U.note, color: 'var(--success)' }}>
          You’re up to date — {u.downloadedVersion || u.currentVersion}.
        </span>
      )
      actionNode = <button style={U.btn} disabled={busy} onClick={() => act(() => up.check())}>Check for Updates</button>
      break

    case 'available':
      statusNode = (
        <span style={U.note}>
          Version {u.downloadedVersion} is available (you have {u.currentVersion}).
        </span>
      )
      actionNode = (
        <div style={U.row}>
          <span style={U.flex1} />
          <button
            style={{ ...U.btn, borderColor: 'var(--accent)', color: 'var(--accent)' }}
            disabled={busy}
            onClick={() => act(() => up.download())}
          >
            Download Update
          </button>
        </div>
      )
      break

    case 'downloading':
      statusNode = (
        <span style={U.note}>
          Downloading {u.downloadedVersion}… {progress}%
        </span>
      )
      actionNode = (
        <div style={U.progressTrack}>
          <div style={{ ...U.progressFill, width: `${progress}%` }} />
        </div>
      )
      break

    case 'ready':
      statusNode = (
        <span style={{ ...U.note, color: 'var(--success)' }}>
          {u.downloadedVersion} is downloaded and verified.
        </span>
      )
      actionNode = (
        <div style={U.row}>
          <span style={U.flex1} />
          <button
            style={{ ...U.btn, borderColor: 'var(--accent)', color: 'var(--accent)' }}
            disabled={busy}
            onClick={() => act(() => up.install())}
          >
            Restart to Update
          </button>
        </div>
      )
      break

    case 'installing':
      statusNode = <span style={U.note}>Installing the update — HPOS is restarting…</span>
      actionNode = null
      break

    case 'error':
      statusNode = <span style={{ ...U.note, color: 'var(--danger)' }}>{u.error || 'The update check failed.'}</span>
      actionNode = <button style={U.btn} disabled={busy} onClick={() => act(() => up.check())}>Try Again</button>
      break

    case 'unsupported':
      statusNode = <span style={U.note}>{u.error || 'Updates are not available in this build.'}</span>
      actionNode = null
      break

    default:
      statusNode = <span style={U.note}>Check for a newer version from the pinned HPOS release source.</span>
      actionNode = <button style={U.btn} disabled={busy} onClick={() => act(() => up.check())}>Check for Updates</button>
  }

  return (
    <div style={U.block}>
      <div style={U.row}>
        <span style={U.version}>HPOS {u?.currentVersion || (appInfo && appInfo.version) || '—'}</span>
        <span style={U.note}>{statusNode}</span>
      </div>
      {u && u.releaseNotes && (u.state === 'available' || u.state === 'downloading' || u.state === 'ready') && (
        <p style={U.notes}>{u.releaseNotes}</p>
      )}
      {actionNode}
    </div>
  )
}

const U = {
  block: { display: 'flex', flexDirection: 'column', gap: 8 },
  row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  version: { fontSize: 13, fontWeight: 800, letterSpacing: '-.2px' },
  note: { fontSize: 12, color: 'var(--muted)', fontWeight: 500 },
  text: { margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 },
  notes: {
    margin: 0, padding: '8px 10px',
    background: 'var(--surface-2)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 11.5, color: 'var(--text-2)',
    whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto',
  },
  btn: {
    border: '1px solid var(--line)',
    background: 'var(--surface-2)',
    color: 'var(--text)',
    borderRadius: 'var(--radius-sm)',
    padding: '7px 14px',
    fontSize: 12, fontWeight: 700,
    cursor: 'pointer',
    transition: 'background .15s',
  },
  flex1: { flex: 1 },
  progressTrack: {
    height: 6, borderRadius: 3,
    background: 'var(--surface-2)',
    border: '1px solid var(--line)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    background: 'var(--accent)',
    borderRadius: 3,
    transition: 'width .25s',
  },
}

const THEMES = [
  { id: 'light',  label: 'Light',  Icon: Sun },
  { id: 'dark',   label: 'Dark',   Icon: Moon },
  { id: 'system', label: 'System', Icon: Monitor },
]

export default function Settings({ jumpTo, onJumped }) {
  const { prefs, resolved, accentHex, set } = useTheme()
  const [advanced, setAdvanced] = useState(false)

  // The command palette can deep-link straight into an advanced panel.
  useEffect(() => {
    if (jumpTo) setAdvanced(true)
  }, [jumpTo])


  return (
    <div style={S.scroll}>
      <div style={S.inner}>
        <header style={S.head}>
          <div>
            <h2 style={S.h2}>Appearance</h2>
            <p style={S.sub}>
              Theme, accent colour and layout. Every change applies instantly
              and is saved to this browser.
            </p>
          </div>
        </header>

        {/* ------------------------------------------------------------ APP */}
        <Section
          title="App"
          desc="Version and updates. Checking is explicit — nothing downloads or installs without you asking."
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <GitHubUpdatePanel />
            <UpdatesPanel />
          </div>
        </Section>

        {/* ------------------------------------------------------------ THEME */}
        <Section title="Theme" desc="Light, dark, or follow your operating system.">
          <div style={S.themeGrid}>
            {THEMES.map(({ id, label, Icon }) => {
              const on = prefs.theme === id
              const isDark = id === 'dark' || (id === 'system' && resolved === 'dark')
              return (
                <button
                  key={id}
                  onClick={() => set('theme', id)}
                  style={{
                    ...S.themeCard,
                    borderColor: on ? 'var(--accent)' : 'var(--line)',
                    boxShadow: on ? `0 0 0 3px var(--accent-soft)` : 'none',
                  }}
                >
                  <span style={{
                    ...S.thumb,
                    background: isDark ? DARK_TOKENS['--bg'] : LIGHT_TOKENS['--bg'],
                    borderColor: isDark ? DARK_TOKENS['--line'] : LIGHT_TOKENS['--line'],
                  }}>
                    <span style={{ ...S.thumbRail, background: isDark ? DARK_TOKENS['--rail'] : LIGHT_TOKENS['--rail'] }}>
                      <span style={{ ...S.thumbMark, background: accentHex }} />
                      <span style={{ ...S.thumbLine, background: isDark ? 'rgba(255,255,255,.25)' : 'rgba(55,53,47,.22)' }} />
                      <span style={{ ...S.thumbLine, background: isDark ? 'rgba(255,255,255,.25)' : 'rgba(55,53,47,.22)' }} />
                    </span>
                    <span style={S.thumbBody}>
                      <span style={{
                        ...S.thumbBar,
                        background: isDark ? DARK_TOKENS['--surface'] : LIGHT_TOKENS['--surface'],
                        borderColor: isDark ? DARK_TOKENS['--line'] : LIGHT_TOKENS['--line'],
                      }} />
                      <span style={{
                        ...S.thumbBlock,
                        background: isDark ? DARK_TOKENS['--surface'] : LIGHT_TOKENS['--surface'],
                        borderColor: isDark ? DARK_TOKENS['--line'] : LIGHT_TOKENS['--line'],
                      }}>
                        <span style={{ ...S.thumbPill, background: accentHex }} />
                      </span>
                    </span>
                    {id === 'system' && <span style={S.sysTag}>AUTO</span>}
                  </span>

                  <span style={S.themeFoot}>
                    <Icon size={14} />
                    <span style={{ fontWeight: on ? 800 : 600 }}>{label}</span>
                    {on && (
                      <span style={{ ...S.tick, background: 'var(--accent)' }}>
                        <Check size={11} />
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
          {prefs.theme === 'system' && (
            <p style={S.note}>
              Following your OS — currently <b>{resolved}</b>.
            </p>
          )}
        </Section>

        {/* ----------------------------------------------------------- ACCENT */}
        <Section title="Accent colour" desc="Used for highlights, controls and the active state.">
          <div style={S.swatches}>
            {ACCENTS.map((a) => {
              const on = prefs.accent === a.id
              return (
                <button
                  key={a.id}
                  onClick={() => set('accent', a.id)}
                  title={a.name}
                  style={{
                    ...S.swatch,
                    background: a.hex,
                    boxShadow: on ? `0 0 0 3px var(--surface), 0 0 0 5px ${a.hex}` : 'none',
                  }}
                >
                  {on && <Check size={17} style={{ color: isLight(a.hex) ? '#101114' : '#fff' }} />}
                </button>
              )
            })}

            {/* Custom sits in the same row, opening the OS colour picker. */}
            <label
              title="Custom colour"
              style={{
                ...S.swatch,
                position: 'relative', overflow: 'hidden', cursor: 'pointer',
                background: prefs.accent === 'custom'
                  ? prefs.accentCustom
                  : 'conic-gradient(from .25turn, #f43f5e, #f59e0b, #10b981, #06b6d4, #2383e2, #8b5cf6, #f43f5e)',
                boxShadow: prefs.accent === 'custom'
                  ? `0 0 0 3px var(--surface), 0 0 0 5px ${prefs.accentCustom}`
                  : 'none',
              }}
            >
              <input
                type="color"
                value={prefs.accentCustom}
                onChange={(e) => { set('accentCustom', e.target.value); set('accent', 'custom') }}
                style={S.hiddenColor}
              />
              {prefs.accent === 'custom'
                ? <Check size={17} style={{ color: isLight(prefs.accentCustom) ? '#101114' : '#fff' }} />
                : <span style={S.plus}>+</span>}
            </label>
          </div>

          <Row label="Custom hex" hint="Any colour you like — applies instantly.">
            <ColourField
              value={prefs.accentCustom}
              onChange={(v) => { set('accentCustom', v); set('accent', 'custom') }}
            />
          </Row>

          <Row label="Text on accent" hint="Auto picks black or white for contrast.">
            <Segmented
              value={prefs.accentFg}
              options={['auto', 'light', 'dark']}
              labels={{ light: 'White', dark: 'Black' }}
              onChange={(v) => set('accentFg', v)}
            />
          </Row>

          <Row label="Tint strength" hint={`${prefs.accentSoft}% — soft accent backgrounds.`}>
            <div style={S.sliderWrap}>
              <input
                type="range" min="4" max="40" step="1"
                value={prefs.accentSoft}
                onChange={(e) => set('accentSoft', +e.target.value)}
                style={{ flex: 1 }}
              />
              <span style={S.radiusVal}>{prefs.accentSoft}</span>
            </div>
          </Row>
        </Section>

        {/* ----------------------------------------------------------- LAYOUT */}
        <Section title="Layout" desc="Spacing, corner shape and the sidebar.">
          <Row label="Density" hint="Controls padding and row height.">
            <Segmented
              value={prefs.density}
              options={Object.keys(DENSITY)}
              onChange={(v) => set('density', v)}
            />
          </Row>

          <Row label="Sidebar" hint="Show labels or icons only.">
            <Segmented
              value={prefs.sidebar}
              options={['expanded', 'icons']}
              labels={{ expanded: 'With labels', icons: 'Icons only' }}
              onChange={(v) => set('sidebar', v)}
            />
          </Row>

          <Row label="Corner radius" hint={`${prefs.radius}px — applies across the whole app.`}>
            <div style={S.sliderWrap}>
              <input
                type="range" min="0" max="26" step="1"
                value={prefs.radius}
                onChange={(e) => set('radius', +e.target.value)}
                style={{ flex: 1 }}
              />
              <span style={S.radiusVal}>{prefs.radius}</span>
            </div>
          </Row>
        </Section>


        {/* ------------------------------------------------------ DANGER ZONE */}
        <section style={S.danger}>
          <div style={S.cardHead}>
            <h3 style={{ ...S.cardTitle, color: 'var(--danger)' }}>Danger zone</h3>
            <p style={S.cardDesc}>
              Work-in-progress tooling. These controls change unfinished
              components and are removed once a component is signed off.
            </p>
          </div>

          <button className="danger-row" onClick={() => setAdvanced(true)} style={S.dangerRow}>
            <div style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
              <div style={{ ...S.rowLabel, color: 'var(--danger)' }}>Advanced settings</div>
            </div>
            <Chevron size={15} dir="right" style={{ color: 'var(--danger)', flexShrink: 0 }} />
          </button>
        </section>
      </div>

      {advanced && (
        <AdvancedEditor
          initialPage={jumpTo}
          onClose={() => { setAdvanced(false); onJumped?.() }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ pieces */
function Section({ title, desc, children }) {
  return (
    <section style={S.card}>
      <div style={S.cardHead}>
        <h3 style={S.cardTitle}>{title}</h3>
        {desc && <p style={S.cardDesc}>{desc}</p>}
      </div>
      {children}
    </section>
  )
}

function Row({ label, hint, children }) {
  return (
    <div style={S.row}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={S.rowLabel}>{label}</div>
        {hint && <div style={S.rowHint}>{hint}</div>}
      </div>
      <div style={S.rowControl}>{children}</div>
    </div>
  )
}

function Segmented({ value, options, labels = {}, onChange }) {
  return (
    <div style={S.seg}>
      {options.map((o) => {
        const on = o === value
        return (
          <button
            key={o}
            onClick={() => onChange(o)}
            style={{
              ...S.segBtn,
              background: on ? 'var(--accent)' : 'transparent',
              color: on ? 'var(--accent-fg)' : 'var(--text-2)',
              fontWeight: on ? 800 : 600,
            }}
          >
            {labels[o] || o}
          </button>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ styles */
const S = {
  scroll: { flex: 1, minHeight: 0, overflowY: 'auto' },
  inner: {
    maxWidth: 880, margin: '0 auto',
    padding: 'var(--pad)',
    display: 'flex', flexDirection: 'column', gap: 'var(--gap)',
  },

  head: {
    display: 'flex', alignItems: 'flex-start',
    justifyContent: 'space-between', gap: 14,
    padding: '4px 2px 2px',
  },
  h2: { margin: 0, fontSize: 21, fontWeight: 800, letterSpacing: '-.5px' },
  sub: {
    margin: '5px 0 0', fontSize: 12.5, color: 'var(--muted)',
    fontWeight: 500, maxWidth: 460, lineHeight: 1.55,
  },

  card: {
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--pad)',
    boxShadow: 'var(--shadow)',
    transition: 'border-radius .18s, background .22s, border-color .22s, padding .18s',
  },
  cardHead: { marginBottom: 'var(--gap)' },
  cardTitle: { margin: 0, fontSize: 14.5, fontWeight: 800, letterSpacing: '-.2px' },
  cardDesc: { margin: '3px 0 0', fontSize: 11.5, color: 'var(--muted)', fontWeight: 500 },

  danger: {
    background: 'var(--surface)',
    border: '1px solid var(--danger-line)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--pad)',
    transition: 'border-radius .18s, background .22s, border-color .22s',
  },
  dangerRow: {
    width: '100%',
    display: 'flex', alignItems: 'center', gap: 16,
    padding: '13px 10px 13px 12px', marginTop: 2,
    borderTop: '1px solid var(--danger-line)',
    borderRadius: 'var(--radius-sm)',
    background: 'transparent',
    transition: 'background .16s, border-radius .18s',
  },

  themeGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--gap)' },
  themeCard: {
    border: '2px solid var(--line)',
    borderRadius: 'var(--radius)',
    padding: 8, textAlign: 'left',
    background: 'transparent',
    transition: 'border-color .16s, box-shadow .16s, border-radius .18s',
  },
  thumb: {
    position: 'relative', display: 'flex',
    height: 74, borderRadius: 'var(--radius-sm)',
    overflow: 'hidden', border: '1px solid',
    marginBottom: 9,
    transition: 'border-radius .18s',
  },
  thumbRail: {
    width: 17, flexShrink: 0,
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: 4, paddingTop: 6,
  },
  thumbMark: { width: 9, height: 9, borderRadius: 3 },
  thumbLine: { width: 9, height: 2.5, borderRadius: 99, background: 'rgba(255,255,255,.25)' },
  thumbBody: { flex: 1, padding: 6, display: 'flex', flexDirection: 'column', gap: 5 },
  thumbBar: { height: 11, borderRadius: 4, border: '1px solid' },
  thumbBlock: {
    flex: 1, borderRadius: 5, border: '1px solid',
    display: 'flex', alignItems: 'flex-end', padding: 5,
  },
  thumbPill: { width: 22, height: 6, borderRadius: 99 },
  sysTag: {
    position: 'absolute', top: 5, right: 5,
    fontSize: 7, fontWeight: 800, letterSpacing: '.5px',
    color: '#fff', background: 'rgba(0,0,0,.45)',
    padding: '2px 5px', borderRadius: 4,
  },
  themeFoot: {
    display: 'flex', alignItems: 'center', gap: 7,
    padding: '0 3px', fontSize: 12.5, color: 'var(--text)',
  },
  tick: {
    marginLeft: 'auto', width: 17, height: 17, borderRadius: '50%',
    color: '#fff', display: 'grid', placeItems: 'center',
  },
  note: {
    margin: '12px 0 0', fontSize: 11.5, color: 'var(--muted)',
    fontWeight: 500, textTransform: 'capitalize',
  },

  swatches: { display: 'flex', gap: 14, flexWrap: 'wrap' },
  swatch: {
    width: 40, height: 40, borderRadius: 'var(--radius-sm)',
    display: 'grid', placeItems: 'center',
    transition: 'box-shadow .16s, border-radius .18s, transform .12s',
  },

  hiddenColor: {
    position: 'absolute', inset: -4,
    width: 'calc(100% + 8px)', height: 'calc(100% + 8px)',
    opacity: 0, cursor: 'pointer', border: 'none', padding: 0,
  },
  plus: {
    fontSize: 20, fontWeight: 300, color: '#fff',
    textShadow: '0 1px 3px rgba(0,0,0,.4)', lineHeight: 1,
  },


  row: {
    display: 'flex', alignItems: 'center', gap: 16,
    padding: '13px 0',
    borderTop: '1px solid var(--line)',
  },
  rowLabel: { fontSize: 13, fontWeight: 700 },
  rowHint: { fontSize: 11, color: 'var(--muted)', marginTop: 2, fontWeight: 500 },
  rowControl: { flexShrink: 0 },

  seg: {
    display: 'flex', gap: 3, padding: 3,
    background: 'var(--surface-2)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius-sm)',
    transition: 'border-radius .18s',
  },
  segBtn: {
    padding: '7px 13px',
    borderRadius: 'calc(var(--radius-sm) - 2px)',
    fontSize: 11.5, textTransform: 'capitalize',
    transition: 'background .16s, color .16s, border-radius .18s',
    whiteSpace: 'nowrap',
  },

  sliderWrap: { display: 'flex', alignItems: 'center', gap: 12, width: 210 },
  radiusVal: {
    minWidth: 34, textAlign: 'center',
    fontSize: 12, fontWeight: 800,
    background: 'var(--surface-2)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius-sm)',
    padding: '5px 0',
    transition: 'border-radius .18s',
  },

}
