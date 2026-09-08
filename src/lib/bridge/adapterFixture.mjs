/**
 * Test-only harness: loads the REAL DeepSeek adapter bundle (same file order
 * as DS_ADAPTER_FILES in extension/background.js) into a vm against a fake
 * DeepSeek page. No browser, no network, no real DeepSeek session.
 *
 * The fake DOM is deliberately tiny: elements declare the exact config
 * selector strings they match (`sels`), plus parent/children wiring for
 * closest()/contains()/scoped queries. MutationObserver callbacks are driven
 * manually via fixture.tick().
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const extensionDir = join(root, '../extension')

const ADAPTER_FILES = [
  'protocol.js',
  'adapters/deepseek.config.js',
  'adapters/deepseek.identity.js',
  'adapters/reconcile.js',
  'adapters/deepseek.js',
]

const TIMING_OVERRIDES = `
  DEEPSEEK_CONFIG.stableMs = 30
  DEEPSEEK_CONFIG.deltaMinMs = 0
  DEEPSEEK_CONFIG.firstTokenMs = 4000
  DEEPSEEK_CONFIG.maxObserveMs = 8000
  DEEPSEEK_CONFIG.thinkAnswerGapMs = 300
  DEEPSEEK_CONFIG.newChatWaitMs = 600
  DEEPSEEK_CONFIG.newChatPollMs = 15
`

class FakeEl {
  constructor(opts = {}) {
    this.tagName = opts.tagName || 'DIV'
    this.parent = opts.parent || null
    this.children = []
    if (this.parent) this.parent.children.push(this)
    this.sels = Array.isArray(opts.sels) ? opts.sels : []
    this.attrs = opts.attrs || {}
    this.rect = opts.rect || { width: 200, height: 20 }
    this.text = opts.text ?? ''
    this.value = opts.value ?? ''
    this.isContentEditable = Boolean(opts.isContentEditable)
    this.disabled = Boolean(opts.disabled)
    this.clicked = 0
    this.onClick = opts.onClick || null
  }

  get parentElement() { return this.parent }
  get innerText() { return computedText(this) }
  get textContent() { return computedText(this) }

  getBoundingClientRect() { return this.rect }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null }

  matches(sel) { return matchSel(this, sel) }

  closest(sel) {
    let node = this
    while (node) {
      if (matchSel(node, sel)) return node
      node = node.parent
    }
    return null
  }

  contains(el) {
    let node = el
    while (node) {
      if (node === this) return true
      node = node.parent
    }
    return false
  }

  querySelectorAll(sel) {
    const out = []
    const walk = (el) => {
      for (const child of el.children) {
        if (matchSel(child, sel)) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }

  querySelector(sel) { return this.querySelectorAll(sel)[0] || null }

  focus() {}

  click() {
    this.clicked += 1
    if (this.onClick) this.onClick()
  }

  dispatchEvent() { return true }
}

function computedText(el) {
  let out = el.text || ''
  for (const child of el.children) {
    const t = computedText(child)
    if (t) out = out ? `${out}\n${t}` : t
  }
  return out
}

function matchSel(el, sel) {
  const parts = String(sel || '').split(',')
  for (const raw of parts) {
    const part = raw.trim()
    if (!part) continue
    if (part === 'textarea') {
      if (el.tagName === 'TEXTAREA') return true
      continue
    }
    if (part === 'a') {
      if (el.tagName === 'A') return true
      continue
    }
    if (part === 'button') {
      if (el.tagName === 'BUTTON') return true
      continue
    }
    if (el.sels.includes(part)) return true
  }
  return false
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Build a fake signed-in DeepSeek page and load the real adapter into it.
 *
 * Options:
 *   pathname      — starting route ('/a/chat/s/sess-…' or '/a/chat')
 *   hostname      — defaults to chat.deepseek.com
 */
export function loadDeepSeekPage({ pathname = '/a/chat', hostname = 'chat.deepseek.com' } = {}) {
  const registry = []
  const observers = []
  const listeners = []
  const events = []
  const location = {
    hostname,
    origin: `https://${hostname}`,
    pathname,
    href: `https://${hostname}${pathname}`,
  }

  const documentEl = new FakeEl({ tagName: 'HTML', rect: { width: 1200, height: 800 } })
  const body = new FakeEl({ tagName: 'BODY', parent: documentEl, rect: { width: 1200, height: 800 } })
  registry.push(documentEl, body)

  const document = {
    body,
    documentElement: documentEl,
    querySelectorAll(sel) {
      if (sel === 'body *') return registry.filter((el) => el !== documentEl && el !== body)
      return registry.filter((el) => matchSel(el, sel))
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null },
    execCommand() { return false },
  }

  class FakeEvent {
    constructor(type, opts) {
      this.type = type
      Object.assign(this, opts || {})
    }
  }

  class FakeMutationObserver {
    constructor(cb) {
      this.cb = cb
      this.dead = false
      observers.push(this)
    }
    observe() {}
    disconnect() { this.dead = true }
  }

  const sandbox = {
    console,
    URL,
    location,
    document,
    window: { addEventListener: () => {} },
    chrome: {
      runtime: {
        onMessage: { addListener: (fn) => { listeners.push(fn) } },
        sendMessage: (msg) => { events.push(msg && msg.payload ? msg.payload : msg) },
      },
    },
    Event: FakeEvent,
    KeyboardEvent: FakeEvent,
    MutationObserver: FakeMutationObserver,
    HTMLTextAreaElement: function HTMLTextAreaElement() {},
    HTMLInputElement: function HTMLInputElement() {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  const context = createContext(sandbox)

  for (const file of ADAPTER_FILES) {
    runInContext(readExtension(file), context, { filename: file })
    if (file === 'adapters/deepseek.config.js') {
      runInContext(TIMING_OVERRIDES, context, { filename: 'timing-overrides' })
    }
  }

  const fixture = {
    context,
    events,
    location,
    wait,
    navigate(path) {
      location.pathname = path
      location.href = `https://${location.hostname}${path}`
    },
    addEl(opts = {}) {
      const el = new FakeEl(opts)
      registry.push(el)
      return el
    },
    removeEl(el) {
      const i = registry.indexOf(el)
      if (i !== -1) registry.splice(i, 1)
      if (el.parent) {
        const j = el.parent.children.indexOf(el)
        if (j !== -1) el.parent.children.splice(j, 1)
      }
    },
    tick() {
      for (const obs of observers) {
        if (!obs.dead) obs.cb([])
      }
    },
    async dispatch(message) {
      if (!listeners.length) throw new Error('adapter did not register a listener')
      let response
      let settled
      const done = new Promise((resolve) => { settled = resolve })
      const keepAlive = listeners[0](message, null, (res) => {
        response = res
        settled(res)
      })
      if (keepAlive === true) {
        await done
        return response
      }
      return response
    },
  }
  return fixture
}

function readExtension(file) {
  return readFileSync(join(extensionDir, file), 'utf8')
}

/** DeepSeek-looking composer + visible send button wired to the fixture. */
export function addComposer(fixture) {
  const input = fixture.addEl({
    tagName: 'TEXTAREA',
    sels: ['textarea[name="search"]', 'textarea[placeholder*="Message DeepSeek"]'],
    rect: { width: 420, height: 26 },
  })
  const send = fixture.addEl({
    tagName: 'BUTTON',
    sels: ['button[aria-label="Send"]'],
    rect: { width: 40, height: 26 },
  })
  return { input, send }
}

/** Visible Stop control, toggled to mirror DeepSeek's generating state. */
export function addStop(fixture) {
  const stop = fixture.addEl({
    tagName: 'BUTTON',
    sels: ['button[aria-label="Stop"]'],
    rect: { width: 40, height: 26 },
  })
  stop.rect = { width: 0, height: 0 }
  return {
    show() { stop.rect = { width: 40, height: 26 } },
    hide() { stop.rect = { width: 0, height: 0 } },
    el: stop,
  }
}

/** Sidebar "New chat" control; click navigates home like the real SPA. */
export function addNewChatControl(fixture, { navigates = true, home = '/a/chat' } = {}) {
  return fixture.addEl({
    tagName: 'A',
    sels: ['a[href="/a/chat"]'],
    attrs: { href: '/a/chat' },
    rect: { width: 160, height: 32 },
    onClick: navigates ? () => fixture.navigate(home) : null,
  })
}

/**
 * An assistant turn row (`.ds-message`).
 *  thinking: omit/'' → no think block (normal mode); text → `.ds-think-content` child
 *  wrap:     true → answer sits inside `.ds-assistant-message-main-content`
 *            false → answer `.ds-markdown` is a direct child (older layout)
 */
export function addTurn(fixture, { thinking = '', answer = '', wrap = true } = {}) {
  const row = fixture.addEl({ sels: ['.ds-message'], rect: { width: 600, height: 200 } })
  let thinkEl = null
  if (thinking) {
    thinkEl = fixture.addEl({
      parent: row,
      text: thinking,
      sels: ['.ds-think-content', '.ds-markdown', '[class*="ds-markdown"]'],
      rect: { width: 600, height: 60 },
    })
  }
  let answerEl = null
  if (wrap) {
    const wrapper = fixture.addEl({
      parent: row,
      sels: ['.ds-assistant-message-main-content'],
      rect: { width: 600, height: 120 },
    })
    answerEl = fixture.addEl({
      parent: wrapper,
      text: answer,
      sels: ['.ds-markdown', '[class*="ds-markdown"]'],
      rect: { width: 600, height: 120 },
    })
  } else {
    answerEl = fixture.addEl({
      parent: row,
      text: answer,
      sels: ['.ds-markdown', '[class*="ds-markdown"]'],
      rect: { width: 600, height: 120 },
    })
  }
  return { row, thinkEl, answerEl }
}

export function connectorEvents(fixture) {
  return fixture.events.filter((e) => e && e.type === 'CONNECTOR_EVENT')
}

export function sleepMs(ms) {
  return wait(ms)
}
