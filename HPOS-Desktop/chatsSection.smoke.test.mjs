/**
 * Chats section smoke test — mounts the REAL app (App.jsx through Vite's
 * transform pipeline) inside jsdom, clicks the "Chats" rail item, sends a
 * message through the PromptInputBox and asserts the conversation renders.
 *
 * Purpose: the compo section (ai-prompt-box / thinking-orbs /
 * markdown-renderer) is TSX from a Next.js repo — this guards the Vite port
 * against runtime breakage (bad imports, Radix/framer issues, alias misses).
 *
 * jsdom note: jsdom's Document lacks GlobalEventHandlers, so `'oninput' in
 * document` is false and React 19 silently falls back to its IE polyfill
 * path that ignores dispatched `input` events — controlled onChange never
 * fires. Seeding `document.oninput`/`onchange` BEFORE react-dom is imported
 * makes React use the normal input-event path (all React imports in this
 * file are therefore dynamic, after the DOM globals exist).
 */
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'

/* ---- jsdom globals (must exist before any component code runs) ---------- */
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5173/',
  pretendToBeVisual: true,
})
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
for (const k of ['localStorage', 'HTMLElement', 'Element', 'Node', 'CustomEvent']) {
  globalThis[k] = dom.window[k]
}
globalThis.getComputedStyle = dom.window.getComputedStyle
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame?.bind(dom.window)
  ?? ((cb) => setTimeout(() => cb(Date.now()), 16))
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame?.bind(dom.window)
  ?? ((id) => clearTimeout(id))

// jsdom gaps used by the app / Radix / framer-motion
if (!dom.window.Element.prototype.scrollIntoView) {
  dom.window.Element.prototype.scrollIntoView = () => {}
}
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!dom.window.ResizeObserver) dom.window.ResizeObserver = RO
if (!dom.window.matchMedia) {
  dom.window.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false },
  })
}
// React 19 event-system fix — see the note above. MUST run before react-dom
// is imported (it evaluates `isInputEventSupported` at module init).
document.oninput = null
document.onchange = null

/* ---- now it is safe to import React and load the app through Vite -------- */
const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// framer-motion's AnimatePresence swaps views with a wait-mode exit
// animation — poll instead of fixed sleeps.
const until = async (fn, timeout = 4000, step = 100) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { if (fn()) return true } catch { /* keep polling */ }
    await sleep(step)
  }
  return false
}

const vite = await createServer({
  root: new URL('..', import.meta.url).pathname,
  configFile: 'vite.config.js',
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
})
try {
  const { default: App } = await vite.ssrLoadModule('/src/App.jsx')
  const { ThemeProvider } = await vite.ssrLoadModule('/src/theme/ThemeContext.jsx')
  const { ToastProvider } = await vite.ssrLoadModule('/src/components/ui/Toast.jsx')
  const { ModalProvider } = await vite.ssrLoadModule('/src/components/ui/Modal.jsx')

  const tree = React.createElement(ThemeProvider, null,
    React.createElement(ToastProvider, null,
      React.createElement(ModalProvider, null, React.createElement(App))))

  const root = createRoot(document.getElementById('root'))
  root.render(tree)
  await sleep(150)

  const body = () => document.body.textContent || ''

  // 1. App shell renders with the rail (brand + nav labels).
  assert.ok(body().includes('HPOS'), 'app shell renders (brand text visible)')
  assert.ok(body().includes('Chats'), 'rail contains the Chats item')

  // 2. Click the Chats rail item → the section mounts (empty state hero).
  const chatsBtn = [...document.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === 'Chats',
  )
  assert.ok(chatsBtn, 'Chats rail button exists')
  chatsBtn.click()
  await sleep(200)
  assert.ok(
    body().includes('How can I help today?'),
    'Chats section mounts with the empty-state hero',
  )

  // 3. Type into the prompt textarea (React controlled input) and submit
  //    via Enter (PromptInputTextarea: Enter without shift submits).
  const textarea = document.querySelector('textarea')
  assert.ok(textarea, 'prompt textarea exists')

  const setVal = Object.getOwnPropertyDescriptor(
    dom.window.HTMLTextAreaElement.prototype, 'value',
  ).set
  setVal.call(textarea, 'Hello from HPOS')
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await sleep(80)
  textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
  }))

  assert.ok(
    await until(() => body().includes('Hello from HPOS')),
    'user bubble appears after send',
  )
  assert.ok(
    await until(() => body().includes('Thinking…')),
    'pending state shows the ThinkingOrb label',
  )

  // 4. Dummy assistant reply arrives and renders through MarkdownRenderer.
  assert.ok(
    await until(() => body().includes('structured demo response')),
    'assistant markdown reply rendered',
  )

  // 5. Persistence: a fresh render picks up localStorage.
  root.unmount()
  await sleep(50)
  const root2 = createRoot(document.getElementById('root'))
  root2.render(tree)
  await sleep(150)
  // The app always boots on the overview rail page — navigate to Chats again.
  const chatsBtn2 = [...document.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === 'Chats',
  )
  assert.ok(chatsBtn2, 'Chats rail button exists after remount')
  chatsBtn2.click()
  assert.ok(
    await until(() => body().includes('structured demo response')),
    'conversation persists across a simulated reload (localStorage)',
  )

  root2.unmount()
  console.log('ok    chats section smoke: rail → prompt box → send → markdown reply → persistence')
  process.exitCode = 0
} finally {
  await vite.close()
}
