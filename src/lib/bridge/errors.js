/**
 * User-facing copy for structured bridge / DeepSeek errors.
 * No stack traces, raw ids, selectors, or protocol payloads.
 */
import { ERROR } from './protocol.js'

export const USER_COPY = {
  [ERROR.BRIDGE_DISCONNECTED]: 'DeepSeek disconnected. Reconnect to continue.',
  [ERROR.BRIDGE_TIMEOUT]: 'Browser bridge timed out. Reconnect to continue.',
  [ERROR.BRIDGE_VERSION_MISMATCH]: 'Extension update required.',
  [ERROR.DEEPSEEK_TAB_NOT_READY]: 'The bound DeepSeek conversation is not open. Open the matching conversation and retry.',
  [ERROR.DEEPSEEK_IDENTITY_TIMEOUT]: 'Could not confirm the DeepSeek conversation in time. No message was sent.',
  [ERROR.DEEPSEEK_CONVERSATION_MISMATCH]: 'DeepSeek is on a different conversation. No message was sent.',
  [ERROR.DEEPSEEK_CONVERSATION_UNVERIFIED]: 'DeepSeek could not verify the current conversation. No message was sent.',
  [ERROR.DEEPSEEK_SEND_TIMEOUT]: 'DeepSeek did not confirm the send. The message was not resent.',
  [ERROR.DEEPSEEK_RESPONSE_TIMEOUT]: 'DeepSeek did not finish responding. The message was not resent.',
  [ERROR.REQUEST_INTERRUPTED]: 'Connection dropped. Response may be incomplete.',
  [ERROR.REQUEST_ALREADY_COMPLETE]: 'This response already finished.',
  [ERROR.STALE_EVENT_REJECTED]: 'Ignored a late DeepSeek update.',
  [ERROR.STORAGE_CORRUPT]: 'Saved chats could not be read. Starting fresh.',
  [ERROR.STORAGE_MIGRATION_FAILED]: 'Saved chats could not be upgraded.',
  [ERROR.RECOVERY_TIMEOUT]: 'Could not find the matching DeepSeek tab in time.',
  [ERROR.BUSY]: 'A response is still generating',
  [ERROR.UNSUPPORTED_PAGE]: 'This DeepSeek page cannot be used. Open a signed-in chat and try again.',
  [ERROR.DISCONNECTED]: 'DeepSeek disconnected. Reconnect to continue.',
  [ERROR.TIMEOUT]: 'Browser bridge timed out. Reconnect to continue.',
  [ERROR.CONNECTOR_TIMEOUT]: 'DeepSeek did not finish responding. The message was not resent.',
}

export function userMessage(code, fallback) {
  return USER_COPY[code] || fallback || 'Something went wrong. Try again.'
}
