// HPOS workspace — main application script

import { formatTime } from './utils.js'

function init() {
  const el = document.getElementById('timestamp')
  if (el) {
    el.textContent = 'Page loaded at ' + formatTime(new Date())
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
