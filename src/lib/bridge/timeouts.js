/**
 * Bounded waits. Generous enough for a slow DeepSeek page; never infinite.
 */
export const TIMEOUTS = {
  bridgeConnectMs: 4000,
  identityMs: 6000,
  sendAckMs: 12000,
  /* Must exceed the adapter's thinkAnswerGapMs (30s) so a legitimate
     DeepThink gap is judged by the adapter's structured watchdog, not by
     this cap. It is also re-armed by every correlated pre-content event
     (DeepThink liveness pings), so it only ever fires on true silence. */
  firstResponseMs: 32000,
  completeMs: 185000,
  recoveryMs: 10000,
  scanCacheMs: 800,
  stopAckMs: 4000,
  statusMs: 4000,
  /* Clicking "New chat" + verifying the new identity on the tab. */
  newChatMs: 15000,
}

export function mergeTimeouts(overrides) {
  return { ...TIMEOUTS, ...(overrides || {}) }
}
