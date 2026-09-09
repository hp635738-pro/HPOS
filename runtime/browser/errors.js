import { BROWSER_FAILURE, BROWSER_FAILURE_SET } from './contracts.js'

const SAFE_MESSAGES = Object.freeze({
  [BROWSER_FAILURE.BROWSER_UNAVAILABLE]: 'The supported Chromium browser session is unavailable. Start the dedicated browser session and try again.',
  [BROWSER_FAILURE.AUTH_REQUIRED]: 'DeepSeek requires sign-in. Sign in normally in the dedicated browser session, then send a new message.',
  [BROWSER_FAILURE.CAPTCHA_REQUIRED]: 'DeepSeek requires user verification. Complete it normally in the browser, then send a new message.',
  [BROWSER_FAILURE.UNSUPPORTED_PAGE]: 'Open exactly one supported DeepSeek chat page in the dedicated browser session, then try again.',
  [BROWSER_FAILURE.AMBIGUOUS_SESSION]: 'More than one DeepSeek chat page is open. Keep exactly one chat page open, then try again.',
  [BROWSER_FAILURE.PROVIDER_BUSY]: 'DeepSeek is already generating a response. Wait or stop it before sending another message.',
  [BROWSER_FAILURE.SEND_FAILED]: 'DeepSeek did not confirm the send. The prompt was not sent again.',
  [BROWSER_FAILURE.RESPONSE_NOT_DETECTED]: 'DeepSeek did not produce a final response. The prompt was not sent again.',
  [BROWSER_FAILURE.BROWSER_TIMEOUT]: 'The browser-based DeepSeek task timed out. The prompt was not sent again.',
  [BROWSER_FAILURE.BROWSER_INTERRUPTED]: 'The browser session was interrupted. The prompt was not sent again.',
  [BROWSER_FAILURE.PROVIDER_FAILURE]: 'The browser-based DeepSeek executor failed. The prompt was not sent again.',
})

export class BrowserProviderError extends Error {
  constructor(code, message = null) {
    const safeCode = BROWSER_FAILURE_SET.has(code) ? code : BROWSER_FAILURE.PROVIDER_FAILURE
    super(message || SAFE_MESSAGES[safeCode])
    this.name = 'BrowserProviderError'
    this.code = safeCode
  }
}

export function browserError(code) {
  return new BrowserProviderError(code)
}

export function safeBrowserMessage(code) {
  return SAFE_MESSAGES[BROWSER_FAILURE_SET.has(code) ? code : BROWSER_FAILURE.PROVIDER_FAILURE]
}
