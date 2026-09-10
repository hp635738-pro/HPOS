/**
 * HPOS Code Arena — preload bridge.
 *
 * This is the only thing that stands between the renderer and the main
 * process. It runs with contextIsolation on and nodeIntegration off, and it
 * exposes exactly these ten functions — nothing else:
 *
 *   window.hpos.listDirectory(dir)      -> { ok, path, relative, entries[], truncated }
 *   window.hpos.readFile(name)          -> { ok, name, path, relative, bytes, lines, content }
 *   window.hpos.saveFile(name, content) -> { ok, name, path, relative, bytes, lines }
 *   window.hpos.startPreview(port?)     -> { ok, running, url, port, host, root }
 *   window.hpos.stopPreview()           -> { ok, running: false, url: null, port: null }
 *   window.hpos.previewStatus()         -> { ok, running, url, port, host, root }
 *   window.hpos.gitStatus()             -> structured read-only Git state
 *   window.hpos.gitCommit(msg, files[]) -> { committed, commit, status, … }
 *   window.hpos.gitPush()               -> { pushed, ahead, behind, status, … }
 *   window.hpos.openCodeArena()         -> opens Code Arena
 *
 * gitStatus() takes no arguments at all — there is nothing for the renderer
 * to inject.
 *
 * gitCommit() accepts exactly two things: a commit message string and an
 * array of project-relative file paths. The main process validates them again.
 *
 * gitPush() takes no arguments either — the renderer can only ask the main
 * process to push the repository.
 *
 * The preview methods take no path and no command: the renderer can start or
 * stop the main process's static server and read back its local URL.
 *
 * `dir` / `name` are always relative to the HPOS project root. The main
 * process resolves every request and rejects traversal, absolute paths and
 * symlink escapes.
 *
 * Deliberately NOT exposed: `require`, `process`, `fs`, `path`, `ipcRenderer`,
 * any dynamic channel name, and any generic send/invoke passthrough.
 */
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/* Channel names are duplicated in main.js; the strings must stay in sync. */
const CHANNEL_LIST = 'hpos:fs:list'
const CHANNEL_READ = 'hpos:fs:read'
const CHANNEL_SAVE = 'hpos:fs:save'
const CHANNEL_PREVIEW_START = 'hpos:preview:start'
const CHANNEL_PREVIEW_STOP = 'hpos:preview:stop'
const CHANNEL_PREVIEW_STATUS = 'hpos:preview:status'
const CHANNEL_GIT_STATUS = 'hpos:git:status'
const CHANNEL_GIT_COMMIT = 'hpos:git:commit'
const CHANNEL_GIT_PUSH = 'hpos:git:push'

contextBridge.exposeInMainWorld('hpos', {
  /**
   * List the immediate children of a directory inside the HPOS project.
   * @param {string} dir project-relative folder ('' or '.' means the root)
   */
  listDirectory(dir) {
    return ipcRenderer.invoke(CHANNEL_LIST, dir)
  },

  /**
   * Read a file from the HPOS project directory.
   * @param {string} name file name, relative to the project root
   */
  readFile(name) {
    return ipcRenderer.invoke(CHANNEL_READ, name)
  },

  /**
   * Write a file inside the HPOS project directory.
   * @param {string} name file name, relative to the project root
   * @param {string} content full replacement contents
   */
  saveFile(name, content) {
    return ipcRenderer.invoke(CHANNEL_SAVE, name, content)
  },

  /**
   * Start the local Live Preview server.
   * @param {number} [port] optional preferred port
   */
  startPreview(port) {
    return ipcRenderer.invoke(CHANNEL_PREVIEW_START, port)
  },

  /** Stop the preview server and release its port. */
  stopPreview() {
    return ipcRenderer.invoke(CHANNEL_PREVIEW_STOP)
  },

  /** Current preview state. */
  previewStatus() {
    return ipcRenderer.invoke(CHANNEL_PREVIEW_STATUS)
  },

  /**
   * Read-only Git status.
   */
  gitStatus() {
    return ipcRenderer.invoke(CHANNEL_GIT_STATUS)
  },

  /**
   * Commit selected project-relative files.
   * @param {string} message commit message
   * @param {string[]} files project-relative paths
   */
  gitCommit(message, files) {
    return ipcRenderer.invoke(CHANNEL_GIT_COMMIT, message, files)
  },

  /**
   * Push the current branch to its configured upstream.
   */
  gitPush() {
    return ipcRenderer.invoke(CHANNEL_GIT_PUSH)
  },

  /**
   * Open the existing HPOS Code Arena window.
   */
  openCodeArena() {
    return ipcRenderer.invoke('hpos:open-code-arena')
  },
})