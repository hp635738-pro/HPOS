/* HPOS Browser Bridge — service worker. PING + DeepSeek tab routing. */
/* eslint-disable no-undef */
importScripts('protocol.js')
importScripts('diagnostics/logger.js')
var D = (typeof HPOS_DIAG !== 'undefined') ? HPOS_DIAG : { info: function () {}, warn: function () {}, error: function () {}, debug: function () {} }

var P = HPOS_PROTOCOL
var VERSION = P.VERSION
var hposTabs = {}
var preferredDeepSeekTabId = null
var pendingByMessage = {}
var inflight = null

function isDeepSeekUrl(url) {
  if (!url) return false
  try {
    var u = new URL(url)
    return u.hostname === 'chat.deepseek.com'
  } catch {
    return false
  }
}

function rememberHpos(tabId) {
  if (tabId == null) return
  hposTabs[tabId] = Date.now()
}

function fail(requestId, action, code, message) {
  return P.makeResponse(requestId, action, false, null, { code: code, message: message })
}

function handlePing(message) {
  return P.makeResponse(message.requestId, P.ACTION.PONG, true, {
    version: VERSION,
    engine: 'hpos-bridge',
  })
}

async function listDeepSeekTabs() {
  var tabs = await chrome.tabs.query({ url: ['https://chat.deepseek.com/*'] })
  D.info('DEEPSEEK_TAB_DISCOVERED', { count: (tabs || []).length })
  return tabs || []
}

async function pickDeepSeekTab(wantId, opts) {
  var strict = opts && opts.strict
  var tabs = await listDeepSeekTabs()
  if (wantId != null) {
    for (var w = 0; w < (tabs || []).length; w++) {
      if (tabs[w].id === wantId) return tabs[w]
    }
    try {
      var named = await chrome.tabs.get(wantId)
      if (named && isDeepSeekUrl(named.url)) return named
    } catch { /* tab gone or not DeepSeek */ }
    if (strict) return null
  }
  if (strict) return null
  if (!tabs.length) return null
  D.info('DEEPSEEK_TAB_SELECTED', { count: tabs.length, preferred: preferredDeepSeekTabId != null })
  if (preferredDeepSeekTabId != null) {
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].id === preferredDeepSeekTabId) return tabs[i]
    }
  }
  for (var j = 0; j < tabs.length; j++) {
    if (tabs[j].active) return tabs[j]
  }
  return tabs[0]
}

async function probeTabIdentity(tab, requestId) {
  if (!tab || tab.id == null) {
    return { supported: false, missingTab: true }
  }
  if (tab.url && !isDeepSeekUrl(tab.url)) {
    return { supported: false, reason: P.ERROR.UNSUPPORTED_PAGE, tabId: tab.id }
  }
  var res = await askTab(tab.id, {
    channel: P.CHANNEL,
    type: P.TYPE.REQUEST,
    action: P.ACTION.DS_IDENTITY,
    requestId: requestId,
    payload: null,
  })
  var body = (res && res.payload) || {}
  if (!body || typeof body !== 'object') body = {}
  body.tabId = tab.id
  if (!res || res.success === false) {
    var err = readError(res, P.ERROR.DEEPSEEK_CONVERSATION_UNVERIFIED || P.ERROR.UNSUPPORTED_PAGE, 'Conversation could not be verified')
    body.supported = false
    body.reason = body.reason || err.code
    if (err.code === P.ERROR.DISCONNECTED || err.code === P.ERROR.DEEPSEEK_TAB_NOT_READY) {
      body.missingTab = true
    }
    return body
  }
  body.supported = body.supported === true
  return body
}

function askTab(tabId, message) {
  return new Promise(function (resolve) {
    try {
      chrome.tabs.sendMessage(tabId, message, function (response) {
        if (chrome.runtime.lastError) {
          resolve({
            success: false,
            error: {
              code: P.ERROR.DISCONNECTED,
              message: chrome.runtime.lastError.message || 'DeepSeek tab not connected',
            },
          })
          return
        }
        resolve(response || { success: false, error: { code: P.ERROR.UNEXPECTED_RESPONSE, message: 'Empty adapter response' } })
      })
    } catch (err) {
      resolve({
        success: false,
        error: { code: P.ERROR.DISCONNECTED, message: (err && err.message) || 'DeepSeek tab not connected' },
      })
    }
  })
}

function readError(res, fallbackCode, fallbackMessage) {
  var err = res && res.error
  if (typeof err === 'string') {
    return { code: err, message: (res && res.message) || fallbackMessage }
  }
  return {
    code: (err && err.code) || fallbackCode,
    message: (err && err.message) || fallbackMessage,
  }
}

async function handleDsStatus(message) {
  var tab = await pickDeepSeekTab()
  if (!tab || tab.id == null) {
    return fail(message.requestId, message.action, P.ERROR.DEEPSEEK_TAB_UNAVAILABLE, 'DeepSeek tab not connected')
  }
  var res = await askTab(tab.id, {
    channel: P.CHANNEL,
    type: P.TYPE.REQUEST,
    action: P.ACTION.DS_STATUS,
    requestId: message.requestId,
    payload: null,
  })
  if (!res || res.success === false) {
    var err = readError(res, P.ERROR.UNSUPPORTED_PAGE, 'Unsupported page')
    return fail(message.requestId, message.action, err.code, err.message)
  }
  return P.makeResponse(message.requestId, message.action, true, res.payload || res)
}

async function handleDsIdentity(message) {
  var payload = message.payload || {}
  var hint = typeof payload.tabId === 'number' ? payload.tabId : null
  var want = payload.wantIdentity ? String(payload.wantIdentity) : ''
  var scan = payload.scan === true || Boolean(want)

  if (scan) {
    var tabs = await listDeepSeekTabs()
    var identities = []
    for (var i = 0; i < tabs.length; i++) {
      identities.push(await probeTabIdentity(tabs[i], message.requestId))
    }
    if (want) {
      if (hint != null) {
        for (var h = 0; h < identities.length; h++) {
          if (identities[h].tabId === hint && identities[h].supported && identities[h].identity === want) {
            return P.makeResponse(message.requestId, message.action, true, identities[h])
          }
        }
      }
      for (var j = 0; j < identities.length; j++) {
        if (identities[j].supported && identities[j].identity === want) {
          return P.makeResponse(message.requestId, message.action, true, identities[j])
        }
      }
      return fail(
        message.requestId,
        message.action,
        P.ERROR.DEEPSEEK_TAB_NOT_READY,
        'DeepSeek tab is not ready',
      )
    }
    return P.makeResponse(message.requestId, message.action, true, { tabs: identities })
  }

  if (hint != null) {
    var strictTab = await pickDeepSeekTab(hint, { strict: true })
    if (!strictTab || strictTab.id == null) {
      return fail(
        message.requestId,
        message.action,
        P.ERROR.DEEPSEEK_TAB_NOT_READY,
        'DeepSeek tab is not ready',
      )
    }
    var probed = await probeTabIdentity(strictTab, message.requestId)
    if (probed.supported) {
      return P.makeResponse(message.requestId, message.action, true, probed)
    }
    var strictErr = {
      code: probed.reason || P.ERROR.DEEPSEEK_CONVERSATION_UNVERIFIED,
      message: 'Conversation could not be verified',
    }
    return P.makeResponse(message.requestId, message.action, false, probed, strictErr)
  }

  var tab = await pickDeepSeekTab()
  if (!tab || tab.id == null) {
    return fail(
      message.requestId,
      message.action,
      P.ERROR.DEEPSEEK_TAB_NOT_READY || P.ERROR.DEEPSEEK_TAB_UNAVAILABLE,
      'DeepSeek tab is not ready',
    )
  }
  var one = await probeTabIdentity(tab, message.requestId)
  if (one.supported) return P.makeResponse(message.requestId, message.action, true, one)
  return P.makeResponse(message.requestId, message.action, false, one, {
    code: one.reason || P.ERROR.DEEPSEEK_CONVERSATION_UNVERIFIED,
    message: 'Conversation could not be verified',
  })
}

async function handleDsSend(message, hposTabId) {
  var packed = P.pickSendPayload(message.payload)
  if (!packed.text) {
    return fail(message.requestId, message.action, P.ERROR.INVALID_MESSAGE, 'Empty prompt')
  }
  var wantTab = typeof packed.tabId === 'number' ? packed.tabId : null
  var tab = await pickDeepSeekTab(wantTab, { strict: wantTab != null })
  if (!tab || tab.id == null) {
    return fail(
      message.requestId,
      message.action,
      P.ERROR.DEEPSEEK_TAB_NOT_READY || P.ERROR.DEEPSEEK_TAB_UNAVAILABLE,
      'DeepSeek tab is not ready',
    )
  }
  if (packed.messageId) pendingByMessage[packed.messageId] = hposTabId
  var res = await askTab(tab.id, {
    channel: P.CHANNEL,
    type: P.TYPE.REQUEST,
    action: P.ACTION.DS_SEND,
    requestId: message.requestId,
    payload: packed,
  })
  if (!res || res.success === false) {
    if (packed.messageId) delete pendingByMessage[packed.messageId]
    var err = readError(res, P.ERROR.INPUT_NOT_FOUND, 'Could not send to DeepSeek')
    return fail(message.requestId, message.action, err.code, err.message)
  }
  inflight = {
    tabId: tab.id,
    messageId: packed.messageId,
    requestId: message.requestId,
    conversationId: packed.conversationId || '',
    hposTabId: hposTabId,
  }
  return P.makeResponse(message.requestId, message.action, true, {
    accepted: true,
    messageId: packed.messageId,
    requestId: message.requestId,
    tabId: tab.id,
  })
}

async function handleDsStop(message) {
  var packed = P.pickStopPayload ? P.pickStopPayload(message.payload) : { messageId: '' }
  var wantTab = inflight && inflight.tabId != null ? inflight.tabId : null
  var tab = await pickDeepSeekTab(wantTab, { strict: wantTab != null })
  if (!tab || tab.id == null) {
    return fail(message.requestId, message.action, P.ERROR.DEEPSEEK_TAB_UNAVAILABLE, 'DeepSeek tab not connected')
  }
  var res = await askTab(tab.id, {
    channel: P.CHANNEL,
    type: P.TYPE.REQUEST,
    action: P.ACTION.DS_STOP,
    requestId: message.requestId,
    payload: packed,
  })
  if (!res || res.success === false) {
    var err = readError(res, P.ERROR.STOP_NOT_AVAILABLE, 'DeepSeek Stop control not found')
    return fail(message.requestId, message.action, err.code, err.message)
  }
  return P.makeResponse(message.requestId, message.action, true, {
    stopping: true,
    messageId: packed.messageId,
  })
}

function postEventToHpos(tabId, message) {
  try {
    chrome.tabs.sendMessage(tabId, message)
  } catch { /* tab gone */ }
}

function emitGone(code, text) {
  if (!inflight) return
  var payload = {
    type: 'CONNECTOR_EVENT',
    source: 'deepseek',
    event: P.EVENT.ERROR,
    messageId: inflight.messageId,
    requestId: inflight.requestId,
    conversationId: inflight.conversationId || '',
    tabId: inflight.tabId,
    content: '',
    code: code,
    message: text,
  }
  var msg = P.makeEvent(P.ACTION.CONNECTOR_EVENT, payload)
  msg.requestId = inflight.requestId
  msg.from = 'deepseek'
  var target = inflight.hposTabId
  if (inflight.messageId) delete pendingByMessage[inflight.messageId]
  inflight = null
  if (target != null) postEventToHpos(target, msg)
}

function forwardConnectorEvent(message, sender) {
  if (!sender || !sender.tab || !isDeepSeekUrl(sender.tab.url)) return
  var payload = message.payload || {}
  if (!P.isAllowedConnectorEvent(payload.event)) return
  var senderTabId = sender.tab.id
  payload.tabId = senderTabId
  if (inflight) {
    if (inflight.tabId != null && senderTabId !== inflight.tabId) return
    if (inflight.requestId && payload.requestId && payload.requestId !== inflight.requestId) return
    if (inflight.messageId && payload.messageId && payload.messageId !== inflight.messageId) return
    if (inflight.conversationId && payload.conversationId && payload.conversationId !== inflight.conversationId) return
  }
  var target = payload.messageId ? pendingByMessage[payload.messageId] : null
  var ids = []
  if (target != null) ids.push(target)
  else {
    for (var id in hposTabs) ids.push(Number(id))
  }
  ids.forEach(function (tabId) {
    postEventToHpos(tabId, message)
  })
  if (payload.event === P.EVENT.RESPONSE_COMPLETE || payload.event === P.EVENT.ERROR) {
    if (payload.messageId) delete pendingByMessage[payload.messageId]
    inflight = null
  }
}

var DS_ADAPTER_FILES = [
  'protocol.js',
  'adapters/deepseek.config.js',
  'adapters/deepseek.identity.js',
  'adapters/reconcile.js',
  'adapters/deepseek.js',
]

async function injectActiveTab() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  var tab = tabs && tabs[0]
  if (!tab || tab.id == null) return { ok: false, error: 'No active tab' }

  try {
    var results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: function () {
        return document.documentElement
          && document.documentElement.getAttribute('data-hpos-app') === 'hpos'
      },
    })
    var isHpos = (results || []).some(function (r) { return r && r.result === true })
    if (!isHpos) return { ok: false, error: 'not_hpos' }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['protocol.js', 'content.js'],
    })
    rememberHpos(tab.id)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : 'Cannot access this tab' }
  }
}

async function useActiveAsDeepSeek() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  var tab = tabs && tabs[0]
  if (!tab || tab.id == null) return { ok: false, error: 'No active tab' }
  if (!isDeepSeekUrl(tab.url)) {
    return { ok: false, error: 'UNSUPPORTED_PAGE' }
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      files: DS_ADAPTER_FILES,
    })
    preferredDeepSeekTabId = tab.id
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : 'Cannot attach DeepSeek tab' }
  }
}

chrome.tabs.onRemoved.addListener(function (tabId) {
  try {
    delete hposTabs[tabId]
    if (preferredDeepSeekTabId === tabId) preferredDeepSeekTabId = null
    if (inflight && inflight.tabId === tabId) {
      emitGone(P.ERROR.PAGE_CHANGED, 'DeepSeek tab closed')
    }
  } catch { /* never crash the SW */ }
})

chrome.tabs.onUpdated.addListener(function (tabId, info) {
  try {
    if (!inflight || inflight.tabId !== tabId) return
    if (info.url && !isDeepSeekUrl(info.url)) {
      emitGone(P.ERROR.PAGE_CHANGED, 'Page changed')
    }
  } catch { /* never crash the SW */ }
})

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  try {
    if (message && message.type === 'HPOS_INTERNAL' && message.action === 'INJECT') {
      injectActiveTab().then(sendResponse).catch(function (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : 'Inject failed' })
      })
      return true
    }
    if (message && message.type === 'HPOS_INTERNAL' && message.action === 'USE_DEEPSEEK') {
      useActiveAsDeepSeek().then(sendResponse).catch(function (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : 'Attach failed' })
      })
      return true
    }

    if (message && message.type === P.TYPE.EVENT && message.action === P.ACTION.CONNECTOR_EVENT) {
      forwardConnectorEvent(message, sender)
      return false
    }

    if (!P.isWellFormedRequest(message)) {
      sendResponse(fail(
        P.isRequestId(message && message.requestId) ? message.requestId : 'invalid-msg',
        'ERROR',
        P.ERROR.INVALID_MESSAGE,
        'Invalid message',
      ))
      return false
    }

    if (!P.isAllowedRequestAction(message.action)) {
      sendResponse(fail(message.requestId, message.action, P.ERROR.UNKNOWN_ACTION, 'Unsupported action: ' + message.action))
      return false
    }

    if (message.action === P.ACTION.PING) {
      if (sender && sender.tab) rememberHpos(sender.tab.id)
      sendResponse(handlePing(message))
      return false
    }

    if (message.from !== 'hpos' || !sender || !sender.tab) {
      sendResponse(fail(message.requestId, message.action, P.ERROR.INVALID_MESSAGE, 'Bridge requests must come from HPOS'))
      return false
    }

    rememberHpos(sender.tab.id)

    if (message.action === P.ACTION.DS_STATUS) {
      handleDsStatus(message).then(sendResponse).catch(function () {
        sendResponse(fail(message.requestId, message.action, P.ERROR.DEEPSEEK_TAB_UNAVAILABLE, 'DeepSeek tab not connected'))
      })
      return true
    }

    if (message.action === P.ACTION.DS_SEND) {
      handleDsSend(message, sender.tab.id).then(sendResponse).catch(function () {
        sendResponse(fail(message.requestId, message.action, P.ERROR.DEEPSEEK_TAB_UNAVAILABLE, 'DeepSeek tab not connected'))
      })
      return true
    }

    if (message.action === P.ACTION.DS_STOP) {
      handleDsStop(message).then(sendResponse).catch(function () {
        sendResponse(fail(message.requestId, message.action, P.ERROR.STOP_NOT_AVAILABLE, 'DeepSeek Stop control not found'))
      })
      return true
    }

    if (message.action === P.ACTION.DS_IDENTITY) {
      handleDsIdentity(message).then(sendResponse).catch(function () {
        sendResponse(fail(
          message.requestId,
          message.action,
          P.ERROR.DEEPSEEK_TAB_NOT_READY || P.ERROR.DEEPSEEK_TAB_UNAVAILABLE,
          'DeepSeek tab is not ready',
        ))
      })
      return true
    }

    sendResponse(fail(message.requestId, message.action, P.ERROR.UNKNOWN_ACTION, 'Unsupported action: ' + message.action))
  } catch {
    sendResponse(fail(
      P.isRequestId(message && message.requestId) ? message.requestId : 'invalid-msg',
      'ERROR',
      P.ERROR.INVALID_MESSAGE,
      'Unexpected error',
    ))
  }
  return false
})
