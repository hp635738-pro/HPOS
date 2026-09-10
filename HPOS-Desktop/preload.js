/**
 * HPOS Code Arena — preload bridge.
 *
 * This is the only thing that stands between the renderer and the main
 * process. It runs with contextIsolation on and nodeIntegration off, and it
 * exposes exactly these nine functions — nothing else:
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
 *
 * gitStatus() takes no arguments at all — the renderer cannot supply a
 * command, a flag, a path or a working directory. The main process runs
 * allowlisted read-only git commands (rev-parse/status/log/remote/rev-list) with
 * shell:false, always inside HPOS-Desktop, and returns parsed data.
 *
 * gitCommit() is the only call that changes repository state and it accepts
 * exactly two things: a commit message string and an array of project-relative
 * file paths. There is no command, no flag, no branch and no working
 * directory to pass. The main process rejects empty/whitespace messages and
 * over-long ones, resolves every path through the same project-root gate the
 * fs bridge uses (no absolute paths, no '..', no symlink escapes, nothing
 * outside HPOS-Desktop), refuses files that do not exist, caps the list at 200
 * and then runs only `git add -- <paths>` and `git commit -- <paths>` —
 * a partial commit, so nothing that was not selected is included. No pull, no
 * fetch and no other subcommand is reachable through gitCommit(); pushing is
 * only ever reachable through gitPush() below, and only as `git push`.
 *
 * gitPush() takes no arguments either — the renderer cannot name a remote, a
 * URL, a branch, a refspec, a flag or a working directory; it can only ask
 * "push this repository". The main process pushes the checked-out branch to
 * the upstream configured for it in the user's own Git config, with
 * --no-force and a refspec it builds itself, and authentication is whatever
 * Git's configured credential helper or SSH key provides. Nothing here reads,
 * transports or stores a token, and no credential ever crosses this bridge.
 *
 * The preview methods take no path and no command: the renderer can start or
 * stop the main process's static server and read back its local URL, nothing
 * more. There is no child_process/shell access here, and none is needed —
 * the server is plain Node http owned by main.
 *
 * `dir` / `name` are always relative to the HPOS-Desktop project root. The
 * renderer has no way to name anything outside it: the main process resolves
 * every request, refuses traversal, absolute paths and symlink escapes, and
 * returns { ok: false, code, error } instead of throwing.
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
   * List the immediate children of a directory inside HPOS-Desktop.
   * @param {string} dir project-relative folder ('' or '.' means the root)
   */
  listDirectory(dir) {
    return ipcRenderer.invoke(CHANNEL_LIST, dir)
  },

  /**
   * Read a file from the HPOS-Desktop project directory.
   * @param {string} name file name, relative to HPOS-Desktop
   */
  readFile(name) {
    return ipcRenderer.invoke(CHANNEL_READ, name)
  },

  /**
   * Write a file inside the HPOS-Desktop project directory.
   * @param {string} name file name, relative to HPOS-Desktop
   * @param {string} content full replacement contents
   */
  saveFile(name, content) {
    return ipcRenderer.invoke(CHANNEL_SAVE, name, content)
  },

  /**
   * Start the local Live Preview server (main process owns it).
   * @param {number} [port] optional preferred port; falls back to a free one
   */
  startPreview(port) {
    return ipcRenderer.invoke(CHANNEL_PREVIEW_START, port)
  },

  /** Stop the preview server and release its port. */
  stopPreview() {
    return ipcRenderer.invoke(CHANNEL_PREVIEW_STOP)
  },

  /** Current preview state: { running, url, port, host, root }. */
  previewStatus() {
    return ipcRenderer.invoke(CHANNEL_PREVIEW_STATUS)
  },

  /**
   * Read-only Git status for HPOS-Desktop.
   * Takes no arguments by design — there is nothing for the renderer to inject.
   */
  gitStatus() {
    return ipcRenderer.invoke(CHANNEL_GIT_STATUS)
  },

  /**
   * Commit the listed files (project-relative) with the given message.
   * Nothing else can be sent: the message is a string, the paths are an array
   * of strings, and both are validated again in the main process.
   * @param {string} message commit message
   * @param {string[]} files project-relative paths to stage and commit
   */
  gitCommit(message, files) {
    return ipcRenderer.invoke(CHANNEL_GIT_COMMIT, message, files)
  },

  /**
   * Push the current branch to its configured upstream.
   * Takes no arguments by design — there is no remote, URL, branch, refspec or
   * flag for the renderer to supply, and no credential is passed through here.
   */
  gitPush() {
    return ipcRenderer.invoke(CHANNEL_GIT_PUSH)
  },
})
