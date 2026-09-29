/**
 * Direct Chat UI wiring test — mounts the REAL app (App.jsx through Vite) in
 * jsdom, stubs the Arena preload surface, and asserts that a streamed Arena
 * answer lands in the existing Chats bubble.
 *
 * This is the counterpart of the module-level suite in arenaChat.test.mjs:
 * that one proves chat.js, this one proves the Chats section is actually
 * connected to it, and that the UI is otherwise unchanged.
 *
 * jsdom note (same fix as chatsSection.smoke.test.mjs): React 19 checks
 * `'oninput' in document` at module init, so the DOM globals must exist
 * before react-dom is imported.
 */
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5173/',
  pretendToBeVisual: true,
})
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
/* React's own checks (`'oninput' in document`) and the Radix primitives used
   by the prompt box (FocusScope needs MutationObserver, NodeFilter, …) read
   these as GLOBALs, not as window properties. Copy every jsdom global Node
   does not already define instead of chasing them one crash at a time. */
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis || key.startsWith('_')) continue
  try {
    globalThis[key] = dom.window[key]
  } catch {
    /* read-only global — the app does not need it as a global */
  }
}
for (const k of ['localStorage', 'HTMLElement', 'Element', 'Node', 'CustomEvent', 'MutationObserver', 'DOMRect']) {
  globalThis[k] = dom.window[k]
}
globalThis.getComputedStyle = dom.window.getComputedStyle
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame?.bind(dom.window)
  ?? ((cb) => setTimeout(() => cb(Date.now()), 16))
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame?.bind(dom.window)
  ?? ((id) => clearTimeout(id))

if (!dom.window.Element.prototype.scrollIntoView) {
  dom.window.Element.prototype.scrollIntoView = () => {}
}
class RO {
  observe() {}

  unobserve() {}

  disconnect() {}
}
if (!dom.window.ResizeObserver) dom.window.ResizeObserver = RO
/* Radix (the mode-change dialog) calls pointer-capture APIs that jsdom does
   not implement; without them the click on the Search toggle crashes the
   tree instead of opening the dialog. */
for (const name of ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture']) {
  if (!dom.window.HTMLElement.prototype[name]) {
    dom.window.HTMLElement.prototype[name] = () => false
  }
}
if (!dom.window.matchMedia) {
  dom.window.matchMedia = (q) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false },
  })
}
document.oninput = null
document.onchange = null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, timeout = 4000, step = 50) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { if (fn()) return true } catch { /* keep polling */ }
    // eslint-disable-next-line no-await-in-loop
    await sleep(step)
  }
  return false
}

/* ------------------------------------------------- stubbed Arena surface --- */
const arena = { sent: [], cancels: [], listeners: new Set(), finish: null }

dom.window.hpos = {
  arena: {
    chatSend(request) {
      arena.sent.push(request)
      // Resolve later: events stream first, exactly like the real IPC.
      arena.finish = { request }
      return new Promise((resolve) => {
        arena.resolve = resolve
      })
    },
    onChatEvent(cb) {
      arena.listeners.add(cb)
    },
    offChatEvent(cb) {
      arena.listeners.delete(cb)
    },
    chatCancel(request) {
      arena.cancels.push(request)
      // The bridge aborts the turn; the `cancelled` event is emitted below.
      return Promise.resolve({ ok: true, state: 'cancelled' })
    },
    status() {
      return Promise.resolve({ ok: true, running: true, headless: true, busy: false })
    },
  },
}

function emit(payload) {
  for (const cb of [...arena.listeners]) cb(payload)
}

/** The Stop control, when it is on screen. */
const stopButton = () => [...document.querySelectorAll('button')].find(
  (b) => b.getAttribute('aria-label') === 'Stop generating',
)

const vite = await createServer({
  root: new URL('../..', import.meta.url).pathname,
  configFile: 'vite.config.js',
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
})

try {
  const React = (await import('react')).default
  const { createRoot } = await import('react-dom/client')
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

  // 1. Navigate to Chats.
  const chatsBtn = [...document.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === 'Chats',
  )
  assert.ok(chatsBtn, 'Chats rail button exists')
  chatsBtn.click()
  await sleep(200)
  assert.ok(body().includes('How can I help today?'), 'Chats section mounts')

  // 2. Type and submit.
  const textarea = document.querySelector('textarea')
  const setVal = Object.getOwnPropertyDescriptor(
    dom.window.HTMLTextAreaElement.prototype, 'value',
  ).set
  setVal.call(textarea, 'Hello Arena')
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await sleep(80)
  textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
  }))

  assert.ok(await until(() => body().includes('Hello Arena')), 'user bubble appears')
  assert.equal(arena.sent.length, 1, 'the send action reached the Arena bridge')
  assert.equal(arena.sent[0].prompt, 'Hello Arena', 'prompt is forwarded verbatim')
  assert.equal(arena.sent[0].mode, 'text', 'Direct Chat is text mode only')
  assert.ok(arena.sent[0].conversationId, 'the conversation id is sent for event routing')

  // 3. Stream an answer: each update must rewrite the same bubble.
  const id = arena.sent[0].conversationId
  assert.ok(await until(() => body().includes('Thinking…')), 'pending state shows while streaming')

  emit({ conversationId: id, type: 'update', text: 'Partial' })
  assert.ok(await until(() => body().includes('Partial')), 'first update streams into the bubble')

  emit({ conversationId: id, type: 'update', text: 'Partial answer' })
  assert.ok(await until(() => body().includes('Partial answer')), 'second update rewrites the bubble')
  assert.equal(
    (body().match(/Partial/g) || []).length >= 1,
    true,
    'the partial text is a single growing bubble, not a new message per chunk',
  )

  emit({ conversationId: id, type: 'done', text: 'Partial answer from Arena' })
  assert.ok(
    await until(() => body().includes('Partial answer from Arena')),
    'the final text lands in the bubble',
  )
  assert.ok(await until(() => !body().includes('Thinking…')), 'pending clears when the turn ends')

  // 4. Events for a different conversation must be ignored.
  emit({ conversationId: 'some-other-conversation', type: 'update', text: 'LEAKED' })
  await sleep(150)
  assert.equal(body().includes('LEAKED'), false, 'events for another conversation are ignored')

  // 5. The listener is unsubscribed when the turn ends.
  assert.equal(arena.listeners.size, 0, 'offChatEvent is called once the turn settles')

  const resolveTurn1 = arena.resolve
  resolveTurn1({ ok: true, state: 'complete', text: 'Partial answer from Arena', conversationId: id })
  await sleep(50)

  // 6. The UI is otherwise unchanged: the model label and bubble markup survive.
  assert.ok(body().includes('Arena'), 'the reply is labelled with the Arena model')

  /* 6b. Stop control — only while an answer is actively streaming, and it
        cancels the turn without ever sending the prompt again. */
  const sendAgain = async (text) => {
    const box = document.querySelector('textarea')
    setVal.call(box, text)
    box.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await sleep(80)
    box.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
    }))
    await sleep(80)
  }

  await sendAgain('stop me')
  assert.equal(arena.sent.length, 2, 'the stop-scenario prompt reached the bridge')
  assert.ok(await until(() => body().includes('Thinking…')), 'the pending pill is back')
  assert.ok(!stopButton(), 'Stop stays hidden until Arena starts streaming')

  emit({ conversationId: id, type: 'status', state: 'streaming' })
  assert.ok(await until(() => stopButton()), 'Stop appears as soon as the answer starts streaming')

  emit({ conversationId: id, type: 'update', text: 'Half an answer' })
  assert.ok(await until(() => body().includes('Half an answer')), 'the partial answer streams in')
  assert.ok(stopButton(), 'Stop is still offered while the answer grows')

  stopButton().click()
  assert.equal(arena.cancels.length, 1, 'Stop reaches the Arena bridge')
  assert.equal(arena.cancels[0].conversationId, id, 'Stop names the conversation it belongs to')
  assert.equal(arena.sent.length, 2, 'Stop never sends the prompt again')
  assert.ok(await until(() => !stopButton()), 'the Stop control is hidden straight away')

  emit({
    conversationId: id,
    type: 'error',
    state: 'cancelled',
    message: 'The Arena request was cancelled.',
  })
  assert.ok(await until(() => !body().includes('Thinking…')), 'pending clears after cancellation')
  assert.ok(body().includes('Half an answer'), 'the partial answer stays on screen')
  assert.ok(
    !body().includes('The Arena request was cancelled.'),
    'the cancellation message is not written over the answer',
  )
  arena.resolve({ ok: false, state: 'cancelled', conversationId: id })
  await sleep(120)
  assert.equal(arena.sent.length, 2, 'no resend once the invoke reply lands either')
  assert.equal(arena.listeners.size, 0, 'a cancelled turn unsubscribes too')

  /* Send is back to normal: a new prompt starts a fresh turn. */
  await sendAgain('after the stop')
  assert.equal(arena.sent.length, 3, 'Send works again after a cancellation')
  assert.ok(!stopButton(), 'and Stop is not shown until the new turn streams')
  emit({ conversationId: id, type: 'done', text: 'Fresh answer' })
  assert.ok(await until(() => body().includes('Fresh answer')), 'the new turn completes normally')
  arena.resolve({ ok: true, state: 'complete', text: 'Fresh answer', conversationId: id })
  await sleep(120)

  /* 7. Verification stops the turn and is surfaced in the chat — and HPOS
        must not try to send the prompt again (no retries in this phase). */
  const beforeVerify = arena.sent.length
  await sendAgain('second question')
  assert.equal(arena.sent.length, beforeVerify + 1, 'the next prompt reached the bridge')
  emit({
    conversationId: id,
    type: 'error',
    state: 'verification_required',
    message: 'Arena is asking for verification (sign-in, CAPTCHA or a human check). '
      + 'HPOS will not bypass it — finish it yourself in a normal browser window, '
      + 'then start the Arena session again.',
  })
  assert.ok(
    await until(() => body().includes('will not bypass')),
    'verification_required is surfaced to the user in the chat',
  )
  assert.ok(await until(() => !body().includes('Thinking…')), 'pending clears on error')
  arena.resolve({ ok: false, state: 'verification_required', conversationId: id })
  await sleep(150)
  assert.equal(arena.sent.length, beforeVerify + 1, 'a verification failure is never retried')
  assert.equal(arena.listeners.size, 0, 'the error path also unsubscribes')

  // 7. Persistence still works (unchanged behaviour).
  root.unmount()
  await sleep(50)
  const root2 = createRoot(document.getElementById('root'))
  root2.render(tree)
  await sleep(150)
  const chatsBtn2 = [...document.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === 'Chats',
  )
  chatsBtn2.click()
  assert.ok(
    await until(() => body().includes('Partial answer from Arena')),
    'the Arena conversation persists across a simulated reload',
  )

  /* 8. Search mode (Phase 3) — the same session and the same bubble, with the
        sources rendered as Markdown by the existing renderer. Switching mode
        inside a conversation asks before clearing it, which is existing
        behaviour we must not disturb. */
  /* jsdom does not match CSS class selectors on SVG nodes, so compare the
     class attribute instead of using `svg.lucide-globe`. */
  const isGlobe = (b) => {
    const svg = b.querySelector('svg')
    return Boolean(svg && String(svg.getAttribute('class') || '').includes('lucide-globe'))
  }
  const globeBtn = [...document.querySelectorAll('button')].find(isGlobe)
  assert.ok(globeBtn, 'the Search mode toggle exists in the prompt box')
  globeBtn.click()
  await sleep(150)
  const newChatBtn = [...document.querySelectorAll('button')].find(
    (b) => (b.textContent || '').trim() === 'New Chat',
  )
  assert.ok(newChatBtn, 'changing mode inside a conversation asks first')
  newChatBtn.click()
  await sleep(250)
  assert.ok(
    await until(() => body().includes('How can I help today?')),
    'confirming starts an empty chat in Search mode',
  )

  const searchBox = document.querySelector('textarea')
  setVal.call(searchBox, 'capital of france')
  searchBox.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await sleep(80)
  searchBox.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
  }))

  assert.ok(await until(() => arena.sent.length === beforeVerify + 2), 'the search reached the bridge')
  const searchReq = arena.sent[arena.sent.length - 1]
  assert.equal(searchReq.mode, 'search', 'the Search mode is forwarded to Arena')
  assert.equal(searchReq.prompt, 'capital of france', 'the query is forwarded verbatim')
  assert.ok(searchReq.conversationId, 'the conversation id is sent for event routing')
  assert.ok(
    await until(() => body().includes('Searching…')),
    'the pending state reads Searching… in Search mode',
  )

  const sid = searchReq.conversationId
  emit({ conversationId: sid, type: 'status', state: 'streaming' })
  emit({ conversationId: sid, type: 'update', text: 'Paris is the capital' })
  assert.ok(
    await until(() => body().includes('Paris is the capital')),
    'the search result streams into the same bubble',
  )

  const finalText = 'Paris is the capital of France.\n\n---\n**Sources**\n'
    + '1. [Britannica](https://britannica.com/paris)'
  emit({ conversationId: sid, type: 'done', text: finalText, sources: [{ title: 'Britannica', url: 'https://britannica.com/paris' }] })
  assert.ok(await until(() => body().includes('Paris is the capital of France.')), 'the final result lands')
  assert.ok(await until(() => body().includes('Sources')), 'and so does the sources block')
  assert.ok(
    await until(() => !body().includes('Searching…')),
    'pending clears when the search finishes',
  )

  const cited = [...document.querySelectorAll('a')].find(
    (a) => a.getAttribute('href') === 'https://britannica.com/paris',
  )
  assert.ok(cited, 'a cited source is rendered as a real link by the existing Markdown renderer')

  arena.resolve({ ok: true, state: 'complete', text: finalText, mode: 'search', conversationId: sid })
  await sleep(120)
  assert.equal(arena.listeners.size, 0, 'a search turn unsubscribes too')
  assert.equal(arena.sent.length, beforeVerify + 2, 'a completed search is never re-sent')

  root2.unmount()

  console.log('ok    arena direct chat UI: send → streamed updates → final bubble → persistence')
  process.exitCode = 0
} finally {
  await vite.close()
}
