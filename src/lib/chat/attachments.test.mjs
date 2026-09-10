/**
 * Attachment helper tests (no browser, no backend).
 * Run: node src/lib/chat/attachments.test.mjs
 *
 * A valid images pass validation
 * B non-images are rejected
 * C oversize / empty files are rejected
 * D invalid input is rejected
 * E limits are sane for local-only thumbnails
 * F attachment ids are unique strings
 */
import {
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  THUMB_MAX_DIM,
  validateImageFile,
  attachmentId,
} from './attachments.js'

let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed += 1
    console.error(`FAIL  ${msg}`)
  } else {
    console.log(`ok    ${msg}`)
  }
}

const file = (over = {}) => ({ name: 'pic.png', size: 1024, type: 'image/png', ...over })

/* A */
assert(validateImageFile(file()) === null, 'A: png passes')
assert(validateImageFile(file({ type: 'image/jpeg', size: MAX_FILE_BYTES })) === null, 'A: max-size jpeg passes')

/* B */
assert(typeof validateImageFile(file({ type: 'application/pdf' })) === 'string', 'B: pdf rejected')
assert(typeof validateImageFile(file({ type: 'text/plain' })) === 'string', 'B: text rejected')
assert(typeof validateImageFile(file({ type: '' })) === 'string', 'B: empty type rejected')

/* C */
assert(typeof validateImageFile(file({ size: MAX_FILE_BYTES + 1 })) === 'string', 'C: oversize rejected')
assert(typeof validateImageFile(file({ size: 0 })) === 'string', 'C: empty file rejected')

/* D */
assert(typeof validateImageFile(null) === 'string', 'D: null rejected')
assert(typeof validateImageFile(undefined) === 'string', 'D: undefined rejected')
assert(typeof validateImageFile('nope') === 'string', 'D: non-object rejected')
assert(typeof validateImageFile({}) === 'string', 'D: typeless object rejected')

/* E */
assert(MAX_ATTACHMENTS === 4, 'E: at most 4 images per message')
assert(MAX_FILE_BYTES === 8 * 1024 * 1024, 'E: 8 MB per file cap')
assert(THUMB_MAX_DIM === 384, 'E: thumbnails stay small for local storage')

/* F */
{
  const ids = new Set([attachmentId(), attachmentId(), attachmentId()])
  assert(ids.size === 3, 'F: ids are unique')
  assert([...ids].every((id) => typeof id === 'string' && id.length > 2), 'F: ids are non-empty strings')
}

if (failed) {
  console.error(`\n${failed} attachment test(s) failed`)
  process.exit(1)
}
console.log('\nattachments A–F: all passed (validation + limits, no backend)')
