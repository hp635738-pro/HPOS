const attachBtn = document.getElementById('attach')
const dsBtn = document.getElementById('deepseek')
const status = document.getElementById('status')

function setStatus(text, tone) {
  status.textContent = text
  status.dataset.tone = tone || ''
}

function send(action, button, okText, errMap) {
  button.disabled = true
  setStatus('Working…')
  chrome.runtime.sendMessage({ type: 'HPOS_INTERNAL', action }, (res) => {
    button.disabled = false
    if (chrome.runtime.lastError) {
      setStatus(chrome.runtime.lastError.message, 'err')
      return
    }
    if (!res || !res.ok) {
      const code = res && res.error
      setStatus((errMap && errMap[code]) || code || 'Failed', 'err')
      return
    }
    setStatus(okText, 'ok')
  })
}

attachBtn.addEventListener('click', () => {
  send('INJECT', attachBtn, 'HPOS attached. Reload if the chip stays disconnected.', {
    not_hpos: 'This tab is not HPOS. Open HPOS, then attach.',
  })
})

dsBtn.addEventListener('click', () => {
  send('USE_DEEPSEEK', dsBtn, 'DeepSeek tab marked. HPOS should show DeepSeek ready.', {
    UNSUPPORTED_PAGE: 'This tab is not chat.deepseek.com.',
  })
})
