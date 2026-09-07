/**
 * ---------------------------------------------------------------------------
 *  STEP 1 ONLY — local mock assistant. NO network, NO API keys, NO backend.
 *
 *  This module is the ONE place that fabricates assistant replies. When a
 *  real connector lands (DeepSeek / ChatGPT / any HTTP API), replace
 *  `getAssistantReply` here — the chat UI only talks to this function and
 *  never needs to change.
 * ---------------------------------------------------------------------------
 */

/** Message factory — the shape stays identical when a real API replaces it. */
export function createMessage({ role, content, status = 'sent', meta = null }) {
  const id =
    globalThis.crypto?.randomUUID?.() ??
    `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  return { id, role, content, ts: Date.now(), status, meta }
}

/* Small canned brain — keyword match first, generic fallbacks otherwise. */
const CANNED = [
  [/^(hi|hii+|hello|hey|namaste|hola)\b/i,
    'Hello! I am the HPOS assistant, running fully offline in this preview.\nAsk me to draft a reply, summarise something, or explain a feature.'],
  [/who are you|what are you|introduce/i,
    'I am a mock assistant wired into the HPOS chat UI.\nRight now I answer from a tiny local script — no network calls at all.\nLater this slot gets a real model (DeepSeek, ChatGPT, …).'],
  [/what can you do|help|features?/i,
    'In this Step 1 build you can:\n• Send messages with Enter (Shift+Enter adds a new line)\n• Watch the conversation scroll to the latest message\n• Start a fresh chat from the header\nReal AI answers arrive when the connector lands in a later step.'],
  [/summar/i,
    'Sure — paste the text and I will summarise it.\n(Mock note: a real model would analyse the content here; for now I am just proving the send/receive pipeline works.)'],
  [/sale|revenue|profit|order/i,
    'Here is how I would handle a sales question once connected to real data:\n1. Pull the period you care about\n2. Total revenue, orders and average bill\n3. Flag the top movers\n(Mock preview — no data source is connected yet.)'],
  [/thank/i, 'Anytime! Type something else or hit “New chat” to start over.'],
]

const FALLBACKS = [
  (t) => `Got it — “${t}”.\nI am running as a local mock right now, so my reply is scripted. Once the real connector plugs in, this same bubble will carry a genuine answer.`,
  (t) => `Understood: “${t}”.\nEverything you type lands here instantly — the message pipeline (send → list → reply → scroll) is fully working offline.`,
  (t) => `“${t}” — noted.\nTry asking “what can you do” to see the scripted replies, or just keep testing the composer.`,
]

/** Resolves with a mock reply string after a short, human-ish delay. */
export function getAssistantReply(userText) {
  const hit = CANNED.find(([re]) => re.test(userText))
  const body = hit
    ? hit[1]
    : FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)](
        userText.length > 90 ? `${userText.slice(0, 90)}…` : userText,
      )
  const delay = 450 + Math.random() * 550
  return new Promise((resolve) => setTimeout(() => resolve(body), delay))
}
