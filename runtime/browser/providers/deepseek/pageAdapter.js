/**
 * Fixed DeepSeek visible-page adapter.
 *
 * The adapter reads only URL, element presence, composer value and visible
 * assistant text. It never reads browser storage, request headers, account
 * fields, password values, CAPTCHA contents or session material. All selectors
 * and gestures are source-controlled; task input cannot alter them.
 */

import { BROWSER_TASK_LIMITS } from '../../contracts.js'
import { DEEPSEEK_WEB } from './config.js'

function selectorList(values) {
  return values.join(',')
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    try {
      const group = page.locator(selector)
      const count = Math.min(await group.count(), 20)
      for (let i = 0; i < count; i += 1) {
        const item = group.nth(i)
        if (await item.isVisible()) return item
      }
    } catch {
      /* A stale selector is skipped; the provider decides the final state. */
    }
  }
  return null
}

async function visibleText(locator) {
  if (!locator) return ''
  try {
    if (!(await locator.isVisible())) return ''
    const text = String(await locator.innerText()).trim()
    return text.slice(0, BROWSER_TASK_LIMITS.MAX_RESPONSE_CHARS)
  } catch {
    return ''
  }
}

/** DeepThink reasoning is visible DOM, but it is not the assistant's final
 * answer and must never be emitted as Chat output. This fixed predicate reads
 * only element ancestry; it does not inspect page state or execute task input. */
async function insideThinking(locator) {
  if (!locator || typeof locator.evaluate !== 'function') return false
  for (const selector of DEEPSEEK_WEB.thinking) {
    try {
      const found = await locator.evaluate((node, fixedSelector) => Boolean(
        node.matches?.(fixedSelector) || node.closest?.(fixedSelector),
      ), selector)
      if (found) return true
    } catch { /* detached or selector no longer matches */ }
  }
  return false
}

export function createDeepSeekPageAdapter(page) {
  if (!page || typeof page.locator !== 'function' || typeof page.url !== 'function') {
    throw new TypeError('DeepSeek page adapter requires a Playwright page')
  }

  async function flags() {
    const [input, stop, auth, captcha] = await Promise.all([
      firstVisible(page, DEEPSEEK_WEB.input),
      firstVisible(page, DEEPSEEK_WEB.stop),
      firstVisible(page, DEEPSEEK_WEB.authRequired),
      firstVisible(page, DEEPSEEK_WEB.captcha),
    ])
    return {
      composerReady: Boolean(input),
      busy: Boolean(stop),
      authRequired: Boolean(auth),
      captchaRequired: Boolean(captcha),
    }
  }

  async function snapshot() {
    let turnCount = 0
    let answerCount = 0
    let answer = ''
    try {
      const turns = page.locator(selectorList(DEEPSEEK_WEB.message))
      turnCount = Math.min(await turns.count(), DEEPSEEK_WEB.maxTurns)
    } catch { /* transcript container may have changed */ }

    /* Prefer the dedicated final-answer wrapper. Counting answer containers,
       rather than all chat rows, prevents a newly-added user row from being
       mistaken for a new assistant response. */
    try {
      const preferred = page.locator(selectorList(DEEPSEEK_WEB.answer))
      answerCount = Math.min(await preferred.count(), DEEPSEEK_WEB.maxTurns)
      if (answerCount > 0) answer = await visibleText(preferred.nth(answerCount - 1))
    } catch { /* use markdown fallback below */ }

    if (!answer) {
      try {
        const all = page.locator(selectorList(DEEPSEEK_WEB.assistant))
        const count = Math.min(await all.count(), DEEPSEEK_WEB.maxTurns)
        const finalNodes = []
        for (let i = 0; i < count; i += 1) {
          const candidate = all.nth(i)
          if (!(await insideThinking(candidate))) finalNodes.push(candidate)
        }
        answerCount = finalNodes.length
        if (answerCount > 0) answer = await visibleText(finalNodes[answerCount - 1])
        if (turnCount === 0) turnCount = answerCount
      } catch { /* no readable final answer yet */ }
    }

    const stop = await firstVisible(page, DEEPSEEK_WEB.stop)
    return { turnCount, answerCount, answer, busy: Boolean(stop) }
  }

  async function submitOnce(prompt) {
    const input = await firstVisible(page, DEEPSEEK_WEB.input)
    if (!input) return { submitted: false, reason: 'composer-unavailable' }
    const send = await firstVisible(page, DEEPSEEK_WEB.send)
    if (!send) return { submitted: false, reason: 'send-unavailable' }

    /* Exactly one ordinary website gesture. There is intentionally no Enter
       fallback after this click: an uncertain acknowledgement is never resent. */
    await input.fill(prompt)
    await send.click()
    return { submitted: true }
  }

  async function submissionObserved(before) {
    try {
      const input = await firstVisible(page, DEEPSEEK_WEB.input)
      if (input && String(await input.inputValue()) === '') return true
    } catch { /* continue with visible generation evidence */ }
    const current = await snapshot()
    return current.busy
      || current.answerCount > before.answerCount
      || current.turnCount > before.turnCount
      || Boolean(current.answer && current.answer !== before.answer)
  }

  async function stopOnce() {
    const stop = await firstVisible(page, DEEPSEEK_WEB.stop)
    if (!stop) return false
    try {
      await stop.click()
      return true
    } catch {
      return false
    }
  }

  return {
    currentUrl: () => page.url(),
    flags,
    snapshot,
    submitOnce,
    submissionObserved,
    stopOnce,
  }
}
