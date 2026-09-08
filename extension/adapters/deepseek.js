/**
 * DeepSeek DOM adapter. Isolated world on chat.deepseek.com only.
 * Reads visible composer + assistant markdown. Never cookies, tokens, or storage.
 *
 * Response model (internal):
 *
 *   { reasoningText, answerText, phase: THINKING | ANSWERING | COMPLETE }
 *
 * A DeepSeek assistant turn (`.ds-message`) can contain a DeepThink
 * reasoning block (`.ds-think-content`) and a final-answer wrapper
 * (`.ds-assistant-message-main-content`) holding `.ds-markdown`. Only the
 * final answer streams to HPOS — thinking text never becomes a delta and a
 * thinking mutation never triggers RESPONSE_COMPLETE.
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

  function queryAll(scope, list) {
    var out = []
    var seen = []
    for (var i = 0; i < list.length; i++) {
      var found
      try {
        found = scope.querySelectorAll(list[i])
      } catch {
        found = []
      }
      if (!found) continue
      for (var j = 0; j < found.length; j++) {
        if (seen.indexOf(found[j]) === -1) {
          seen.push(found[j])
          out.push(found[j])
        }
      }
    }
    return out
  }

  function matchesAny(el, list) {
    if (!el || !el.matches) return false
    for (var i = 0; i < list.length; i++) {
      try {
        if (el.matches(list[i])) return true
      } catch { /* ignore */ }
    }
    return false
  }

  function listContentNodes() {
    var content = Array.isArray(C.thinking) && C.thinking.length
      ? C.assistant.concat(C.thinking)
      : C.assistant
    return queryAll(document, content)
  }

  /** The `.ds-message` turn row that owns a content node (fallback: node). */
  function rowOf(node) {
    var list = C.message || []
    if (node && node.closest) {
      for (var i = 0; i < list.length; i++) {
        try {
          var row = node.closest(list[i])
          if (row) return row
        } catch { /* ignore */ }
      }
    }
    return node
  }

  function listRows() {
    var nodes = listContentNodes()
    var rows = []
    var seen = []
    for (var i = 0; i < nodes.length; i++) {
      var row = rowOf(nodes[i])
      if (row && seen.indexOf(row) === -1) {
        seen.push(row)
        rows.push(row)
      }
    }
    return rows
  }

  function nodeText(el) {
    if (!el) return ''
    var text = (el.innerText || el.textContent || '').trim()
    if (text.length > C.maxChars) text = text.slice(0, C.maxChars)
    return text
  }

  /** Thinking text is also read from collapsed blocks (innerText may be ''). */
  function thinkText(el) {
    var text = nodeText(el)
    if (!text && el) {
      text = String(el.textContent || '').trim()
      if (text.length > C.maxChars) text = text.slice(0, C.maxChars)
    }
    return text
  }

  function insideThinking(node) {
    if (matchesAny(node, C.thinking || [])) return true
    if (node && node.closest) {
      var list = C.thinking || []
      for (var i = 0; i < list.length; i++) {
        try {
          if (node.closest(list[i])) return true
        } catch { /* ignore */ }
      }
    }
    return false
  }

  function joinTexts(nodes, read) {
    var parts = []
    for (var i = 0; i < nodes.length; i++) {
      var t = read(nodes[i])
      if (t) parts.push(t)
    }
    var text = parts.join('\n\n')
    if (text.length > C.maxChars) text = text.slice(0, C.maxChars)
    return text
  }

  /**
   * Split a turn row into reasoning vs final answer.
   * Never reads cookies/storage — visible DOM text only.
   */
  function extractRow(row) {
    var empty = { answer: '', thinking: '', hasThinking: false }
    if (!row) return empty
    var thinkList = C.thinking || []
    var thinkNodes = []
    if (thinkList.length && matchesAny(row, thinkList)) thinkNodes.push(row)
    if (thinkList.length) {
      var scoped = queryAll(row, thinkList)
      for (var t = 0; t < scoped.length; t++) {
        if (thinkNodes.indexOf(scoped[t]) === -1) thinkNodes.push(scoped[t])
      }
    }
    var thinking = joinTexts(thinkNodes, thinkText)

    var answerNodes = []
    var wrapList = C.answer || []
    if (wrapList.length) {
      if (matchesAny(row, wrapList)) answerNodes.push(row)
      var wraps = queryAll(row, wrapList)
      for (var w = 0; w < wraps.length; w++) {
        if (answerNodes.indexOf(wraps[w]) === -1) answerNodes.push(wraps[w])
      }
    }
    if (!answerNodes.length) {
      var md = queryAll(row, C.assistant)
      if (matchesAny(row, C.assistant)) md.unshift(row)
      for (var m = 0; m < md.length; m++) {
        if (insideThinking(md[m])) continue
        if (answerNodes.indexOf(md[m]) === -1) answerNodes.push(md[m])
      }
    }
    var answer = joinTexts(answerNodes, nodeText)
    return { answer: answer, thinking: thinking, hasThinking: thinkNodes.length > 0 }
  }

  /** Combined signature for change detection only (never emitted). */
  function rowText(row) {
    var t = extractRow(row)
    return (t.thinking || '') + '\n\n' + (t.answer || '')
  }

  function pinRow(beforeRows, beforeText) {
    var now = listRows()
    for (var i = 0; i < now.length; i++) {
      if (beforeRows.indexOf(now[i]) === -1) return now[i]
    }
    var last = now.length ? now[now.length - 1] : null
    if (last) {
      var t = rowText(last)
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

  /**
   * The normal visible sidebar "New chat" control.
   * DeepSeek navigates it via ordinary link/button — we never build URLs,
   * open hidden tabs, or call DeepSeek APIs.
   */
  function clickRoot(el) {
    if (el && el.closest) {
      var wrapped = null
      try {
        wrapped = el.closest('a') || el.closest('button') || el.closest('[role="button"]')
      } catch {
        wrapped = null
      }
      if (wrapped) return wrapped
    }
    return el
  }

  function labelHit(el) {
    var labels = C.newChatText || []
    if (!labels.length) return false
    var raw = (el.innerText || el.textContent || '')
    var txt = String(raw).replace(/\s+/g, ' ').trim().toLowerCase()
    if (!txt || txt.length > 24) return false
    for (var i = 0; i < labels.length; i++) {
      if (txt === String(labels[i]).toLowerCase()) return true
    }
    return false
  }

  function findNewChatControl() {
    var list = C.newChat || []
    for (var i = 0; i < list.length; i++) {
      try {
        var nodes = document.querySelectorAll(list[i])
        for (var j = 0; j < nodes.length; j++) {
          if (visible(nodes[j]) && !isDisabled(nodes[j])) return clickRoot(nodes[j])
        }
      } catch { /* ignore */ }
    }
    var labels = C.newChatText || []
    if (!labels.length) return null
    var groups = ['a,button,[role="button"]', 'body *']
    for (var g = 0; g < groups.length; g++) {
      var cand
      try {
        cand = document.querySelectorAll(groups[g])
      } catch {
        cand = null
      }
      if (!cand) continue
      var best = null
      for (var c = 0; c < cand.length; c++) {
        var el = cand[c]
        if (!visible(el)) continue
        if (!labelHit(el)) continue
        if (best && best.contains && best.contains(el)) continue
        best = el
      }
      if (best) return clickRoot(best)
    }
    return null
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

  function isHomeIdentity(identity) {
    return Boolean(
      identity &&
      identity.supported === true &&
      identity.confidence === 'low' &&
      identity.source === 'url' &&
      typeof identity.identity === 'string' &&
      identity.identity.indexOf('https://') === 0,
    )
  }

  function unsupportedPageError(message) {
    return {
      success: false,
      error: {
        code: P.ERROR.UNSUPPORTED_PAGE,
        message: message || 'Unsupported page',
      },
    }
  }

  function newChatError(message) {
    return {
      success: false,
      error: {
        code: P.ERROR.DEEPSEEK_NEW_CONVERSATION_UNVERIFIED || 'DEEPSEEK_NEW_CONVERSATION_UNVERIFIED',
        message: message || 'New conversation could not be verified',
      },
    }
  }

  /**
   * createNewConversation — move the visible DeepSeek tab to a fresh chat
   * through its normal "New chat" UI, then verify the resulting identity.
   *
   * Never invents an id: DeepSeek assigns a thread id only after the first
   * message, so a verified "new" state is a different thread id OR the
   * low-confidence home/new-chat state. Anything else is a structured error
   * and the caller must not send.
   */
  async function createNewConversation(payload) {
    if (!pageValid()) {
      return unsupportedPageError(isLogin() ? 'DeepSeek login page — sign in first' : 'Unsupported page')
    }
    if (busy()) {
      return { success: false, error: { code: P.ERROR.BUSY, message: 'A response is still generating' } }
    }

    var before = getCurrentConversationIdentity()
    if (!before || before.supported !== true || !before.identity) {
      return newChatError('Current DeepSeek conversation could not be verified')
    }
    var wanted = payload && typeof payload.previousIdentity === 'string' ? payload.previousIdentity : ''
    if (wanted && wanted !== before.identity) {
      return newChatError('DeepSeek tab state changed')
    }

    var control = findNewChatControl()
    if (!control) {
      return newChatError('DeepSeek "New chat" control not found')
    }
    try {
      control.click()
    } catch {
      return newChatError('DeepSeek "New chat" control could not be used')
    }

    var beforeHome = isHomeIdentity(before)
    var deadline = Date.now() + (C.newChatWaitMs || 8000)
    var after = before
    while (Date.now() < deadline) {
      await sleep(C.newChatPollMs || 150)
      if (!pageValid()) {
        return unsupportedPageError(isLogin() ? 'DeepSeek login page — sign in first' : 'Unsupported page')
      }
      after = getCurrentConversationIdentity()
      if (after && after.supported === true && after.identity) {
        var afterHome = isHomeIdentity(after)
        if (after.identity !== before.identity) {
          return {
            success: true,
            payload: {
              supported: true,
              identity: after.identity,
              url: after.url || null,
              confidence: after.confidence || null,
              source: after.source || 'url',
              newConversation: true,
              previousIdentity: before.identity,
            },
          }
        }
        if (beforeHome && afterHome) {
          return {
            success: true,
            payload: {
              supported: true,
              identity: after.identity,
              url: after.url || null,
              confidence: after.confidence || null,
              source: after.source || 'url',
              newConversation: true,
              previousIdentity: before.identity,
            },
          }
        }
      }
    }
    return newChatError('New conversation identity could not be verified')
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
      ready: Boolean(input),
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

  function startObserve(ids, beforeRows, beforeText) {
    stopSession()
    var finished = false
    var answerLast = ''
    var thinkingLast = ''
    var thinkingSeen = false
    var answerSeen = false
    var sawActivity = false
    var lastChangeAt = 0
    var lastEmitAt = 0
    var pinned = null

    function current() {
      return pinned ? extractRow(pinned) : { answer: '', thinking: '', hasThinking: false }
    }

    function finish(event, code, message) {
      if (finished) return
      finished = true
      var text = answerLast || current().answer || ''
      var ref = session
      stopSession()
      if (event === 'RESPONSE_COMPLETE') {
        emit('RESPONSE_COMPLETE', ref, text)
      } else {
        emit('ERROR', ref, text, { code: code, message: message })
      }
    }

    function thinkingGapExceeded(now) {
      return thinkingSeen && !answerSeen
        && lastChangeAt > 0
        && !generating() && !findStop()
        && now - lastChangeAt >= (C.thinkAnswerGapMs || 30000)
    }

    function onTick() {
      if (finished) return
      if (!pageValid()) return finish('ERROR', P.ERROR.PAGE_CHANGED, 'Page changed')
      if (!document.body) return finish('ERROR', P.ERROR.PAGE_CHANGED, 'Page changed')

      if (!pinned) pinned = pinRow(beforeRows, beforeText)
      var t = current()
      var next = R.reconcileAssistantText(answerLast, t.answer)
      var thinkNext = t.thinking
      var changed = (next !== answerLast) || (thinkNext !== thinkingLast)

      if (changed) {
        sawActivity = true
        lastChangeAt = Date.now()
        if (session && session.firstTimer) {
          clearTimeout(session.firstTimer)
          session.firstTimer = null
        }
        if (thinkNext) thinkingSeen = true
        if (thinkNext !== thinkingLast) thinkingLast = thinkNext
        if (next !== answerLast) {
          answerLast = next
          if (next) answerSeen = true
          if (next && Date.now() - lastEmitAt >= C.deltaMinMs) {
            lastEmitAt = Date.now()
            emit('RESPONSE_DELTA', session, answerLast)
          }
        }
      }

      if (!sawActivity && !findInput() && !generating()) {
        return finish('ERROR', P.ERROR.COMPOSER_GONE, 'Composer disappeared')
      }

      if (session && session.stableTimer) clearTimeout(session.stableTimer)
      session.stableTimer = setTimeout(function onStable() {
        if (finished || !session) return
        var nowT = current()
        var nowText = R.reconcileAssistantText(answerLast, nowT.answer)
        if (nowText && nowText !== answerLast) {
          answerLast = nowText
          answerSeen = true
          sawActivity = true
          lastChangeAt = Date.now()
          lastEmitAt = Date.now()
          emit('RESPONSE_DELTA', session, answerLast)
        }
        if (nowT.thinking) thinkingSeen = true
        if (nowT.thinking !== thinkingLast) {
          thinkingLast = nowT.thinking
          lastChangeAt = Date.now()
        }
        var now = Date.now()
        if (answerSeen && R.shouldComplete({
          currentText: answerLast,
          lastEmitted: answerLast,
          generating: generating(),
          stopVisible: Boolean(findStop()),
          lastChangeAt: lastChangeAt,
          now: now,
          stableMs: C.stableMs,
        })) {
          finish('RESPONSE_COMPLETE')
          return
        }
        if (thinkingGapExceeded(now)) {
          finish('ERROR', P.ERROR.RESPONSE_NOT_DETECTED, 'Thinking finished without a final answer')
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
        if (!sawActivity) finish('ERROR', P.ERROR.RESPONSE_NOT_DETECTED, 'Response not detected')
      }, C.firstTokenMs),
      limitTimer: setTimeout(function () {
        var t = current()
        var stillChanging = t.answer !== answerLast || t.thinking !== thinkingLast
        if (generating() || stillChanging) {
          finish('ERROR', P.ERROR.CONNECTOR_TIMEOUT, 'Connector timeout')
        } else if (answerSeen && answerLast) {
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

    var beforeRows = listRows()
    var beforeRow = beforeRows.length ? beforeRows[beforeRows.length - 1] : null
    var beforeText = beforeRow ? rowText(beforeRow) : ''

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
      beforeRows,
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
      if (message.action === P.ACTION.DS_NEW_CHAT) {
        var packed = P.pickNewChatPayload ? P.pickNewChatPayload(message.payload) : (message.payload || {})
        createNewConversation(packed).then(function (result) {
          sendResponse(result)
        }).catch(function () {
          sendResponse(newChatError())
        })
        return true
      }
      if (message.action === P.ACTION.DS_SEND) {
        var packed2 = P.pickSendPayload(message.payload)
        if (!packed2.text) {
          sendResponse({ success: false, error: { code: P.ERROR.INVALID_MESSAGE, message: 'Empty prompt' } })
          return false
        }
        sendPrompt(packed2, message.requestId).then(function (result) {
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
