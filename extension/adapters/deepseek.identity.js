/**
 * Keep in sync with src/lib/bridge/deepseekIdentity.js
 * Classic script: conversation identity from the visible DeepSeek URL/DOM.
 * Never cookies, tokens, or credential stores.
 */
(function (root) {
  var HOST = 'chat.deepseek.com'
  var ID = /^[A-Za-z0-9._:-]{8,80}$/
  var LOGIN = /^\/(sign_in|login)(\/|$)/

  function stripSlash(path) {
    var p = String(path || '/') || '/'
    if (p.length > 1 && p.charAt(p.length - 1) === '/') return p.slice(0, -1)
    return p || '/'
  }

  function parseDeepSeekIdentity(input) {
    var raw = typeof input === 'string' ? { href: input } : (input || {})
    var hostname = String(raw.hostname || '')
    var pathname = String(raw.pathname || '')
    var href = String(raw.href || '')

    if (!hostname && href) {
      try {
        var u = new URL(href)
        hostname = u.hostname
        pathname = pathname || u.pathname
        href = u.href
      } catch {
        return { supported: false, reason: 'UNVERIFIED' }
      }
    }

    if (hostname !== HOST) {
      return { supported: false, reason: 'UNSUPPORTED_PAGE' }
    }

    var path = stripSlash(pathname || '/')
    if (LOGIN.test(path)) {
      return { supported: false, reason: 'UNSUPPORTED_PAGE', login: true }
    }

    var m = path.match(/^\/a\/chat\/s\/([A-Za-z0-9._:-]{8,80})$/)
    if (m && ID.test(m[1])) {
      return {
        supported: true,
        identity: m[1],
        url: 'https://' + HOST + '/a/chat/s/' + m[1],
        confidence: 'high',
        source: 'url',
      }
    }

    m = path.match(/^\/chat\/s\/([A-Za-z0-9._:-]{8,80})$/)
    if (m && ID.test(m[1])) {
      return {
        supported: true,
        identity: m[1],
        url: 'https://' + HOST + '/chat/s/' + m[1],
        confidence: 'high',
        source: 'url',
      }
    }

    m = path.match(/^\/chat\/([A-Za-z0-9._:-]{8,80})$/)
    if (m && m[1] !== 's' && ID.test(m[1])) {
      return {
        supported: true,
        identity: m[1],
        url: 'https://' + HOST + '/chat/' + m[1],
        confidence: 'high',
        source: 'url',
      }
    }

    try {
      var q = new URL(href || ('https://' + HOST + path))
      var qid = q.searchParams.get('chatId')
        || q.searchParams.get('conversationId')
        || q.searchParams.get('sessionId')
      if (qid && ID.test(qid)) {
        return {
          supported: true,
          identity: qid,
          url: 'https://' + HOST + path,
          confidence: 'medium',
          source: 'query',
        }
      }
    } catch { /* ignore */ }

    if (path === '/' || path === '/a' || path === '/a/chat') {
      return {
        supported: true,
        identity: 'https://' + HOST + '/',
        url: 'https://' + HOST + '/',
        confidence: 'low',
        source: 'url',
      }
    }

    return { supported: false, reason: 'UNVERIFIED' }
  }

  function identityFromDom(doc) {
    var d = doc || (typeof document !== 'undefined' ? document : null)
    if (!d) return null
    try {
      var canon = d.querySelector('link[rel="canonical"]')
      if (canon && canon.href) {
        var parsed = parseDeepSeekIdentity(canon.href)
        if (parsed.supported && parsed.confidence === 'high') return parsed
      }
    } catch { /* ignore */ }
    try {
      var attr = (d.documentElement && d.documentElement.getAttribute('data-conversation-id'))
        || (d.body && d.body.getAttribute('data-conversation-id'))
      if (attr && ID.test(attr)) {
        return {
          supported: true,
          identity: attr,
          url: typeof location !== 'undefined'
            ? (location.origin + stripSlash(location.pathname || '/'))
            : ('https://' + HOST + '/'),
          confidence: 'medium',
          source: 'dom',
        }
      }
    } catch { /* ignore */ }
    return null
  }

  function getCurrentConversationIdentity() {
    if (typeof location === 'undefined') {
      return { supported: false, reason: 'UNVERIFIED' }
    }
    var fromUrl = parseDeepSeekIdentity({
      href: location.href,
      hostname: location.hostname,
      pathname: location.pathname,
    })
    if (fromUrl.supported && fromUrl.confidence === 'high') return fromUrl
    var fromDom = identityFromDom()
    if (fromDom && fromDom.supported && fromDom.confidence === 'high') return fromDom
    if (fromUrl.supported) return fromUrl
    if (fromDom && fromDom.supported) return fromDom
    return fromUrl.reason ? fromUrl : { supported: false, reason: 'UNVERIFIED' }
  }

  root.HPOS_DS_IDENTITY = {
    parse: parseDeepSeekIdentity,
    fromDom: identityFromDom,
    getCurrent: getCurrentConversationIdentity,
  }
})(typeof globalThis !== 'undefined' ? globalThis : self)
