/**
 * Classic-script diagnostics for the service worker.
 * Keep in sync with src/lib/diagnostics/logger.js (subset).
 * Never logs cookies, tokens, passwords, or HTML.
 */
(function (root) {
  var FORBIDDEN = /cookie|password|passwd|token|secret|authorization|credential|session|innerhtml/i
  var LENGTH_ONLY = /^(content|text|prompt|html|body|message)$/i
  var MAX = 80
  var entries = []
  var levelName = 'warn'
  var LEVEL = { error: 0, warn: 1, info: 2, debug: 3 }

  function scrub(meta) {
    if (!meta || typeof meta !== 'object') return {}
    var out = {}
    for (var key in meta) {
      if (!Object.prototype.hasOwnProperty.call(meta, key)) continue
      if (FORBIDDEN.test(key)) continue
      var value = meta[key]
      if (LENGTH_ONLY.test(key)) {
        out[key + 'Length'] = value == null ? 0 : String(value).length
        continue
      }
      out[key] = value
    }
    return out
  }

  function emit(lvl, event, meta) {
    var rec = { ts: Date.now(), level: lvl, event: String(event || '') }
    var clean = scrub(meta || {})
    for (var k in clean) rec[k] = clean[k]
    entries.push(rec)
    if (entries.length > MAX) entries.shift()
    if ((LEVEL[lvl] || 0) > (LEVEL[levelName] || 1)) return rec
    if (lvl === 'error') {
      try { console.warn('[hpos]', rec.event, rec.errorCode || '') } catch { /* ignore */ }
    }
    return rec
  }

  root.HPOS_DIAG = {
    error: function (event, meta) { return emit('error', event, meta) },
    warn: function (event, meta) { return emit('warn', event, meta) },
    info: function (event, meta) { return emit('info', event, meta) },
    debug: function (event, meta) { return emit('debug', event, meta) },
    getEntries: function () { return entries.slice() },
  }
})(typeof globalThis !== 'undefined' ? globalThis : self)
