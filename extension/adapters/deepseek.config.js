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

    assistant: [
      '.ds-markdown',
      '[class*="ds-markdown"]',
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
