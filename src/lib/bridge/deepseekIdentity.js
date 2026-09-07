/**
 * Parse a visible DeepSeek chat URL into a conversation identity.
 *
 * Keep in sync with `extension/adapters/deepseek.identity.js`.
 * No cookies, tokens, or DOM here — URL/path only. The adapter may also
 * pass a canonical href from the page.
 */

const HOST = 'chat.deepseek.com'
const ID = /^[A-Za-z0-9._:-]{8,80}$/
const LOGIN = /^\/(sign_in|login)(\/|$)/

function stripSlash(path) {
  const p = String(path || '/') || '/'
  if (p.length > 1 && p.endsWith('/')) return p.slice(0, -1)
  return p || '/'
}

export function parseDeepSeekIdentity(input) {
  const raw = typeof input === 'string' ? { href: input } : (input || {})
  let hostname = String(raw.hostname || '')
  let pathname = String(raw.pathname || '')
  let href = String(raw.href || '')

  if (!hostname && href) {
    try {
      const u = new URL(href)
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

  const path = stripSlash(pathname || '/')
  if (LOGIN.test(path)) {
    return { supported: false, reason: 'UNSUPPORTED_PAGE', login: true }
  }

  let m = path.match(/^\/a\/chat\/s\/([A-Za-z0-9._:-]{8,80})$/)
  if (m && ID.test(m[1])) {
    return {
      supported: true,
      identity: m[1],
      url: `https://${HOST}/a/chat/s/${m[1]}`,
      confidence: 'high',
      source: 'url',
    }
  }

  m = path.match(/^\/chat\/s\/([A-Za-z0-9._:-]{8,80})$/)
  if (m && ID.test(m[1])) {
    return {
      supported: true,
      identity: m[1],
      url: `https://${HOST}/chat/s/${m[1]}`,
      confidence: 'high',
      source: 'url',
    }
  }

  m = path.match(/^\/chat\/([A-Za-z0-9._:-]{8,80})$/)
  if (m && m[1] !== 's' && ID.test(m[1])) {
    return {
      supported: true,
      identity: m[1],
      url: `https://${HOST}/chat/${m[1]}`,
      confidence: 'high',
      source: 'url',
    }
  }

  try {
    const u = new URL(href || `https://${HOST}${path}`)
    const qid = u.searchParams.get('chatId')
      || u.searchParams.get('conversationId')
      || u.searchParams.get('sessionId')
    if (qid && ID.test(qid)) {
      return {
        supported: true,
        identity: qid,
        url: `https://${HOST}${path}`,
        confidence: 'medium',
        source: 'query',
      }
    }
  } catch { /* ignore */ }

  if (path === '/' || path === '/a' || path === '/a/chat') {
    return {
      supported: true,
      identity: `https://${HOST}/`,
      url: `https://${HOST}/`,
      confidence: 'low',
      source: 'url',
    }
  }

  return { supported: false, reason: 'UNVERIFIED' }
}
