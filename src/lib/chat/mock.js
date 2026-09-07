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
    'Hello! I am the HPOS assistant.\nAsk me to draft a reply, summarise something, or explain a feature.'],
  [/who are you|what are you|introduce/i,
    'I am the HPOS assistant.\nI can help you draft replies, summarise text, and walk through features.'],
  [/what can you do|help|features?/i,
    'Here is what I can help with:\n• Draft a reply to a customer\n• Summarise a piece of text\n• Explain how a feature works\nSend a message with Enter — Shift+Enter adds a new line. Use New chat in the header to start fresh.'],
  [/summar/i,
    'Sure — paste the text and I will summarise it.'],
  [/sale|revenue|profit|order/i,
    'Here is how I would handle a sales question:\n1. Pull the period you care about\n2. Total revenue, orders and average bill\n3. Flag the top movers'],
  [/thank/i, 'Anytime! Type something else or hit “New chat” to start over.'],
]

const FALLBACKS = [
  (t) => `Got it — “${t}”.\nTell me a bit more and I can draft a reply, summarise it, or break it down.`,
  (t) => `Understood: “${t}”.\nWhat would you like me to do with this — summarise, rewrite, or draft a reply?`,
  (t) => `“${t}” — noted.\nAsk “what can you do” for a quick overview, or keep going and I will follow your lead.`,
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
