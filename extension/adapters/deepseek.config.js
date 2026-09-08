/**
 * DeepSeek page adapter — selector/config only.
 *
 * Update this file when chat.deepseek.com restyles. Hashed class names
 * (dad65929, fbb737a4, …) are last-resort fallbacks and go stale often;
 * prefer stable attributes (placeholder, aria-label, name, ds-* classes).
 *
 * Inspected against public DeepSeek web chat + community adapters (2026):
 *   hostname: chat.deepseek.com
 *   input:    textarea (name=search / placeholder / spellcheck=false)
 *   send:     button aria-label Send / 发送
 *   answer:   .ds-markdown inside the chat transcript
 *   message:  .ds-message turn rows
 *   thinking: .ds-think-content (DeepThink reasoning — NOT the final answer)
 *   answer wrap: .ds-assistant-message-main-content (final answer wrapper)
 */
(function (root) {
  root.DEEPSEEK_CONFIG = {
    id: 'deepseek',
    hosts: ['chat.deepseek.com'],
    origins: ['https://chat.deepseek.com'],
    loginPaths: ['/sign_in', '/login'],
    maxObserveMs: 180000,
    firstTokenMs: 25000,
    stableMs: 1600,
    deltaMinMs: 80,
    maxChars: 100000,
    /* After clicking "New chat": how long to wait for the identity change,
       and how often to re-check the visible URL/DOM identity. */
    newChatWaitMs: 8000,
    newChatPollMs: 150,
    /* DeepThink: reasoning may go quiet between the think block and the
       final answer. While a think block is known and no answer text exists
       yet, completion is withheld — but if generation ends and no final
       answer appears within this grace window, the response is reported as
       missing instead of completing with thinking text. */
    thinkAnswerGapMs: 30000,
    observeRoot: [
      '.ds-scroll-area',
      'main',
    ],

    input: [
      'textarea[name="search"]',
      'textarea#chat-input',
      'textarea[placeholder*="Message DeepSeek"]',
      'textarea[placeholder*="Message Deepseek"]',
      'textarea[placeholder*="Ask"]',
      'textarea[placeholder*="DeepSeek"]',
      'textarea[placeholder*="发送"]',
      'textarea[spellcheck="false"]',
      'textarea[data-gramm="false"]',
      'textarea.chat-input',
    ],

    send: [
      'button[aria-label="Send"]',
      'button[aria-label="发送"]',
      'button[aria-label*="Send message"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]',
      'button[data-testid="send-button"]',
      'button.send-button',
    ],

    stop: [
      'button[aria-label="Stop"]',
      'button[aria-label="停止"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="停止"]',
    ],

    /* Normal visible "New chat" control in the DeepSeek sidebar. */
    newChat: [
      '[data-testid="new-chat"]',
      'button[aria-label*="New chat"]',
      'button[aria-label*="new chat"]',
      '[role="button"][aria-label*="New chat"]',
      '[role="button"][aria-label*="new chat"]',
      'a[href="/a/chat"]',
    ],

    /* Exact visible labels used as a text fallback for the New chat control. */
    newChatText: ['new chat', '新对话', '开启新对话'],

    assistant: [
      '.ds-markdown',
      '[class*="ds-markdown"]',
    ],

    /* DeepThink reasoning containers — their text is thinking, not answer. */
    thinking: [
      '.ds-think-content',
      '[class*="ds-think-content"]',
    ],

    /* Final-answer wrapper inside an assistant turn (preferred source). */
    answer: [
      '.ds-assistant-message-main-content',
      '[class*="ds-assistant-message-main-content"]',
    ],

    message: [
      '.ds-message',
    ],

    /* Unstable hashed fallbacks — only used if stable selectors miss. */
    transcriptFallback: [
      '.ds-scroll-area',
      'main',
    ],
  }
})(typeof globalThis !== 'undefined' ? globalThis : self)
