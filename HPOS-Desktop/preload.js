/**
 * HPOS Code Arena — preload bridge.
 *
 * This is the only thing that stands between the renderer and the main
 * process. It runs with contextIsolation on and nodeIntegration off, and it
 * exposes these functions — nothing else:
 *
 *   window.hpos.listDirectory(dir)         -> { ok, path, relative, entries[], truncated }
 *   window.hpos.readFile(name)             -> { ok, name, path, relative, bytes, lines, content }
 *   window.hpos.aiReadFile(name)           -> { ok, name, path, relative, bytes, lines, content }
 *   window.hpos.aiEditFile(name, content)  -> { ok, name, path, relative, bytes, lines }
 *   window.hpos.sendAiEditProposal(proposal) -> { ok, name, reviewed }
 *   window.hpos.saveFile(name, content)    -> { ok, name, path, relative, bytes, lines }
 *   window.hpos.terminal.create()          -> { ok, sessionId, workspaceRoot }
 *   window.hpos.terminal.run(sessionId, command) -> { ok, code, signal, truncatedOut, truncatedErr, timedOut, … } (output streams via onTerminalData)
 *   window.hpos.terminal.resize(sessionId, cols, rows) -> { ok, cols, rows }
 *   window.hpos.terminal.interrupt(sessionId) -> { ok }
 *   window.hpos.terminal.dispose(sessionId) -> { ok }
 *   window.hpos.terminal.onTerminalData(cb)  / offTerminalData(cb)
 *   window.hpos.gitStatus()                -> structured read-only Git state
 *   window.hpos.gitCommit(msg, files[])    -> { committed, commit, status, … }
 *   window.hpos.gitPush()                  -> { pushed, ahead, behind, status, … }
 *   window.hpos.checkGitPull()             -> structured origin/main update plan
 *   window.hpos.applyGitPull(commit)       -> structured fast-forward result
 *   window.hpos.openCodeArena()            -> opens Code Arena
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
 * The terminal methods take no path, no command interpreter and no working directory: the
 * renderer can only run a command inside a session that the main process has
 * already pinned to the workspace root with a scrubbed environment. Output is
 * delivered through onTerminalData, never as an arbitrary callback target.
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
const CHANNEL_AI_READ = 'hpos:ai:read-file'
const CHANNEL_AI_EDIT = 'hpos:ai:edit-file'
const CHANNEL_AI_PROPOSAL = 'hpos:ai:proposal'
const CHANNEL_SAVE = 'hpos:fs:save'
const CHANNEL_TERM_CREATE = 'hpos:term:create'
const CHANNEL_TERM_RUN = 'hpos:term:run'
const CHANNEL_TERM_RESIZE = 'hpos:term:resize'
const CHANNEL_TERM_INTERRUPT = 'hpos:term:interrupt'
const CHANNEL_TERM_DISPOSE = 'hpos:term:dispose'
const CHANNEL_TERM_DATA = 'hpos:term:data'
const CHANNEL_GIT_STATUS = 'hpos:git:status'
const CHANNEL_GIT_COMMIT = 'hpos:git:commit'
const CHANNEL_GIT_PUSH = 'hpos:git:push'
const CHANNEL_GIT_PULL_CHECK = 'hpos:git:pull-check'
const CHANNEL_GIT_PULL_APPLY = 'hpos:git:pull-apply'

/* Terminal output subscriptions. The renderer hands us a callback; we keep a
   stable listener per callback so offTerminalData can remove exactly the one
   it added. */
const terminalListeners = new Map()

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
   * Read a project file for the future AI tool layer.
   * The main process applies the project-root and size checks.
   */
  aiReadFile(name) {
    return ipcRenderer.invoke(CHANNEL_AI_READ, name)
  },

  /**
   * Replace a project file for the future AI tool layer.
   * The main process applies the project-root, symlink, and size checks.
   */
  aiEditFile(name, content) {
    return ipcRenderer.invoke(CHANNEL_AI_EDIT, name, content)
  },

  /**
   * Send a complete, read-backed AI edit proposal to the Code Arena review UI.
   * This never writes a file; Apply Changes in Code Arena does that explicitly.
   */
  sendAiEditProposal(proposal) {
    return ipcRenderer.invoke(CHANNEL_AI_PROPOSAL, proposal)
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
   * The interactive terminal, fixed to the workspace root by the main process.
   * The renderer never supplies a cwd, a path, a command interpreter or an environment.
   */
  terminal: {
    /** Create a session locked to the workspace root. */
    create() {
      return ipcRenderer.invoke(CHANNEL_TERM_CREATE)
    },

    /** Run one command in the session; resolves with code/signal/output. */
    run(sessionId, command) {
      return ipcRenderer.invoke(CHANNEL_TERM_RUN, sessionId, command)
    },

    /** Resize the terminal grid (exported as COLUMNS/LINES to the next command). */
    resize(sessionId, cols, rows) {
      return ipcRenderer.invoke(CHANNEL_TERM_RESIZE, sessionId, cols, rows)
    },

    /** Interrupt (Ctrl+C equivalent) the in-flight command. */
    interrupt(sessionId) {
      return ipcRenderer.invoke(CHANNEL_TERM_INTERRUPT, sessionId)
    },

    /** Close a session and free its resources. */
    dispose(sessionId) {
      return ipcRenderer.invoke(CHANNEL_TERM_DISPOSE, sessionId)
    },

    /** Subscribe to streamed terminal output ({ sessionId, stream, chunk }). */
    onTerminalData(callback) {
      if (typeof callback !== 'function') return
      const listener = (_event, data) => callback(data)
      terminalListeners.set(callback, listener)
      ipcRenderer.on(CHANNEL_TERM_DATA, listener)
    },

    /** Unsubscribe a previously registered output callback. */
    offTerminalData(callback) {
      const listener = terminalListeners.get(callback)
      if (!listener) return
      ipcRenderer.removeListener(CHANNEL_TERM_DATA, listener)
      terminalListeners.delete(callback)
    },
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

  /** Check origin/main and return a pull plan without changing project files. */
  checkGitPull() {
    return ipcRenderer.invoke(CHANNEL_GIT_PULL_CHECK)
  },

  /** Re-check safety and apply only the explicitly reviewed commit. */
  applyGitPull(commit) {
    return ipcRenderer.invoke(CHANNEL_GIT_PULL_APPLY, commit)
  },

  /**
   * Open the existing HPOS Code Arena window.
   */
  openCodeArena() {
    return ipcRenderer.invoke('hpos:open-code-arena')
  },
})
