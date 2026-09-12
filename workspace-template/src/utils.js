// HPOS workspace — utility helpers

/**
 * Format a Date object as a human-readable time string.
 * @param {Date} date
 * @returns {string}
 */
export function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * Format a Date object as a human-readable date string.
 * @param {Date} date
 * @returns {string}
 */
export function formatDate(date) {
  return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
}
