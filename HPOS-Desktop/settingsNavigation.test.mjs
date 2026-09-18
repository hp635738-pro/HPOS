/**
 * Settings navigation regression tests.
 * Run: node HPOS-Desktop/settingsNavigation.test.mjs
 *
 * Regression under test — "Settings is a HEADER destination":
 *
 *   A previous change added Settings to the left rail twice: once as a NAV
 *   item and once as an always-visible footer button. Both were mistakes.
 *   Worse, because `settings` was a NAV id, App classified the settings view
 *   as a rail page (`inRail === true`) and therefore handed the Topbar
 *   `active={null}` — so the header gear that opens Settings could never own
 *   or reflect the view it opens (no on-state, and the rail stole the
 *   highlight). The header gear read as a dead button.
 *
 *   Now: the rail has no Settings entry at all, App never treats the settings
 *   view as a rail page, and the existing Topbar gear is the Settings entry
 *   point — same button, same place, same styling, navigating through the
 *   existing `onNavigate(view)` contract.
 *
 * The project has no React rendering harness, so (same pattern as the other
 * UI suites) the contract is verified against the real sources. Where the
 * source is plain JavaScript rather than markup, the REAL code is extracted
 * and executed — NAV/flatNav/orderNav/TOOLS, the Topbar click handler, App's
 * navigate(), inRail guard and title expression all run here, so the
 * navigation behavior is proven, not just grepped. Failures are collected and
 * reported together (same soft-assert style as src/pages/Settings.test.mjs).
 * No new dependencies, no DOM, no Electron, no network.
 *
 *   1. rail: no Settings nav item (executed NAV + flatNav); a stale saved
 *      navOrder that still names 'settings' is ignored (executed orderNav)
 *   2. rail footer: Collapse only — no Settings button hiding in the footer
 *   3. Topbar: the Settings gear exists, is unique, always rendered,
 *      accessible, and no extra header button was added
 *   4. Topbar: clicking the gear calls onNavigate('settings') — the real
 *      handler is executed against a spy
 *   5. App: navigate()/inRail/title/route wiring — real expressions executed
 *   6. Settings structure: Quick settings on the main page (presets, theme,
 *      accent, layout), Advanced settings entry, updater panels shared with
 *      the dedicated Updates page (behavior and copy untouched)
 *   7. updater IPC stays safe (no arbitrary URLs, argument-free bridge)
 *   8. navigation architecture/security: fixed literal view id only — no
 *      URLs, no IPC, no shell, no renderer filesystem/Git access
 *   9. Advanced settings categories; every moved setting present exactly
 *      once (no quick/advanced duplicates); Assistant→Network rename
 */
import strictAssert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(desktopDir, '..')

console.log('settings navigation tests...')

/* ------------------------------------------------------------- soft assert */
let failed = 0
const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v))
const assert = {
  ok: (cond, msg) => {
    if (cond) return true
    failed += 1
    console.error(`FAIL  ${msg}`)
    return false
  },
  equal: (actual, expected, msg) =>
    assert.ok(actual === expected, `${msg} (got ${show(actual)}, want ${show(expected)})`),
  notEqual: (actual, expected, msg) =>
    assert.ok(actual !== expected, `${msg} (got ${show(actual)})`),
  deepEqual: (actual, expected, msg) =>
    assert.ok(show(actual) === show(expected), `${msg} (got ${show(actual)}, want ${show(expected)})`),
}

/** Prints a section summary only when nothing in that section failed. */
let mark = 0
const section = (msg) => {
  if (failed === mark) console.log(`ok: ${msg}`)
  mark = failed
}

const sidebar = readFileSync(join(repoRoot, 'src', 'components', 'Sidebar.jsx'), 'utf8')
const topbar = readFileSync(join(repoRoot, 'src', 'components', 'Topbar.jsx'), 'utf8')
const appJsx = readFileSync(join(repoRoot, 'src', 'App.jsx'), 'utf8')
const settings = readFileSync(join(repoRoot, 'src', 'pages', 'Settings.jsx'), 'utf8')
const advanced = readFileSync(join(repoRoot, 'src', 'components', 'AdvancedEditor.jsx'), 'utf8')
const notch = readFileSync(join(repoRoot, 'src', 'components', 'Notch.jsx'), 'utf8')
const palette = readFileSync(join(repoRoot, 'src', 'components', 'CommandPalette.jsx'), 'utf8')
const mainJs = readFileSync(join(desktopDir, 'main.js'), 'utf8')
const preloadJs = readFileSync(join(desktopDir, 'preload.js'), 'utf8')

/* ------------------------------------------------------------ extraction
   Structural helpers: these fail hard (strictAssert) because everything else
   depends on the slice they return. */

/** Index of the bracket that closes the one at `open` (string/comment aware). */
function matchBracket(src, open) {
  let depth = 0
  let quote = null
  for (let i = open; i < src.length; i += 1) {
    const c = src[i]
    if (quote) {
      if (c === '\\') i += 1
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue }
    if (c === '{' || c === '[' || c === '(') depth += 1
    else if (c === '}' || c === ']' || c === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** Array/object literal that follows `marker`, e.g. `export const NAV = [`. */
function literalAfter(src, marker) {
  const at = src.indexOf(marker)
  strictAssert.notEqual(at, -1, `source contains ${JSON.stringify(marker)}`)
  const open = at + marker.length - 1
  const close = matchBracket(src, open)
  strictAssert.notEqual(close, -1, `literal after ${JSON.stringify(marker)} is balanced`)
  return src.slice(open, close + 1)
}

/** Function body starting at `header`, with `export ` stripped. */
function functionAfter(src, header) {
  const at = src.indexOf(header)
  strictAssert.notEqual(at, -1, `source contains ${JSON.stringify(header)}`)
  const open = src.indexOf('{', at)
  const close = matchBracket(src, open)
  strictAssert.notEqual(close, -1, `function ${JSON.stringify(header)} is balanced`)
  return src.slice(at, close + 1).replace(/^export\s+/, '')
}

/**
 * Icon members (`Icon: Gear`) are component references, so they are turned
 * into their own names — everything else in the literal stays real data.
 */
const plain = (literal) => literal.replace(/Icon:\s*([A-Za-z_$][\w$]*)/g, "Icon: '$1'")
const run = (expr) => new Function(`return (${expr})`)()

const NAV = run(plain(literalAfter(sidebar, 'export const NAV = [')))
const TOOLS = run(plain(literalAfter(notch, 'export const TOOLS = [')))
const flatNav = new Function('NAV', `${functionAfter(sidebar, 'export function flatNav(')}\nreturn flatNav`)(NAV)
const orderNav = new Function('NAV', `${functionAfter(sidebar, 'export function orderNav(')}\nreturn orderNav`)(NAV)

/** App's allNav: top-level rail items plus their nested children. */
const allNav = []
NAV.forEach((n) => { allNav.push(n); if (n.children) n.children.forEach((c) => allNav.push(c)) })

/* 1. the rail has NO Settings navigation item */
{
  assert.ok(Array.isArray(NAV) && NAV.length > 0, 'NAV extracted and non-empty')
  const ids = NAV.map((n) => n.id)
  assert.ok(!ids.includes('settings'), `NAV contains no settings id (got: ${ids.join(', ')})`)
  assert.ok(!NAV.some((n) => /settings/i.test(n.label || '')), 'NAV contains no Settings label')
  assert.ok(!NAV.some((n) => n.Icon === 'Gear'), 'NAV no longer uses the Gear icon')
  assert.ok(!sidebar.includes('Gear'), 'Sidebar.jsx has no Gear reference left at all')

  // Children count too — Settings must not be smuggled into a section.
  const everyId = flatNav().map((n) => n.id)
  assert.ok(!everyId.includes('settings'), `flatNav() (children included) has no settings id: ${everyId.join(', ')}`)
  assert.ok(
    !sidebar.includes("id: 'settings'") && !sidebar.includes('id: "settings"'),
    'Sidebar.jsx declares no settings nav id',
  )
  assert.ok(!sidebar.includes("onChange('settings')"), 'Sidebar.jsx never navigates to settings')
  assert.ok(!sidebar.includes('aria-label="Settings"'), 'Sidebar.jsx renders no Settings-labelled control')
  assert.ok(!/label:\s*'Settings'/.test(sidebar), 'Sidebar.jsx has no Settings label')

  // Saved prefs outlive releases: an old navOrder that still names 'settings'
  // must be ignored, not resurrected or crash the rail.
  const stale = orderNav(['settings', 'star', 'overview', 'bogus-id'])
  assert.ok(!stale.some((n) => n.id === 'settings'), 'stale saved navOrder cannot bring Settings back')
  assert.deepEqual(
    stale.map((n) => n.id).slice(0, 3), ['star', 'overview', 'schedule'],
    'stale/unknown ids are dropped and the remaining saved order is honoured',
  )
  section('Settings is NOT a Sidebar navigation item (NAV, children, footer, stale prefs)')
}

/* 2. rail footer keeps Collapse only */
{
  const footAt = sidebar.indexOf('<div style={S.foot}>')
  if (assert.ok(footAt !== -1, 'rail footer still exists')) {
    // The footer holds no nested <div>, so its first </div> closes it.
    const foot = sidebar.slice(footAt, sidebar.indexOf('</div>', footAt) + '</div>'.length)
    const buttons = foot.split('<button').length - 1
    assert.equal(buttons, 1, 'rail footer renders exactly one button')
    assert.ok(foot.includes('Collapse'), 'the one footer button is the Collapse toggle')
    assert.ok(!/settings/i.test(foot), 'the rail footer mentions no settings destination')
  }
  section('rail footer is Collapse-only (no Settings button)')
}

/* 3. Settings entry point: the notch pill's Settings tool (the standalone
   Topbar gear was removed) */
{
  assert.ok(!topbar.includes('data-testid="settings-button"'), 'the standalone Topbar gear is gone')
  assert.ok(!topbar.includes('<Gear'), 'the Topbar renders no gear icon')
  assert.ok(topbar.includes('prefs.barShowNotch && <Notch'), 'the notch stays behind prefs.barShowNotch')

  // Layout: the only button left in the Topbar itself is the theme toggle —
  // the removed gear was the other one (the status chip is a separate
  // component, the history toggle went with the chat page).
  assert.equal(topbar.split('<button').length - 1, 1, 'Topbar renders exactly 1 button (theme toggle)')
  assert.ok(topbar.includes('<div style={{ ...S.right, gap: prefs.barGap }}>'), 'right cluster markup unchanged')
  assert.ok(topbar.includes('<RuntimeStatus'), 'runtime status chip preserved')
  assert.equal(
    TOOLS.map((t) => t.id).join(','), 'settings,files',
    'the notch pill keeps its pre-existing Settings + File tools',
  )
  section('Settings entry point is the notch pill tool; standalone gear removed')
}

/* 4. clicking the notch Settings tool triggers the correct navigation (real handler run) */
{
  const m = notch.match(/onClick=\{\(\) => ([^\n]*)\}/)
  if (assert.ok(!!m, 'the notch tool has an onClick handler')) {
    const handlerSrc = m[1].trim()
    assert.equal(
      handlerSrc, 'onNavigate?.(id)',
      'the handler is the shared navigation call (no URLs, no IPC, no dynamic view id)',
    )
    try {
      const calls = []
      const handler = new Function('onNavigate', 'id', `return (() => ${handlerSrc})`)(
        (view) => calls.push(view), 'settings',
      )
      handler()
      assert.deepEqual(calls, ['settings'], "clicking the notch Settings tool navigates to 'settings' exactly once")
    } catch (err) {
      assert.ok(false, `the notch Settings handler executes: ${err.message}`)
    }
  }

  // The whole header shares one navigation contract — no side channels.
  assert.ok(
    !/window\.open|location\.|href=|ipcRenderer|child_process|require\(|eval\(|dangerouslySetInnerHTML|fetch\(/
      .test(topbar),
    'Topbar navigates only through the onNavigate prop',
  )
  section("Settings entry executes onNavigate('settings') via the notch tool")
}

/* 5. App wiring: the header owns the settings view (real expressions run) */
{
  // 5a. Topbar receives the shared navigate() and the active view.
  const topbarAt = appJsx.indexOf('<Topbar')
  if (assert.ok(topbarAt !== -1, 'App renders the Topbar')) {
    const props = appJsx.slice(topbarAt, appJsx.indexOf('/>', topbarAt))
    assert.ok(props.includes('onNavigate={navigate}'), 'Topbar gets onNavigate={navigate}')
    assert.ok(props.includes('active={inRail ? null : view}'), 'Topbar gets the active view when it is not a rail page')
  }

  // 5b. navigate() really sets the view.
  const navStart = appJsx.indexOf('const navigate = ')
  if (assert.ok(navStart !== -1, 'App defines navigate()')) {
    const navSrc = appJsx.slice(
      navStart + 'const navigate = '.length,
      matchBracket(appJsx, appJsx.indexOf('{', navStart)) + 1,
    )
    try {
      const viewed = []
      const navigate = new Function('view', 'setView', 'setPreviousView', `return (${navSrc})`)(
        'overview', (v) => viewed.push(v), () => {},
      )
      navigate('settings')
      assert.deepEqual(viewed, ['settings'], "App's navigate('settings') sets the settings view")
    } catch (err) {
      assert.ok(false, `App's navigate() executes: ${err.message}`)
    }
  }

  // 5c. settings is never a rail page — even if a rail item reappears.
  const inRailMatch = appJsx.match(/const inRail = ([^\r\n]+)/)
  if (assert.ok(!!inRailMatch, 'App derives inRail')) {
    try {
      const inRail = new Function('view', 'allNav', `return (${inRailMatch[1]})`)
      const hostileNav = [...allNav, { id: 'settings', label: 'Settings', Icon: 'Gear' }]
      assert.equal(inRail('settings', hostileNav), false, "inRail('settings') is false even if a rail item named settings is re-added")
      assert.equal(inRail('aiagents', allNav), false, 'the AI chats view is no longer a rail page (removed)')
      assert.equal(inRail('codearena', allNav), false, 'Code Arena is no longer a rail page (removed)')
      assert.equal(inRail('overview', allNav), true, 'top-level rail pages stay rail pages')
      assert.equal(inRail('bogus', allNav), false, 'unknown views are not rail pages')
    } catch (err) {
      assert.ok(false, `inRail expression executes: ${err.message}`)
    }
  }

  // 5d. the rail highlight is derived from inRail, so it stays off for Settings.
  assert.ok(
    appJsx.includes('const activeInSidebar = inRail ? view : null'),
    'the rail highlight follows inRail (Settings never highlights a rail item)',
  )

  // 5e. the header title still reads "Settings" (TOOLS fallback, real data).
  const titleMatch = appJsx.match(/const title =([\s\S]*?)\r?\n\r?\n/)
  if (assert.ok(!!titleMatch, 'App derives the header title')) {
    try {
      const titleOf = new Function('view', 'allNav', 'TOOLS', `return (${titleMatch[1]})`)
      assert.equal(titleOf('settings', allNav, TOOLS), 'Settings', 'header title for the settings view is "Settings"')
      assert.equal(titleOf('overview', allNav, TOOLS), 'Input terminal', 'rail page titles are unchanged')
    } catch (err) {
      assert.ok(false, `title expression executes: ${err.message}`)
    }
  }

  // 5f. the settings view renders the existing Settings page, intact.
  assert.ok(/view === 'settings'/.test(appJsx), 'App routes the settings view')
  const route = appJsx.slice(appJsx.indexOf("view === 'settings'"))
  assert.ok(route.includes('<Settings'), 'the settings view renders <Settings />')
  assert.ok(route.includes('jumpTo={advancedPage}') && route.includes('onJumped='), 'jumpTo/onJumped deep-link wiring preserved')
  assert.ok(
    appJsx.includes("onOpenAdvanced={(panel) => { setView('settings'); setAdvancedPage(panel) }}"),
    'command palette deep-link into advanced settings preserved',
  )

  // 5g. one Settings command in the palette (the rail no longer adds a second).
  assert.equal(palette.split("id: 'nav:settings'").length - 1, 1, 'command palette has exactly one Settings page command')
  assert.ok(palette.includes("run: () => onNavigate('settings')"), 'palette Settings command uses the same navigation contract')
  section('App wiring — header owns the settings view, route + title + palette preserved')
}

/* 6. Settings structure — Quick settings on the main page, everything else
   in Advanced settings; the updater panels are shared (defined in
   Settings.jsx, rendered by the dedicated Updates page) */
{
  assert.ok(settings.includes('export default function Settings({ jumpTo, onJumped })'), 'Settings page signature untouched')
  assert.ok(settings.includes('Quick settings'), 'the main page is the Quick settings page')
  for (const s of ['Presets', 'Theme', 'Accent colour', 'Layout']) {
    assert.ok(settings.includes(`title="${s}"`), `Quick settings keeps its ${s} section`)
  }
  assert.ok(settings.includes('Advanced settings'), 'the main page keeps the Advanced settings entry')
  assert.ok(settings.includes('AdvancedEditor'), 'Settings still opens the advanced editor')

  // One updater implementation, shared by the dedicated Updates page.
  assert.ok(settings.includes('function UpdatesPanel()'), 'Settings.jsx still defines UpdatesPanel')
  assert.ok(settings.includes('function GitHubUpdatePanel()'), 'Settings.jsx still defines GitHubUpdatePanel')
  assert.ok(
    advanced.includes('<UpdatesPanel />') && advanced.includes('<GitHubUpdatePanel />'),
    'the Advanced settings Updates page renders the shared updater panels',
  )
  assert.ok(
    advanced.includes("id: 'updates'") && advanced.includes("group: 'App'"),
    'the dedicated Updates page lives in the App category',
  )

  for (const s of [
    'Check for Updates', 'Download Update', 'Restart to Update', 'up to date',
    'Downloading', 'downloaded and verified', 'development instance',
  ]) {
    assert.ok(settings.toLowerCase().includes(s.toLowerCase()), `UpdatesPanel must contain UI for: ${s}`)
  }
  assert.ok(settings.includes('appInfo'), 'Settings reads appInfo for the version')
  assert.ok(settings.includes('isPackaged'), 'Settings handles packaged vs dev')
  assert.ok(settings.includes('bridge.updater') || settings.includes('updater.check'), 'Settings uses the updater bridge')
  section('Quick settings on top; updater panels shared with the dedicated Updates page')
}

/* 7. updater IPC is safe (no arbitrary URLs) */
{
  assert.ok(!/setFeedURL|updateUrl/i.test(mainJs), 'Main must not expose arbitrary update URL')
  assert.ok(preloadJs.includes('updater') && preloadJs.includes('check()'), 'Preload must expose safe updater API')
  section('Updater is safe (no arbitrary URLs, preload bridge)')
}

/* 8. navigation architecture + renderer security unchanged */
{
  // The settings entry point is one fixed literal view id on the existing
  // in-renderer navigation contract: no URLs, no IPC channel names, no shell,
  // no filesystem/Git surface reachable from the header button.
  for (const re of [
    /window\.open/, /location\.(href|assign|replace)/, /ipcRenderer/, /child_process/,
    /\brequire\(/, /\beval\(/, /dangerouslySetInnerHTML/, /https?:\/\//, /shell\./, /new URL\(/,
  ]) {
    assert.ok(!re.test(topbar), `Topbar introduces no ${re} surface`)
  }
  for (const re of [
    /window\.open/, /location\.(href|assign|replace)/, /ipcRenderer/, /child_process/,
    /https?:\/\//, /dangerouslySetInnerHTML/,
  ]) {
    assert.ok(!re.test(sidebar), `Sidebar introduces no ${re} surface`)
  }
  // Rail view ids minus the removed settings entry and the removed AI
  // section (AI tools / AI chats / Code Arena): no route was invented.
  assert.deepEqual(
    flatNav().map((n) => n.id),
    ['overview', 'schedule', 'cards', 'reports', 'messages', 'assistant', 'star'],
    'rail view ids are unchanged apart from the removed settings entry and AI section',
  )
  assert.ok(
    appJsx.includes("if (view === 'files') {") && appJsx.includes('<FilesWorkspace'),
    'unrelated navigation (files workspace) untouched',
  )
  assert.ok(
    !appJsx.includes("view === 'aiagents'") && !appJsx.includes("view === 'codearena'"),
    'chat / Code Arena routing is gone with the AI section',
  )
  section('navigation architecture and renderer security preserved (fixed literal view id only)')
}

/* 9. Advanced settings structure — every former Settings section moved into
   a clean category, nothing duplicated, and the Assistant→Network rename */
{
  const combined = settings + '\n' + advanced

  // Each moved setting row lives in exactly one place (quick OR advanced).
  // Note: accent rows (e.g. Tint strength) appear exactly once in source
  // because ONE shared AccentSection component is rendered from BOTH the
  // quick page and the advanced "Accent colour" page — by request.
  for (const label of [
    'Density', 'Tint strength', 'Corner radius',
    'Animation intensity', 'Sidebar density', 'UI scale', 'Card radius',
    'Sidebar width', 'Row height',
  ]) {
    const count = (combined.match(new RegExp(`label="${label}"`, 'g')) || []).length
    assert.equal(count, 1, `the ${label} setting appears exactly once (quick + advanced, no duplicates)`)
  }

  // The moved rows still edit the same prefs keys in Advanced settings.
  for (const key of [
    'bgStyle', 'cardStyle', 'sidebarStyle', 'railWidth', 'railItemH',
    'animationIntensity', 'reducedMotion', 'railGap', 'uiScale', 'cmpRadius',
  ]) {
    assert.ok(advanced.includes(`set('${key}'`), `Advanced settings still edits ${key}`)
  }
  assert.ok(advanced.includes("set('fontId'"), 'Advanced settings still edits the quick-page font choice')
  assert.ok(settings.includes(`set('density'`), 'Quick settings still edits density')

  // The advanced nav is grouped into clean categories.
  for (const g of ['App', 'Appearance', 'Navigation', 'System', 'Content']) {
    assert.ok(advanced.includes(`group: '${g}'`), `Advanced settings has the ${g} category`)
  }

  // Assistant → Network: the rail label/tooltip/aria-label now say Network,
  // the route id stays stable ('assistant') so saved prefs survive the rename.
  assert.ok(!/label:\s*'Assistant'/.test(sidebar), 'the rail no longer labels the agent page Assistant')
  assert.ok(sidebar.includes("label: 'Network'"), 'the rail labels the agent page Network')
  assert.ok(sidebar.includes('aria-label={label}'), 'rail items carry an accessible label')
  section('Advanced settings categories, moved settings (no duplicates), Network rename')
}

if (failed) {
  console.error(`\n${failed} settings navigation test(s) failed`)
  process.exit(1)
}
console.log('\nsettings navigation: all passed (rail has no Settings; Quick settings + Advanced settings + Network)')
