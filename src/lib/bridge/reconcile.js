/**
 * Full-text reconciliation for assistant DOM snapshots.
 *
 * DeepSeek (and similar UIs) typically replace the assistant node's entire
 * innerText on each mutation:
 *   "Hel" → "Hello" → "Hello, how"
 * Concatenating those snapshots would duplicate:
 *   "Hello" + "Hello, how"  ✗
 * Taking the latest snapshot (when it grows as a prefix) is correct:
 *   "Hello, how"  ✓
 *
 * This helper is provider-agnostic — no DeepSeek selectors.
 */

export function reconcileAssistantText(previous, snapshot) {
  const prev = String(previous || '')
  const next = String(snapshot || '')
  if (!next) return prev
  if (!prev) return next
  if (next === prev) return prev

  // Common case: DOM reports the full text so far, growing as a prefix.
  if (next.startsWith(prev)) return next

  // Stale/shorter snapshot while we already hold a longer prefix.
  if (prev.startsWith(next)) return prev

  // Snapshot already contained in previous (repeat of an earlier full text).
  if (prev.includes(next) && next.length < prev.length) return prev

  // Divergent full rewrite (markdown reformat, think-block swap). Replace,
  // never concatenate — concatenation is what produces duplicated replies.
  return next
}

/**
 * Fold a sequence of DOM innerText snapshots into deltas + final text.
 * Used by tests and as the adapter's mental model. Fake tokens are not added.
 */
export function foldSnapshots(beforeText, snapshots) {
  const events = []
  let last = ''
  const baseline = String(beforeText || '')
  for (const raw of snapshots) {
    const snap = String(raw || '').trim()
    if (!snap || snap === baseline) continue
    const next = reconcileAssistantText(last, snap)
    if (next && next !== last) {
      events.push({ event: 'RESPONSE_DELTA', content: next })
      last = next
    }
  }
  return { content: last, events }
}

export function shouldComplete({
  currentText,
  lastEmitted,
  generating,
  stopVisible,
  lastChangeAt,
  now,
  stableMs,
}) {
  if (generating || stopVisible) return false
  if (!currentText) return false
  if (currentText !== lastEmitted) return false
  if (typeof lastChangeAt !== 'number' || typeof now !== 'number') return false
  if (now - lastChangeAt < stableMs) return false
  return true
}
