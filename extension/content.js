/* HPOS page ↔ background relay. Isolated world. No cookies, no DOM scraping. */
(function () {
  var P = globalThis.HPOS_PROTOCOL
  if (!P) return

  function isHposPage() {
    try {
      return document.documentElement
        && document.documentElement.getAttribute('data-hpos-app') === 'hpos'
    } catch {
      return false
    }
  }

  function postToPage(msg) {
    try {
      window.postMessage(msg, window.location.origin)
    } catch { /* ignore */ }
  }

  function announceReady() {
    postToPage(P.makeEvent(P.ACTION.BRIDGE_READY, { version: P.VERSION }))
  }

  if (globalThis.__HPOS_BRIDGE_CONTENT__) {
    if (isHposPage()) announceReady()
    return
  }
  globalThis.__HPOS_BRIDGE_CONTENT__ = true

  function onPageMessage(event) {
    if (event.source !== window) return
    if (event.origin !== window.location.origin) return
    if (!isHposPage()) return

    var data = event.data
    if (!P.isWellFormedRequest(data)) return

    if (!P.isAllowedRequestAction(data.action)) {
      postToPage(P.makeResponse(data.requestId, data.action, false, null, {
        code: P.ERROR.UNKNOWN_ACTION,
        message: 'Unsupported action: ' + data.action,
      }))
      return
    }

    var outbound = P.pickRequest(data)

    try {
      chrome.runtime.sendMessage(outbound, function (response) {
        if (chrome.runtime.lastError) {
          postToPage(P.makeResponse(data.requestId, data.action, false, null, {
            code: P.ERROR.DISCONNECTED,
            message: chrome.runtime.lastError.message || 'Extension disconnected',
          }))
          return
        }
        if (!P.isWellFormedResponse(response)) {
          postToPage(P.makeResponse(data.requestId, data.action, false, null, {
            code: P.ERROR.UNEXPECTED_RESPONSE,
            message: 'Unexpected response from extension',
          }))
          return
        }
        postToPage(response)
      })
    } catch {
      postToPage(P.makeResponse(data.requestId, data.action, false, null, {
        code: P.ERROR.DISCONNECTED,
        message: 'Extension is not available',
      }))
    }
  }

  function onRuntimeMessage(message) {
    if (!isHposPage()) return
    if (!message || message.channel !== P.CHANNEL) return
    if (message.type === P.TYPE.EVENT) postToPage(message)
  }

  function bind() {
    if (!isHposPage()) return false
    window.addEventListener('message', onPageMessage)
    try { chrome.runtime.onMessage.addListener(onRuntimeMessage) } catch { /* ignore */ }
    announceReady()
    return true
  }

  if (!bind()) {
    window.addEventListener('DOMContentLoaded', function () { bind() }, { once: true })
  }
})()
