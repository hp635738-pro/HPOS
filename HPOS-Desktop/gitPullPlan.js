'use strict'

const STATES = Object.freeze({
  UP_TO_DATE: 'up-to-date',
  AVAILABLE: 'available',
  LOCAL_CHANGES: 'local-changes',
  DIVERGED: 'diverged',
  ERROR: 'error',
})

function classifyGitPullState({ branch, detached, dirty, localAhead, remoteAhead } = {}) {
  if (detached || branch !== 'main') return STATES.ERROR
  if (dirty) return STATES.LOCAL_CHANGES
  if ((Number(localAhead) || 0) > 0 && (Number(remoteAhead) || 0) > 0) return STATES.DIVERGED
  if ((Number(remoteAhead) || 0) === 0) return STATES.UP_TO_DATE
  return STATES.AVAILABLE
}

function packageFilesChanged(files) {
  return Array.isArray(files) && files.some((file) => file === 'package.json' || file === 'package-lock.json')
}

module.exports = { STATES, classifyGitPullState, packageFilesChanged }
