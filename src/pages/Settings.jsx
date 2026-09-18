import { useEffect, useRef, useState } from 'react'
import { useTheme, ACCENTS, DENSITY, isLight } from '../theme/ThemeContext'
import {
  CHECK_TIMEOUT_MS,
  failureStatus,
  pressStatus,
  statusFromAnswer,
  timeoutStatus,
} from '../lib/updaterStatus.js'
import { DARK_TOKENS, LIGHT_TOKENS } from '../theme/tokens.js'
import { PRESETS, PRESET_ORDER } from '../theme/presets.js'
import ColourField from '../components/ColourField'
import AdvancedEditor from '../components/AdvancedEditor'
import { usePanelExit } from '../lib/panelTransition'
import { Sun, Moon, Monitor, Check, Chevron, Sliders } from '../components/Icons'

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
 * (updater.js over electron-updater); this panel displays states and
 * calls the three argument-free actions. In a plain browser window
 * (no preload bridge) it renders the version-less note instead of
 * faking anything.
 *
 * A press is never silent: it does not rely on the pushed event stream
 * alone. Pressing a button shows the state it just started (checking /
 * downloading / installing) immediately; the status the argument-free
 * call resolves with is applied verbatim (the same payload the events
 * carry), so up-to-date / update-available / error render even when no
 * event reaches this window; a refused or rejected call becomes a
 * visible error with its category, and a check that never answers
 * becomes a visible timeout instead of an endless "Checking…"
 * (see lib/updaterStatus.js).
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
  /* The click flow is async, so it reads the latest status from a ref —
     the `u` captured by its own render would be one answer behind. */
  const statusRef = useRef(null)
  /* A check that is never answered must not leave the panel on "Checking…". */
  const watchdogRef = useRef(null)

  useEffect(() => { statusRef.current = u }, [u])

  useEffect(() => {
    if (bridge && typeof bridge.appInfo === 'function') {
      bridge.appInfo().then(setAppInfo).catch(() => setAppInfo(null))
    }
    if (!up) return undefined
    if (typeof up.status === 'function') {
      up.status().then(setU).catch(() => {})
    }
    const cb = (payload) => {
      if (payload && typeof payload.state === 'string') {
        statusRef.current = payload
        setU(payload)
      }
    }
    if (typeof up.onEvent === 'function') up.onEvent(cb)
    return () => {
      if (typeof up.offEvent === 'function') up.offEvent(cb)
      if (watchdogRef.current) clearTimeout(watchdogRef.current)
    }
  }, [])

  const busy = acting || (u && (u.state === 'checking' || u.state === 'installing'))
  const downloading = u && u.state === 'downloading'
  const progress = downloading ? Math.max(0, Math.min(100, Math.round(u.progress || 0))) : 0

  /** Every status change goes through here, so the click flow sees the latest. */
  const applyStatus = (next) => {
    statusRef.current = next
    setU(next)
  }

  const clearWatchdog = () => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current)
      watchdogRef.current = null
    }
  }

  const armWatchdog = () => {
    clearWatchdog()
    watchdogRef.current = setTimeout(() => {
      watchdogRef.current = null
      applyStatus(timeoutStatus(statusRef.current))
      setActing(false)
    }, CHECK_TIMEOUT_MS)
  }

  /**
   * Run one of the three argument-free updater actions. Whatever happens,
   * the press leaves a visible status behind: the started state right
   * away, the answer when it arrives, an error when the call is refused
   * or rejects, and a timeout when a check never answers.
   */
  const act = (kind, fn) => {
    if (!up || acting) return
    clearWatchdog()
    setActing(true)
    applyStatus(pressStatus(kind, statusRef.current))
    if (kind === 'check') armWatchdog()
    Promise.resolve()
      .then(fn)
      .then((answer) => {
        const next = statusFromAnswer(statusRef.current, answer)
        /* The call answered while the updater still reports "checking":
           no outcome has been reported yet, so let the watchdog keep
           running rather than treating the silence as a final state. */
        if (kind === 'check' && next.state === 'checking') return
        clearWatchdog()
        applyStatus(next)
      })
      .catch((err) => {
        clearWatchdog()
        applyStatus(failureStatus(statusRef.current, err))
      })
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
      actionNode = <button style={U.btn} disabled={busy} onClick={() => act('check', () => up.check())}>Check for Updates</button>
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
            onClick={() => act('download', () => up.download())}
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
            onClick={() => act('install', () => up.install())}
          >
            Restart to Update
          </button>
        </div>
      )
      break

    case 'installing':
      statusNode = <span style={U.note}>{u.message || 'Installing the update — HPOS is restarting…'}</span>
      actionNode = null
      break

    case 'error':
      statusNode = (
        <span style={{ ...U.note, color: 'var(--danger)' }}>
          {u.error || 'The update check failed.'}
          {u.errorDetail ? ` (${u.errorCode || 'error'}: ${u.errorDetail})` : ''}
        </span>
      )
      actionNode = <button style={U.btn} disabled={busy} onClick={() => act('check', () => up.check())}>Try Again</button>
      break

    case 'unsupported':
      statusNode = <span style={U.note}>{u.error || 'Updates are not available in this build.'}</span>
      actionNode = null
      break

    default:
      statusNode = <span style={U.note}>Check for a newer version from the pinned HPOS release source.</span>
      actionNode = <button style={U.btn} disabled={busy} onClick={() => act('check', () => up.check())}>Check for Updates</button>
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
      {u && u.mechanismLabel && <span style={U.note}>Update method: {u.mechanismDescription || u.mechanismLabel}</span>}
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

function PresetChooser() {
  const { prefs, resolved, setPreset, set } = useTheme()
  const active = prefs.preset || 'minimal'
  const accentHex = (() => {
    const a = ACCENTS.find(x => x.id === prefs.accent)
    return prefs.accent === 'custom' ? prefs.accentCustom : (a?.hex || '#2383e2')
  })()

  return (
    <>
      <div style={P.grid}>
      {PRESET_ORDER.map(id => {
        const preset = PRESETS[id]
        const isActive = active === id
        const tokens = preset.tokens[resolved] || preset.tokens.light
        // subtle preview colors
        const bg = tokens['--bg']
        const surface = tokens['--surface']
        const rail = tokens['--rail']
        const line = tokens['--line']
        const accent = ACCENTS.find(a => a.id === preset.accent)?.hex || accentHex
        return (
          <button
            key={id}
            onClick={() => setPreset(id)}
            style={{
              ...P.card,
              borderColor: isActive ? 'var(--accent)' : 'var(--line)',
              background: isActive ? 'var(--accent-soft)' : 'var(--surface)',
              boxShadow: isActive ? '0 0 0 3px var(--accent-soft), 0 8px 24px -12px rgba(0,0,0,.18)' : 'var(--shadow)',
              transform: isActive ? 'translateY(-1px)' : 'none',
            }}
          >
            <span style={{
              ...P.preview,
              background: bg,
              borderColor: line,
              borderRadius: preset.prefs.radius > 14 ? 14 : preset.prefs.radius > 8 ? 10 : 7,
            }}>
              {/* mini rail */}
              <span style={{
                ...P.miniRail,
                background: rail,
                borderRight: `1px solid ${line}`,
                borderRadius: preset.prefs.railRadius > 10 ? 7 : 5,
              }}>
                <span style={{ ...P.miniMark, background: accent }} />
                <span style={{ ...P.miniLine, opacity: .6 }} />
                <span style={{ ...P.miniLine, opacity: .35 }} />
              </span>
              <span style={P.miniBody}>
                <span style={{
                  ...P.miniHeader,
                  background: surface,
                  borderColor: line,
                  borderRadius: preset.prefs.barRadius ? Math.min(preset.prefs.barRadius, 8) : 5,
                }} />
                <span style={{
                  ...P.miniCard,
                  background: surface,
                  borderColor: line,
                  borderRadius: preset.prefs.radius > 14 ? 12 : 8,
                  boxShadow: preset.effects.shadowStyle === 'deep' ? '0 2px 10px rgba(0,0,0,.14)' :
                             preset.effects.shadowStyle === 'glow' ? '0 4px 16px rgba(139,92,246,.12)' :
                             preset.effects.shadowStyle === 'soft' ? '0 2px 12px rgba(0,0,0,.08)' : 'none',
                }}>
                  <span style={{ ...P.miniPill, background: accent }} />
                </span>
              </span>
              {preset.id === 'aurora' && <span style={P.auroraGlow} />}
            </span>
            <span style={P.cardHead}>
              <span style={{ ...P.cardTitle, color: isActive ? 'var(--accent)' : 'var(--text)' }}>{preset.label}</span>
              {isActive && <span style={P.activeDot}><Check size={10} /></span>}
            </span>
            <span style={P.cardDesc}>{preset.desc}</span>
            <span style={P.cardChar}>{preset.character}</span>
            <span style={P.meta}>
              <span style={{
                ...P.metaChip,
                background: isActive ? 'var(--accent)' : 'var(--surface-2)',
                color: isActive ? 'var(--accent-fg)' : 'var(--text-2)',
                borderColor: isActive ? 'var(--accent)' : 'var(--line)',
              }}>{preset.prefs.density}</span>
              <span style={P.metaChip2}>{preset.prefs.radius}px radius</span>
            </span>
          </button>
        )
      })}
      </div>

      {/* Status + reset (moved here with the section — Presets is now
          Advanced-settings only, this is its single render site). */}
      <div style={P.resetRow}>
        <span style={P.resetText}>
          Preset: <b style={{ color: 'var(--text)' }}>{PRESETS[active]?.label || 'Minimal'}</b> · {PRESETS[active]?.character}
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => { set('preset', 'minimal'); set('bgStyle', 'auto'); set('cardStyle', 'auto'); set('sidebarStyle', 'auto') }}
          style={P.resetBtn}
        >Reset to Minimal</button>
      </div>
    </>
  )
}

const P = {
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
  meta: { display: 'flex', gap: 6, padding: '2px 2px 0' },
  metaChip: { fontSize: 9, fontWeight: 800, letterSpacing: '.3px', padding: '3px 6px', borderRadius: 4, border: '1px solid' },
  metaChip2: { fontSize: 9, fontWeight: 600, color: 'var(--muted)', padding: '3px 6px' },
  resetRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  resetText: { fontSize: 11, color: 'var(--muted)', fontWeight: 500 },
  resetBtn: {
    fontSize: 11, fontWeight: 700, color: 'var(--muted)',
    background: 'var(--surface-2)', border: '1px solid var(--line)',
    padding: '5px 10px', borderRadius: 6,
  },
}

/**
 * Categories of the Advanced settings area, in nav order. The chips on the
 * quick page deep-link straight into each category's first page.
 */
const ADV_CATEGORIES = [
  { name: 'App', page: 'updates' },
  { name: 'Appearance', page: 'workspaces' },
  { name: 'Navigation', page: 'sidebar' },
  { name: 'System', page: 'motion' },
  { name: 'Content', page: 'pages' },
]

/**
 * Accent colour picker — swatches, custom hex, text-on-accent and tint
 * strength. Advanced settings only (Appearance → "Accent colour" page):
 * one implementation, one render site (same pattern as PresetChooser and
 * the shared updater panels).
 */
function AccentSection() {
  const { prefs, set } = useTheme()
  return (
    <>
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
    </>
  )
}

export default function Settings({ jumpTo, onJumped }) {
  const { prefs, resolved, accentHex, set } = useTheme()
  // The Advanced settings overlay is a slide + fade panel: it stays mounted
  // while its exit animation plays (see lib/panelTransition.js).
  const [advOpen, setAdvOpen] = useState(false)
  const [advTarget, setAdvTarget] = useState(null)   // deep-linked page, or null
  const adv = usePanelExit(advOpen)

  const openAdvanced = (page = null) => {
    setAdvTarget(page)
    setAdvOpen(true)
  }

  // The command palette can deep-link straight into an advanced panel.
  useEffect(() => {
    if (jumpTo) openAdvanced(jumpTo)
  }, [jumpTo])

  return (
    <div style={S.scroll}>
      <div style={S.inner}>
        <header style={S.head}>
          <div>
            <h2 style={S.h2}>Quick settings</h2>
            <p style={S.sub}>
              The everyday look — theme and basic layout. Every change
              applies instantly and is saved to this browser. Presets,
              accent colour and everything else live in Advanced settings.
            </p>
          </div>
        </header>

        {/* Presets and Accent colour live in Advanced settings only
            (Appearance group) — shared PresetChooser / AccentSection. */}

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

        {/* ------------------------------------------------ ADVANCED SETTINGS */}
        <section style={S.card} className="page-transition">
          <div style={S.advHead}>
            <span style={S.advBadge}><Sliders size={17} /></span>
            <div style={{ minWidth: 0 }}>
              <h3 style={S.advTitle}>Advanced settings</h3>
              <p style={S.advDesc}>
                Updates, colours, typography, surfaces, motion, navigation and
                backup — every setting that is not a quick one.
              </p>
            </div>
          </div>

          <div style={S.advRow}>
            <div style={S.advChips}>
              {ADV_CATEGORIES.map((c) => (
                <button
                  key={c.name}
                  className="adv-chip"
                  onClick={() => openAdvanced(c.page)}
                  style={S.advChip}
                >
                  {c.name}
                </button>
              ))}
            </div>
            <button
              className="adv-open"
              onClick={() => openAdvanced(null)}
              style={S.advOpen}
            >
              Open Advanced settings
              <Chevron size={15} dir="right" />
            </button>
          </div>
        </section>
      </div>

      {adv.mounted && (
        <AdvancedEditor
          initialPage={advTarget || undefined}
          closing={adv.exiting}
          onClose={() => { setAdvOpen(false); onJumped?.() }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ pieces */
function Section({ title, desc, children }) {
  return (
    <section style={S.card} className="page-transition">
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
    fontWeight: 500, maxWidth: 560, lineHeight: 1.55,
  },

  card: {
    background: 'var(--surface)',
    border: '1px solid var(--card-border, var(--line))',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--pad)',
    boxShadow: 'var(--card-shadow, var(--shadow))',
    backdropFilter: 'blur(var(--card-blur, 0px))',
    WebkitBackdropFilter: 'blur(var(--card-blur, 0px))',
    transition: 'border-radius var(--motion-duration) var(--motion-easing), background var(--motion-duration) var(--motion-easing), border-color var(--motion-duration) var(--motion-easing), padding var(--motion-duration) var(--motion-easing), box-shadow var(--motion-duration) var(--motion-easing)',
  },
  cardHead: { marginBottom: 'var(--gap)' },
  cardTitle: { margin: 0, fontSize: 14.5, fontWeight: 800, letterSpacing: '-.2px' },
  cardDesc: { margin: '3px 0 0', fontSize: 11.5, color: 'var(--muted)', fontWeight: 500 },

  advHead: {
    display: 'flex', gap: 12, alignItems: 'flex-start',
    marginBottom: 'var(--gap)',
  },
  advBadge: {
    width: 36, height: 36, borderRadius: 9, flexShrink: 0,
    display: 'grid', placeItems: 'center',
    color: 'var(--accent)', background: 'var(--accent-soft)',
    transition: 'border-radius .18s, background var(--motion-duration) var(--motion-easing)',
  },
  advTitle: { margin: 0, fontSize: 14.5, fontWeight: 800, letterSpacing: '-.2px' },
  advDesc: { margin: '3px 0 0', fontSize: 11.5, color: 'var(--muted)', fontWeight: 500, maxWidth: 520 },
  advRow: {
    display: 'flex', alignItems: 'center', gap: 14,
    flexWrap: 'wrap',
  },
  advChips: {
    flex: 1, minWidth: 0,
    display: 'flex', gap: 6, flexWrap: 'wrap',
  },
  advChip: {
    fontSize: 11.5, fontWeight: 700,
    color: 'var(--text-2)',
    background: 'var(--surface-2)',
    border: '1px solid var(--line)',
    borderRadius: 99,
    padding: '6px 12px',
    transition: 'background .16s, color .16s, border-color .16s',
  },
  advOpen: {
    display: 'inline-flex', alignItems: 'center', gap: 8,
    background: 'var(--accent)', color: 'var(--accent-fg)',
    fontSize: 12.5, fontWeight: 700,
    borderRadius: 'var(--radius-sm)',
    padding: '9px 16px',
    border: 'none',
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
  toggle: {
    width: 40, height: 20, borderRadius: 99,
    border: '1px solid', padding: 2,
    display: 'flex', alignItems: 'center',
    transition: 'background .18s, border-color .18s',
  },
  toggleKnob: {
    width: 12, height: 12, borderRadius: '50%',
    transition: 'transform .18s cubic-bezier(.4,0,.2,1), background .18s',
  },

}

/* Shared with the dedicated pages inside Advanced settings
   (components/AdvancedEditor.jsx) — one implementation, rendered only there. */
export { AccentSection, GitHubUpdatePanel, PresetChooser, UpdatesPanel }
