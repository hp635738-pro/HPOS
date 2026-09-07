/**
 * Keep in sync with src/lib/bridge/reconcile.js
 * Classic script for the DeepSeek adapter isolated world.
 */
(function (root) {
  function reconcileAssistantText(previous, snapshot) {
    var prev = String(previous || '')
    var next = String(snapshot || '')
    if (!next) return prev
    if (!prev) return next
    if (next === prev) return prev
    if (next.indexOf(prev) === 0) return next
    if (prev.indexOf(next) === 0) return prev
    if (prev.indexOf(next) !== -1 && next.length < prev.length) return prev
    return next
  }

  function shouldComplete(opts) {
    if (!opts) return false
    if (opts.generating || opts.stopVisible) return false
    if (!opts.currentText) return false
    if (opts.currentText !== opts.lastEmitted) return false
    if (typeof opts.lastChangeAt !== 'number' || typeof opts.now !== 'number') return false
    if (opts.now - opts.lastChangeAt < opts.stableMs) return false
    return true
  }

  root.HPOS_RECONCILE = {
    reconcileAssistantText: reconcileAssistantText,
    shouldComplete: shouldComplete,
  }
})(typeof globalThis !== 'undefined' ? globalThis : self)
