/**
 * DeepSeek DOM adapter. Isolated world on chat.deepseek.com only.
 * Reads visible composer + assistant markdown. Never cookies, tokens, or storage.
 */
(function () {
  var P = globalThis.HPOS_PROTOCOL
  var C = globalThis.DEEPSEEK_CONFIG
  var R = globalThis.HPOS_RECONCILE
  var I = globalThis.HPOS_DS_IDENTITY
  if (!P || !C || !R) return

  if (globalThis.__HPOS_DEEPSEEK_ADAPTER__) {
    return
  }
  globalThis.__HPOS_DEEPSEEK_ADAPTER__ = true

  var session = null

  function hostOk() {
    return C.hosts.indexOf(location.hostname) !== -1
  }

  function isLogin() {
    var path = location.pathname || ''
    for (var i = 0; i < C.loginPaths.length; i++) {
      if (path.indexOf(C.loginPaths[i]) === 0) return true
    }
    return false
  }

  function pageValid() {
    return hostOk() && !isLogin()
  }

  function isSupportedPage() {
    return pageValid()
  }

  function isReady() {
    return Boolean(detect().ready)
  }

  function visible(el) {
    if (!el) return false
    var r = el.getBoundingClientRect()
    return r.width > 4 && r.height > 4
  }

  function findInput() {
    var list = C.input
    for (var i = 0; i < list.length; i++) {
      try {
        var nodes = document.querySelectorAll(list[i])
        for (var j = 0; j < nodes.length; j++) {
          if (visible(nodes[j])) return nodes[j]
        }
      } catch { /* ignore */ }
    }
    var areas = document.querySelectorAll('textarea')
    for (var k = 0; k < areas.length; k++) {
      if (visible(areas[k])) return areas[k]
    }
    return null
  }

  function isDisabled(el) {
    if (!el) return true
    var btn = el.closest ? (el.closest('button') || el) : el
    return Boolean(btn.disabled || btn.getAttribute('aria-disabled') === 'true')
  }

  function findSend(input) {
    var list = C.send
    for (var i = 0; i < list.length; i++) {
      try {
        var el = document.querySelector(list[i])
        if (el && visible(el) && !isDisabled(el)) return el.closest('button') || el
      } catch { /* ignore */ }
    }
    var root = (input && (input.closest('form') || input.parentElement)) || document
    var walk = root
    for (var d = 0; d < 5 && walk && walk !== document.body; d++) {
      var buttons = walk.querySelectorAll('button')
      var enabled = []
      for (var b = 0; b < buttons.length; b++) {
        if (visible(buttons[b]) && !isDisabled(buttons[b])) enabled.push(buttons[b])
      }
      if (enabled.length) return enabled[enabled.length - 1]
      walk = walk.parentElement
    }
    return null
  }

  function findStop() {
    for (var i = 0; i < C.stop.length; i++) {
      try {
        var el = document.querySelector(C.stop[i])
        if (el && visible(el) && !isDisabled(el)) return el.closest('button') || el
      } catch { /* ignore */ }
    }
    return null
  }

  function generating() {
    return Boolean(findStop())
  }

  function listAssistantNodes() {
    var out = []
    var seen = []
    for (var i = 0; i < C.assistant.length; i++) {
      try {
        var found = document.querySelectorAll(C.assistant[i])
        for (var j = 0; j < found.length; j++) {
          var el = found[j]
          if (seen.indexOf(el) === -1) {
            seen.push(el)
            out.push(el)
          }
        }
      } catch { /* ignore */ }
    }
    return out
  }

  function nodeText(el) {
    if (!el) return ''
    var text = (el.innerText || el.textContent || '').trim()
    if (text.length > C.maxChars) text = text.slice(0, C.maxChars)
    return text
  }

  function pinTarget(beforeNodes, beforeText) {
    var now = listAssistantNodes()
    var i
    for (i = 0; i < now.length; i++) {
      if (beforeNodes.indexOf(now[i]) === -1) return now[i]
    }
    var last = now.length ? now[now.length - 1] : null
    if (last) {
      var t = nodeText(last)
      if (t && t !== beforeText) return last
    }
    return null
  }

  function observeRoot() {
    var list = C.observeRoot || C.transcriptFallback || []
    for (var i = 0; i < list.length; i++) {
      try {
        var el = document.querySelector(list[i])
        if (el) return el
      } catch { /* ignore */ }
    }
    return document.body
  }

  function getCurrentConversationIdentity() {
    if (!hostOk()) {
      return { supported: false, reason: P.ERROR.UNSUPPORTED_PAGE }
    }
    if (isLogin()) {
      return { supported: false, reason: P.ERROR.UNSUPPORTED_PAGE, login: true }
    }
    if (I && typeof I.getCurrent === 'function') return I.getCurrent()
    return { supported: false, reason: 'UNVERIFIED' }
  }

  function detect() {
    if (!hostOk()) {
      return {
        ok: false,
        ready: false,
        error: P.ERROR.UNSUPPORTED_PAGE,
        message: 'Unsupported page',
      }
    }
    if (isLogin()) {
      return {
        ok: false,
        ready: false,
        detected: true,
        error: P.ERROR.UNSUPPORTED_PAGE,
        message: 'DeepSeek login page — sign in first',
      }
    }
    var input = findInput()
    return {
      ok: Boolean(input),
      ready: isReady(),
      supportedPage: isSupportedPage(),
      detected: true,
      host: location.hostname,
      path: location.pathname,
      hasInput: Boolean(input),
      generating: generating(),
      error: input ? null : P.ERROR.INPUT_NOT_FOUND,
      message: input ? 'DeepSeek ready' : 'DeepSeek input not found',
    }
  }

  function setNativeValue(el, text) {
    el.focus()
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      try {
        if (el._valueTracker) el._valueTracker.setValue('')
      } catch { /* ignore */ }
      var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      var desc = Object.getOwnPropertyDescriptor(proto, 'value')
      if (desc && desc.set) desc.set.call(el, text)
      else el.value = text
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      try {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
      } catch { /* ignore */ }
      return (el.value || '') === text || (el.value || '').indexOf(text.slice(0, 24)) !== -1
    }
    if (el.isContentEditable) {
      try {
        document.execCommand('selectAll', false, null)
        document.execCommand('insertText', false, text)
      } catch { /* ignore */ }
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return (el.innerText || '').indexOf(text.slice(0, 24)) !== -1
    }
    return false
  }

  function pressEnter(el) {
    el.focus()
    var opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true }
    ;['keydown', 'keypress', 'keyup'].forEach(function (type) {
      el.dispatchEvent(new KeyboardEvent(type, opts))
    })
  }

  function emit(event, sessionRef, content, extra) {
    var payload = {
      type: 'CONNECTOR_EVENT',
      source: 'deepseek',
      event: event,
      messageId: sessionRef && sessionRef.messageId,
      requestId: sessionRef && sessionRef.requestId,
      conversationId: sessionRef && sessionRef.conversationId,
      content: content || '',
    }
    if (extra) {
      for (var k in extra) payload[k] = extra[k]
    }
    try {
      chrome.runtime.sendMessage({
        channel: P.CHANNEL,
        type: P.TYPE.EVENT,
        action: P.ACTION.CONNECTOR_EVENT,
        requestId: sessionRef && sessionRef.requestId ? sessionRef.requestId : null,
        payload: payload,
        ts: Date.now(),
        from: 'deepseek',
      })
    } catch { /* ignore */ }
  }

  function stopSession() {
    if (!session) return
    if (session.observer) session.observer.disconnect()
    if (session.stableTimer) clearTimeout(session.stableTimer)
    if (session.limitTimer) clearTimeout(session.limitTimer)
    if (session.firstTimer) clearTimeout(session.firstTimer)
    session = null
  }

  function startObserve(ids, beforeNodes, beforeText) {
    stopSession()
    var finished = false
    var last = ''
    var lastChangeAt = 0
    var lastEmitAt = 0
    var gotToken = false
    var pinned = null

    function finish(event, code, message) {
      if (finished) return
      finished = true
      var text = last || (pinned ? nodeText(pinned) : '')
      var ref = session
      stopSession()
      if (event === 'RESPONSE_COMPLETE') {
        emit('RESPONSE_COMPLETE', ref, text)
      } else {
        emit('ERROR', ref, text, { code: code, message: message })
      }
    }

    function onTick() {
      if (finished) return
      if (!pageValid()) return finish('ERROR', P.ERROR.PAGE_CHANGED, 'Page changed')
      if (!document.body) return finish('ERROR', P.ERROR.PAGE_CHANGED, 'Page changed')

      if (!pinned) pinned = pinTarget(beforeNodes, beforeText)
      var raw = pinned ? nodeText(pinned) : ''
      if (raw === beforeText) raw = ''
      var next = R.reconcileAssistantText(last, raw)

      if (next && next !== last) {
        gotToken = true
        last = next
        lastChangeAt = Date.now()
        if (session && session.firstTimer) {
          clearTimeout(session.firstTimer)
          session.firstTimer = null
        }
        if (Date.now() - lastEmitAt >= C.deltaMinMs) {
          lastEmitAt = Date.now()
          emit('RESPONSE_DELTA', session, last)
        }
      }

      if (!gotToken && !findInput() && !generating()) {
        return finish('ERROR', P.ERROR.COMPOSER_GONE, 'Composer disappeared')
      }

      if (session && session.stableTimer) clearTimeout(session.stableTimer)
      session.stableTimer = setTimeout(function onStable() {
        if (finished || !session) return
        var nowText = R.reconcileAssistantText(last, pinned ? nodeText(pinned) : '')
        if (nowText && nowText !== last) {
          last = nowText
          lastChangeAt = Date.now()
          lastEmitAt = Date.now()
          emit('RESPONSE_DELTA', session, last)
        }
        if (R.shouldComplete({
          currentText: last,
          lastEmitted: last,
          generating: generating(),
          stopVisible: Boolean(findStop()),
          lastChangeAt: lastChangeAt,
          now: Date.now(),
          stableMs: C.stableMs,
        })) {
          finish('RESPONSE_COMPLETE')
          return
        }
        session.stableTimer = setTimeout(onStable, C.stableMs)
      }, C.stableMs)
    }

    var observer = new MutationObserver(onTick)
    var root = observeRoot()
    observer.observe(root || document.body, { childList: true, subtree: true, characterData: true })

    session = {
      messageId: ids.messageId,
      requestId: ids.requestId,
      conversationId: ids.conversationId,
      observer: observer,
      stableTimer: null,
      firstTimer: setTimeout(function () {
        if (!gotToken) finish('ERROR', P.ERROR.RESPONSE_NOT_DETECTED, 'Response not detected')
      }, C.firstTokenMs),
      limitTimer: setTimeout(function () {
        if (generating() || (pinned && nodeText(pinned) !== last)) {
          finish('ERROR', P.ERROR.CONNECTOR_TIMEOUT, 'Connector timeout')
        } else if (gotToken) {
          finish('RESPONSE_COMPLETE')
        } else {
          finish('ERROR', P.ERROR.CONNECTOR_TIMEOUT, 'Connector timeout')
        }
      }, C.maxObserveMs),
    }

    emit('RESPONSE_START', session, '')
    onTick()
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms) })
  }

  function busy() {
    return Boolean(session)
  }

  async function sendPrompt(payload, requestId) {
    if (busy()) {
      return { success: false, error: { code: P.ERROR.BUSY, message: 'A response is still generating' } }
    }
    var snap = detect()
    if (!snap.ok) {
      return {
        success: false,
        error: { code: snap.error || P.ERROR.UNSUPPORTED_PAGE, message: snap.message || 'Unsupported page' },
      }
    }
    var input = findInput()
    if (!input) {
      return { success: false, error: { code: P.ERROR.INPUT_NOT_FOUND, message: 'Input not found' } }
    }

    var beforeNodes = listAssistantNodes()
    var beforeText = beforeNodes.length ? nodeText(beforeNodes[beforeNodes.length - 1]) : ''

    var ok = setNativeValue(input, payload.text)
    if (!ok) {
      input.focus()
      try { document.execCommand('insertText', false, payload.text) } catch { /* ignore */ }
    }
    await sleep(80)

    var send = findSend(input)
    if (send) send.click()
    else pressEnter(input)
    await sleep(350)

    var still = (input.value || input.innerText || '').trim()
    if (still === payload.text.trim()) {
      pressEnter(input)
      await sleep(250)
      still = (input.value || input.innerText || '').trim()
    }
    if (still === payload.text.trim() && !generating()) {
      if (!send) {
        return { success: false, error: { code: P.ERROR.SEND_NOT_FOUND, message: 'Send button not found' } }
      }
    }

    startObserve(
      { messageId: payload.messageId, requestId: requestId, conversationId: payload.conversationId },
      beforeNodes,
      beforeText,
    )
    return {
      success: true,
      accepted: true,
      messageId: payload.messageId,
      requestId: requestId,
      conversationId: payload.conversationId || '',
    }
  }

  function handleStop() {
    if (!session) {
      return { success: false, error: { code: P.ERROR.STOP_NOT_AVAILABLE, message: 'No in-flight response' } }
    }
    var btn = findStop()
    if (!btn) {
      return { success: false, error: { code: P.ERROR.STOP_NOT_AVAILABLE, message: 'DeepSeek Stop control not found' } }
    }
    btn.click()
    return { success: true, stopping: true }
  }

  function onPageGone() {
    if (!session) return
    var ref = session
    var text = ''
    stopSession()
    emit('ERROR', ref, text, { code: P.ERROR.PAGE_CHANGED, message: 'Page changed' })
  }

  window.addEventListener('pagehide', onPageGone)
  window.addEventListener('popstate', function () {
    if (!pageValid()) onPageGone()
  })

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    try {
      if (!message || message.channel !== P.CHANNEL) return
      if (message.action === P.ACTION.DS_IDENTITY) {
        var ident = getCurrentConversationIdentity()
        sendResponse({
          success: ident.supported === true,
          payload: ident,
          error: ident.supported ? null : {
            code: ident.reason === P.ERROR.UNSUPPORTED_PAGE || ident.login
              ? P.ERROR.UNSUPPORTED_PAGE
              : (P.ERROR.DEEPSEEK_CONVERSATION_UNVERIFIED || 'DEEPSEEK_CONVERSATION_UNVERIFIED'),
            message: ident.login
              ? 'DeepSeek login page — sign in first'
              : (ident.reason === P.ERROR.UNSUPPORTED_PAGE ? 'Unsupported page' : 'Conversation could not be verified'),
          },
        })
        return false
      }
      if (message.action === P.ACTION.DS_STATUS) {
        var d = detect()
        sendResponse({
          success: d.ok,
          payload: d,
          error: d.ok ? null : { code: d.error, message: d.message },
        })
        return false
      }
      if (message.action === P.ACTION.DS_SEND) {
        var packed = P.pickSendPayload(message.payload)
        if (!packed.text) {
          sendResponse({ success: false, error: { code: P.ERROR.INVALID_MESSAGE, message: 'Empty prompt' } })
          return false
        }
        sendPrompt(packed, message.requestId).then(function (result) {
          sendResponse(result)
        }).catch(function () {
          sendResponse({ success: false, error: { code: P.ERROR.INVALID_MESSAGE, message: 'Send failed' } })
        })
        return true
      }
      if (message.action === P.ACTION.DS_STOP) {
        sendResponse(handleStop())
        return false
      }
    } catch {
      try { sendResponse({ success: false, error: { code: P.ERROR.INVALID_MESSAGE, message: 'Adapter error' } }) } catch { /* ignore */ }
    }
    return false
  })
})()
