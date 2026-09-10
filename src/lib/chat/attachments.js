/**
 * Composer image attachments (UI state only — no backend).
 *
 * The composer lets the user attach images to a message. Files are validated
 * (type + size) and downscaled to small JPEG thumbnails before they are kept
 * in composer state, so what lands in the local message meta stays light.
 * The DeepSeek runtime send payload is untouched — attachments never leave
 * the browser; they are shown in the composer and the message history.
 */

export const MAX_ATTACHMENTS = 4
export const MAX_FILE_BYTES = 8 * 1024 * 1024
export const THUMB_MAX_DIM = 384
export const THUMB_JPEG_QUALITY = 0.82

export function attachmentId() {
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * Pure validation — returns an error string or null when the file is fine.
 * Takes any { name, size, type } shape so it is unit-testable in Node.
 */
export function validateImageFile(file) {
  if (!file || typeof file !== 'object') return 'not a file'
  if (typeof file.type !== 'string' || !file.type.startsWith('image/')) {
    return 'only image files can be attached'
  }
  if (typeof file.size !== 'number' || !(file.size > 0)) return 'file is empty'
  if (file.size > MAX_FILE_BYTES) return 'larger than 8 MB'
  return null
}

/**
 * Read an image File/Blob and downscale it to a thumbnail descriptor:
 * { id, name, size, type, width, height, dataUrl }. DOM-only (Image +
 * canvas); the composer awaits it before adding the thumbnail.
 */
export function readImageAttachment(file) {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      reject(new Error('attachments need a browser'))
      return
    }
    let url = null
    try {
      url = URL.createObjectURL(file)
    } catch {
      reject(new Error('could not be read'))
      return
    }
    const img = new Image()
    img.onload = () => {
      try {
        const w = img.naturalWidth || img.width
        const h = img.naturalHeight || img.height
        if (!w || !h) throw new Error('empty image')
        const scale = Math.min(1, THUMB_MAX_DIM / Math.max(w, h))
        const width = Math.max(1, Math.round(w * scale))
        const height = Math.max(1, Math.round(h * scale))
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        canvas.getContext('2d').drawImage(img, 0, 0, width, height)
        const dataUrl = canvas.toDataURL('image/jpeg', THUMB_JPEG_QUALITY)
        resolve({
          id: attachmentId(),
          name: file.name || 'image',
          size: file.size || 0,
          type: file.type || 'image/jpeg',
          width,
          height,
          dataUrl,
        })
      } catch {
        reject(new Error('could not be read'))
      } finally {
        try { URL.revokeObjectURL(url) } catch { /* ignore */ }
      }
    }
    img.onerror = () => {
      try { URL.revokeObjectURL(url) } catch { /* ignore */ }
      reject(new Error('could not be read'))
    }
    img.src = url
  })
}
