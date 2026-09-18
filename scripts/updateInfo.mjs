#!/usr/bin/env node
/**
 * Reader for the update-metadata files electron-builder writes next to the
 * release artifacts: `latest-linux.yml` (Linux) and `latest.yml` (Windows).
 *
 * The file is produced by `app-builder-lib/out/publish/updateInfoBuilder.js`
 * and has this exact shape (basename-relative URLs, sha512 in base64):
 *
 *   version: 0.1.1
 *   files:
 *     - url: HPOS-0.1.1.AppImage
 *       sha512: <base64 sha512>
 *       size: 123456789
 *     - url: hpos_0.1.1_amd64.deb
 *       sha512: <base64 sha512>
 *       size: 987654321
 *   path: hpos_0.1.1_amd64.deb
 *   sha512: <base64 sha512>
 *   releaseDate: '2026-09-18T10:00:00.000Z'
 *
 * `files[].url` is only a FILE NAME — electron-updater resolves it against
 * `<basePath>/download/<tag>/`. That is why the verification scripts have to
 * resolve it themselves before they can prove the URL really exists.
 *
 * Parsing is done here (and not with a YAML library) on purpose: this is the
 * gate that decides whether a release may be published, so it must not depend
 * on anything the release itself drags in.
 */
import path from 'node:path'

/** Strip an optional surrounding pair of quotes and trailing spaces. */
function unquote(value) {
  const trimmed = String(value == null ? '' : value).trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/**
 * Parse an electron-builder update-info YAML file.
 *
 * @param {string} text raw file content
 * @returns {{version?: string, files: Array<Record<string, string>>, path?: string, sha512?: string, releaseDate?: string} & Record<string, string>}
 */
export function parseUpdateInfo(text) {
  const result = {}
  const files = []
  let current = null
  for (const rawLine of String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n')) {
    if (rawLine.trim() === '' || /^\s*#/.test(rawLine)) continue
    const indent = rawLine.length - rawLine.replace(/^\s+/, '').length
    const line = rawLine.trim()
    if (line.startsWith('- ')) {
      current = {}
      files.push(current)
      const match = /^([^:]+):\s*([\s\S]*)$/.exec(line.slice(2))
      if (match) current[match[1].trim()] = unquote(match[2])
      continue
    }
    const match = /^([^:]+):\s*([\s\S]*)$/.exec(line)
    if (!match) continue
    const key = match[1].trim()
    const value = unquote(match[2])
    if (indent === 0) {
      // `files:` opens the list handled above; keep the key out of the result.
      if (key === 'files') continue
      result[key] = value
    } else if (current) {
      current[key] = value
    }
  }
  if (files.length > 0) result.files = files
  return result
}

/** The download base the updater uses for a GitHub-hosted release. */
export function releaseDownloadBase({ owner, repo, tag }) {
  return `https://github.com/${owner}/${repo}/releases/download/${tag}`
}

/**
 * Resolve a `files[].url` entry to the URL electron-updater will request.
 * Absolute URLs are returned untouched; everything else is treated as a file
 * name relative to the release download directory.
 */
export function resolveFileUrl(url, { owner, repo, tag }) {
  const value = String(url == null ? '' : url).trim()
  if (/^https?:\/\//i.test(value)) return value
  return `${releaseDownloadBase({ owner, repo, tag })}/${encodeURI(value.replace(/ /g, '-'))}`
}

/** File name an entry points at, whatever form the URL has. */
export function fileUrlName(url) {
  try {
    return decodeURIComponent(path.basename(new URL(String(url)).pathname))
  } catch {
    return path.basename(String(url == null ? '' : url))
  }
}

/** A sha512 in an update-info file is base64 and always 88 characters. */
export function isSha512(value) {
  return /^[A-Za-z0-9+/]{86}==$/.test(String(value == null ? '' : value).trim())
}
