# HPOS

A fully themeable desktop app shell — sidebar, header, and a Windows 11 style
settings explorer where almost every visual detail is user-editable.

Built with React 19 + Vite. No UI libraries, no icon packages, no remote fonts.

---

## Chalane ke liye

```bash
npm install     # ek baar
npm run dev     # http://localhost:5173
```

Aur commands:

```bash
npm run build       # production build -> dist/
npm run build:prod  # same as build, explicit prod naming for packaging
npm run preview     # build ko locally serve karo
npm run lint        # oxlint
npm test            # all packaging/path + runtime-bridge + theme tests
```

### Production packaging (Windows)

HPOS Desktop uses **electron-builder** with an NSIS installer for Windows x64.

**Prerequisites:**
- Node 18+ (tested on 22)
- `runtime/` dependencies installed: `cd runtime && npm install` (playwright-core) —
  the runtime is packaged as an application resource
- Network access to GitHub release assets on the first run (Electron binary +
  NSIS tooling; cached under `~/.cache` afterwards)

**Build frontend + package** — every `dist*` script chains the production React
build first, so one command is enough:

```bash
# Windows installer (NSIS) – produces release/HPOS Setup 0.1.0.exe
npm run dist:win

# Alternative – unpacked dir only (no installer, faster for smoke testing)
npm run dist:dir

# React production build only -> dist/
npm run build:prod
```

**Output (gitignored via `release/` in `.gitignore`):**
- Installer: `release/HPOS Setup 0.1.0.exe` (or versioned name)
- Unpacked app: `release/win-unpacked/HPOS.exe`

**Application icon:**
- `public/icon.ico` — the Windows application/installer icon
  (16/24/32/48/64/128/256 px), wired via `build.win.icon`
- `public/icon.svg` — the icon source: the existing HPOS logo mark
  (`favicon.svg`) on a rounded dark tile matching the app background.
  Regenerate `icon.ico` from it if the logo ever changes.

**What is packaged:**
- `HPOS-Desktop/` – Electron main (`main.js`), preload, runtimeManager, workspaceRoot, git logic
  (tests, the legacy static page and the nested lockfile are excluded)
- `dist/` – Vite-built React frontend (inside app.asar, loaded via `app.getAppPath()`)
- `src/pages/CodeArena.html` – standalone Code Arena shell (secondary window, not main)
- `runtime/` – read-only runtime via `extraResources` → `resources/runtime`
  - Includes `bin/hpos-runtime.js`, daemon, executors, browser provider
  - `runtime/node_modules/playwright-core` is included once `cd runtime && npm install`
    has run (tests inside `runtime/` are filtered out)
  - Writes only to `~/.hpos/runtime` (state dir, `HPOS_RUNTIME_HOME`), never to app resources
- `workspace-project/` – the **real Code Arena project source**, via
  `extraResources` → `resources/workspace-project`, generated at package time by
  `scripts/build-workspace-project.mjs` (staging dir is gitignored, never committed)
  - Seeded into the user workspace on first packaged launch — see
    *Workspace seeding* below
  - Carries the repository's visible, non-secret source and assets: `index.html`,
    `src/**`, `public/**`, `HPOS-Desktop/**`, `runtime/**`, `extension/**`,
    `server/**`, Vite/Tailwind/TS configs, the docs, and a `HPOS-WORKSPACE.json`
    provenance manifest (project name/version, source commit, entrypoint mapping)
  - Never carries `.git`, `.env*`, keys/certs (`.key`, `.pem`, `.p12`, `.pfx`,
    `.crt`), `credentials`/`secrets`, `node_modules`, lockfiles, logs, caches,
    build artifacts (`dist`, `build`, `out`, `target`, `release`), hidden
    entries, tests (`*.test.mjs`, `tests/`) or source maps
- `workspace-template/` – the PR #25 starter demo, kept **only** as a last-resort
  fallback for a build that ships no project payload
- No npm `dependencies` ride along in `app.asar` — React is bundled into `dist/`
  by Vite, so `react`/`react-dom` live in `devDependencies`

**What is NOT packaged:**
- Into `app.asar`: `.git/`, `server/.env`, caches, test files (`*.test.mjs`,
  `tests/`), source maps, the generated `workspace-project/` staging dir, and
  repository-only files (README, Vite configs, `src/*.jsx` sources, extension,
  server). Those repository files DO ship as the `workspace-project` **resource**
  (outside the asar) so the production workspace is the real project.

```bash
# Regenerate the production workspace payload on its own (every dist* script
# already runs it before electron-builder)
npm run workspace:project
```

**Workspace in packaged mode:**
- Explicit `HPOS_WORKSPACE_ROOT` (absolute, existing, readable/writable) → used as-is
- No `HPOS_WORKSPACE_ROOT` → safe default `<Electron userData>/workspace`
  (created on first launch, e.g. `%APPDATA%/HPOS/workspace`)
- Invalid explicit workspace → structured startup error, **no silent fallback**
- Never inside `app.asar`, `appPath` or `resourcesPath`; no `process.cwd()` fallback
- `workspaceRoot.js` enforces all of the above; dev mode (`app.isPackaged === false`)
  keeps the existing repository-root behavior

**Workspace seeding (first packaged launch):**

In development the Code Arena workspace root *is* this repository
(`developmentRoot: path.resolve(__dirname, '..')`), so Explorer, the editor, Git
and the terminal all operate on the real HPOS project. A packaged build reproduces
that instead of shipping a demo:

- `workspaceSeed.js` seeds `resources/workspace-project` (the real project
  payload) into `<userData>/workspace` when the workspace has no visible entries
- Payload preference: `workspace-project` → `workspace-template` (PR #25 demo,
  fallback only) → structured `ENO_TEMPLATE` failure, never a silent empty
  workspace
- **Served entrypoint:** the workspace serves the actual HPOS application —
  the served `index.html` is the production frontend build (`dist/index.html`,
  the same entry the packaged Electron shell loads), with its hashed bundle
  shipped under `assets/`. It is **never** `src/pages/CodeArena.html`: serving
  the Code Arena editor shell at `/` would nest the editor inside itself, and
  the payload builder now refuses that mapping outright. The repository's
  Vite/React entry is preserved byte-for-byte as `vite-index.html`, and
  `src/pages/CodeArena.html` stays at its real path as part of the source
  snapshot
- **Existing content is never blindly overwritten.** Seeding happens only on an
  empty (or hidden-files-only) workspace, with one narrow, provable exception: a
  workspace that is still a *byte-identical, untouched* copy of the bundled
  starter demo — one extra file, one extra folder or one edited byte cancels it —
  is upgraded to the real project (reported as `migratedFrom`)
- Boundary: the payload must live outside the workspace (a self-copy is refused
  with `ESELF`), and every destination path is re-checked to stay inside
  `WORKSPACE_ROOT`; the forbidden-entry filter runs at build time *and* at seed
  time, so secrets/deps/artifacts cannot be seeded even from a tampered payload

**Runtime in packaged mode:**
- `runtimeManager.js` resolves the runtime via `resourcesPath/runtime` (extraResources) first
- The runtime is spawned with `ELECTRON_RUN_AS_NODE=1`: `process.execPath` is the
  packaged `HPOS.exe`, and without the flag a packaged app would launch a second
  HPOS instance instead of the Node runtime daemon. The flag is inherited by the
  runtime's own task spawns.
- Duplicate prevention: if an external runtime is already running (manual
  `npm start` in runtime), a healthy endpoint is detected and no second one starts
- Graceful shutdown: SIGTERM → 5s wait → SIGKILL fallback, only the owned child

**Dev vs Packaged:**
- Dev: `HPOS_DEV_URL=http://localhost:5173` → `npm run start:dev` loads Vite dev server, manual runtime allowed
- Dev workspace = the repository itself, so nothing is seeded; run
  `npm run workspace:project` to inspect the exact payload a packaged build ships
- Prod: `dist/index.html` via `app.getAppPath()`, runtime auto-started, no terminal required, no blank screen, Code Arena not main

**One-click update (Settings → App → "Update from GitHub"):**
- Dev-shell feature: ek button press → check `origin/main` → fast-forward pull →
  `npm install` (agar dependency files badle) → `npm run build:prod` (agar
  frontend sources badle aur Vite dev server serve nahi kar raha) → window
  reload ya poori app ka restart — jo bhi changed files maange
- Pull path exactly wahi hai jo Code Arena Pull use karta hai (gitBridge.js):
  dirty workspace refuse (`ELOCALCHANGES`), divergence refuse, force kabhi nahi
- Renderer koi argument nahi bhejta — flow fixed hai (`appUpdate.js`),
  progress events se dikhta hai; packaged installs pe panel hidden hai
  (wahan Releases updater — Check for Updates — app shell update karta hai)

**Windows installer behavior / limitations:**
- Assisted (non-one-click) NSIS installer, per-user by default (no admin required
  unless an all-users location is chosen), custom install directory allowed
- Desktop + Start Menu shortcuts named **HPOS**
- Uninstalling does **not** delete user data — the default workspace under
  `%APPDATA%/HPOS/workspace` and runtime state under `~/.hpos/runtime` are left alone
- In-app updater: explicit Check/Download/Restart in Settings → App,
  against the pinned GitHub release source (see *Code Arena — the dev
  loop* above); updates are never automatic
- No WSL, Docker or VM requirement or support
- Building the installer needs network access to GitHub release assets
  (`release-assets.githubusercontent.com`). In sandboxes that block that host,
  `npm install` / `npm run dist:win` fail exactly at the Electron binary
  download — an environment limitation, not a project error.
  `npm test` runs `packaging.test.mjs`, which validates the packaging contract
  (icon, appId, NSIS options, payload excludes, scripts) without building.

**Security preserved:**
- `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`, restricted preload
- No generic shell/process API, no arbitrary Git args, no credential logging, bounded sanitized diagnostics

**Requirements:** Node 18+ (Step 6 verification Node 22 par chali hai)

### Production packaging (Linux)

Same electron-builder pipeline, same payload — **AppImage (portable) + deb
(Debian/Ubuntu install) on x64**. Aapke paas jo bhi Debian/Ubuntu/Mint jaisa
64-bit system hai, usi pe build hota hai — koi cross-compilation nahi chahiye.

**Prerequisites (Windows jaise hi, plus kuch nahi):**
- Node 18+ (tested on 22)
- `runtime/` dependencies installed: `cd runtime && npm install` (playwright-core)
- Network access to GitHub release assets on the first run (Electron binary +
  fpm/AppImage tooling; cached under `~/.cache` afterwards)
- No extra system packages — electron-builder apna fpm + AppImage tooling khud
  download karta hai (kisi bhi distro pe chal jata hai)

**Build frontend + package:**

```bash
# AppImage + deb – produces release/HPOS-0.1.0.AppImage + release/hpos_0.1.0_amd64.deb
npm run dist:linux

# Unpacked dir only (fast smoke test) – release/linux-unpacked/HPOS
npm run dist:linux:dir
```

**Output (gitignored via `release/` in `.gitignore`):**
- AppImage: `release/HPOS-0.1.0.AppImage` — portable, kisi bhi glibc ≥2.31
  (Debian 11+/Ubuntu 20.04+) Linux pe direct chalta hai
- deb: `release/hpos_0.1.0_amd64.deb` — system install (`sudo apt install ./…`),
  menu entry + icons + uninstall support
- Unpacked: `release/linux-unpacked/HPOS` — raw Electron app directory

**Application icon:**
- `public/icon.png` — 512×512 PNG rendered from the same `public/icon.svg`
  source as the Windows `icon.ico`; wired via `build.linux.icon`
- electron-builder isse resize karke hicolor size set (16→512) banata hai jo
  AppImage, deb aur desktop entry use karte hain
- `public/icon.png` `build.files` mein bhi pack hota hai taaki `main.js` har
  Linux window ko explicit icon de sake (`linuxWindowIcon()` — kai WMs desktop
  file ka icon tab tak ignore karte hain jab tak window khud icon set na kare)

**Run/install:**
- AppImage: `chmod +x HPOS-0.1.0.AppImage && ./HPOS-0.1.0.AppImage`
  (Debian 12/Ubuntu 22.04+ pe `libfuse2` chahiye: `sudo apt install libfuse2`)
- deb: `sudo apt install ./hpos_0.1.0_amd64.deb` → apps menu mein **HPOS**
- Uninstall: `sudo apt remove hpos` (user data — `~/.config/HPOS/workspace` aur
  `~/.hpos/runtime` — deliberately delete nahi hoti)

**Linux-specific notes:**
- Workspace default: `<userData>/workspace` (`~/.config/HPOS/workspace`), same
  seeding behavior as Windows — pehli launch pe real project payload seed hota hai
- `HPOS_WORKSPACE_ROOT` env (absolute path) packaged mode mein workspace override
  karta hai — dono platforms pe same
- Terminal sessions `sh -c`/`$SHELL` use karte hain (`terminalSession.js`
  platform-aware hai); runtime daemon `ELECTRON_RUN_AS_NODE=1` ke saath chalta hai
- In-app updater Linux AppImage/deb builds pe "unsupported" dikhata hai
  (electron-updater auto-update AppImage ke liye AppImageUpdate mangta hai jo
  abhi wired nahi) — update ka flow: naya build download karke replace kar do
- AppImage pe `libfuse2` na ho toh: `sudo apt install libfuse2`, ya
  `./HPOS-0.1.0.AppImage --appimage-extract && squashfs-root/AppRun`
- Purane/locked-down distros (Ubuntu 24.04+) pe Electron ka sandbox na chale toh
  SETUP-LINUX.md ka **Troubleshooting** section dekho
- Building needs network access to GitHub release assets — sandboxed networks jo
  `objects.githubusercontent.com` block karte hain, wahan download step fail hoga
  (environment limitation, project error nahi). Config validation har jagah
  hoti hai: `npm test` → `packaging.test.mjs` ab Linux contract bhi check karta hai

**Full step-by-step Hinglish guide (install, dev mode, packaging,
troubleshooting):** [SETUP-LINUX.md](SETUP-LINUX.md)

### Code Arena — the dev loop (edit → test → launch → ship)

The NSIS installer is a **release** artifact, not part of everyday
development. The installed app's Code Arena *is* the dev environment: it
ships the real project source as its workspace, and the whole loop runs
inside it — no reinstall, no rebuild:

```
open Code Arena → Pull from GitHub → edit → save → terminal tests →
Launch HPOS → test → fix → commit → push
```

**Git workspace.** A packaged workspace starts life as a plain directory
(the seeded payload deliberately ships without `.git` and without any
developer machine's auth material). The GitHub panel shows a
**Connect Workspace to GitHub** button in that state; it runs the fixed
main-process sequence `git init` + branch pinned to `main` + the hard-coded
`origin` (`hp635738-pro/HPOS`) + local branch upstream config. Existing
repositories are reported and never modified. After that, the panel gives
branch, status, changed files, Commit (explicit message + ticked files),
Pull from GitHub and Push. The contract is fixed and defensive
(`HPOS-Desktop/gitBridge.js`): origin/main only, ff-only pull, dirty
workspaces blocked before a pull, push refused when behind, **no force
push, no reset/clean/stash/rebase**, no renderer-supplied git arguments,
credential-shaped strings scrubbed before IPC.

**Terminal.** Interactive shell locked to the workspace root
(`terminalSession.js`): real stdout/stderr streams, exit codes, Ctrl+C,
resize, Clear (button or Ctrl+L), multiple sessions, full cleanup when
Code Arena closes. The renderer never gets Node, a shell name, a cwd or an
env — only `run(command)`.

**Launch HPOS.** The toolbar action starts a **separate HPOS instance from
the current workspace code** (`devLaunch.js`): the app's own Electron
binary (`process.execPath`) pointed at the workspace directory, which
declares `main: HPOS-Desktop/main.js`. The instance is marked
`HPOS_DEV_WORKSPACE=1` — its window title carries "· development workspace"
and it loads the workspace-layout entry (root `index.html`/`assets/`,
falling back from `dist/` only for these instances). Edits to the shell or
preload take effect on the next Launch; frontend source edits take effect
after a workspace rebuild (`npm install && npm run build` in the terminal).
Single instance, Stop button, SIGTERM→SIGKILL, and the child is always
killed when Code Arena or the app closes. There is no arbitrary-executable
path: binary, app directory and (scrubbed) env are fixed in the main
process.

**Updates (Settings → App).** Explicit only: **Check for Updates** against
the pinned GitHub release source (`build.publish` →
`hp635738-pro/HPOS`, no secrets in config) → **Download Update** →
**Restart to Update**. `electron-updater` (the only production dependency)
handles the download and verifies integrity/signatures; a failed
verification is reported as *not installed* and can never reach install.
Auto-download and auto-install are forced off; development instances show a
structured "updates only in the installed app" state. Developer builds never
publish: all `dist*` scripts pass `--publish never` — releases are cut by
an explicit publish step against the pinned repo.

**Dev vs production architecture.**
- *Dev loop*: Code Arena inside any HPOS instance → workspace code →
  terminal + Launch HPOS (a dev instance, clearly marked) → commit → push.
  Nothing in this loop touches the installer.
- *Release loop*: version bump → `npm run dist:win` (build + workspace
  payload) → explicit publish to the pinned GitHub release → installed app
  offers the update in Settings → user restarts → latest.

**Security preserved across all of the above:** `contextIsolation:true`,
`sandbox:true`, `nodeIntegration:false`; every workspace operation is an
argument-free preload call into an allowlisted main-process module
(`terminalSession.js`, `gitBridge.js`, `devLaunch.js`, `updater.js`);
workspace-root boundaries enforced everywhere; regression tests in
`HPOS-Desktop/*.test.mjs` pin each contract.


Note: the web-side AI chat pages (AI chats / Code Arena entry points), their
bridge client and the local conversation store have been removed from the app.
The `extension/` browser extension and the runtime's fixed
`browser.deepseek` provider remain in the repository for compatibility —
`BRIDGE.md` documents that remaining surface.

### Local runtime + browser DeepSeek (Step 6)

The local `hpos-runtime` daemon is connected during Vite development and now
owns the AI task lifecycle:

```bash
cd runtime
npm install     # playwright-core transport only; no browser download
npm start       # listens on 127.0.0.1:5190 and writes ~/.hpos/runtime/endpoints.json
```

Start a visible Chromium/Chrome instance with a dedicated profile and loopback
CDP, open exactly one `https://chat.deepseek.com/` tab, then sign in normally:

```bash
chromium --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.hpos/deepseek-browser"
```

The `browser.deepseek` service is a fixed, source-registered route: the
runtime never receives browser credentials/session data, never reads
cookies/storage, and never retries a prompt after an uncertain send, timeout,
disconnect or restart. See `runtime/README.md` for browser variants, lifecycle
and security.

With `npm run dev` running from the project root, the browser uses the fixed
same-origin routes `/hpos-runtime/health`, `/hpos-runtime/rpc` and (Step 4)
`/hpos-runtime/events` (SSE). The Vite development proxy reads the local
endpoint file, keeps the target on `127.0.0.1`, and adds `X-HPOS-Token`
server-side. `LocalRuntimeBridge` never receives, stores, or sends that
credential. `Runtime connected` means authenticated `PING` and `RT_STATUS` both
succeeded; `/health` is liveness only.

The runtime publishes allowlisted lifecycle events (`runtime.*`, `task.*`)
over SSE. Holding the header runtime status container opens the full-panel
**Runtime details** view: connection/stream state, running tasks with Stop,
bounded recent tasks, counters, and safe process metrics; it is observability
only and remains **not a terminal**.
Event history is a bounded in-memory ring (never written to disk), and there
is no arbitrary task, browser, command or shell UI.

Details: `runtime/README.md` (`/events`, event types, history/reconnect,
metrics availability, Activity UI non-goals).

```bash
npm test        # packaging/path + runtime-bridge (protocol, connection, events,
                # activity), proxy and theme checks (root)
                # + `cd runtime && npm test` (runtime daemon suites)
```

---

## Kya bana hua hai

### Shell
- Sidebar — 7 pages, drag-to-reorder, right-click se pin/lock, collapse mode
- Header — page title, Wide Notch (Settings/File pill), theme toggle
- Pages abhi blank hain, content ka intezaar

### Theming
- Light / Dark / System
- 8 accent presets + custom colour picker
- 16 colour tokens editable, light aur dark ke alag overrides
- Density, radius, aur poora typography control

### Systems
- **Command palette** (`Ctrl+K`) — fuzzy search, pages + settings + actions
- **Advanced settings** — 12 panels, search, breadcrumb, related suggestions
- **Workspaces** — poora look naam se save karo, switch karo
- **Undo / Redo** — settings ke liye, 50-step history
- **Export / Import** — settings JSON file
- **Toast + Modal** — mounted aur available
- **Component kit** — 28 reusable components (`ui/Kit.jsx`)

---

## File structure

```
src/
├── App.jsx                 shell, routing, palette wiring
├── main.jsx                providers: Theme -> Toast -> Modal
├── index.css               tokens, animations, global styles
│
├── theme/
│   └── ThemeContext.jsx    prefs store, palettes, undo/redo engine
│
├── lib/
│   ├── colour.js           hex/rgb/hsv/hsl, contrast, harmony
│   ├── longPress.js        hold-to-open gesture (runtime status container)
│   └── bridge/             local runtime bridge (protocol, connection, events, activity)
│
├── pages/
│   ├── Blank.jsx           empty canvas
│   └── Settings.jsx        Appearance + Danger zone
│
└── components/
    ├── Sidebar.jsx         nav, drag, pin/lock, context menu
    ├── Topbar.jsx          header shell
    ├── Notch.jsx           the header pill
    ├── Icons.jsx           55+ inline SVG icons
    ├── CommandPalette.jsx  Ctrl+K launcher
    ├── ColourField.jsx     swatch + hex input
    ├── ColourPicker.jsx    full picker popover
    ├── AdvancedEditor.jsx  settings explorer shell
    │
    ├── WorkspacePanel.jsx  ┐
    ├── ColoursPanel.jsx    │
    ├── TypePanel.jsx       │
    ├── ComponentPanel.jsx  │
    ├── PickerPanel.jsx     │  advanced settings pages
    ├── NotchPanel.jsx      │
    ├── SidebarPanel.jsx    │
    ├── HeaderPanel.jsx     │
    ├── PalettePanel.jsx    │
    ├── ShortcutsPanel.jsx  │
    ├── BackupPanel.jsx     ┘
    │
    └── ui/
        ├── Bits.jsx        panel primitives (in use)
        ├── Kit.jsx         28 components (not applied yet)
        ├── Modal.jsx       dialog system (mounted)
        └── Toast.jsx       notifications (mounted)
```

---

## Kaise kaam karta hai

### Everything is a CSS variable

`ThemeContext` har preference ko `:root` pe CSS variable ke roop mein likhta hai.
Koi bhi naya component agar `var(--accent)`, `var(--surface)` waghera use kare,
toh wo apne aap theme follow karega — alag se kuch karne ki zarurat nahi.

```jsx
const { prefs, set, resolved, accentHex } = useTheme()

set('accent', 'violet')       // ek preference badlo
prefs.railWidth               // koi bhi value padho
resolved                      // 'light' ya 'dark' (system resolve ho ke)
```

### Naya settings panel add karna

1. `src/components/` mein panel banao, `ui/Bits` ke primitives use karke
2. `AdvancedEditor.jsx` ke `PAGES` array mein ek entry add karo
3. Bas — search, breadcrumb, related suggestions sab apne aap jud jayenge

### Palette mein command add karna

`CommandPalette.jsx` ke `commands` memo mein ek object push karo:

```js
{ id: 'act:something', group: 'Actions', name: 'Do the thing', run: () => {} }
```

---

## Settings kahan save hote hain

- **`localStorage['nexa.prefs']`** — primary
- **`.hpos-prefs.json`** — dev server ke through disk mirror

Dusra wala isliye hai kyunki localStorage page origin se juda hota hai.
Dev sandbox restart pe naya host deta hai, toh settings reset dikhte the.
Local VS Code pe ye zaroori nahi, par nuksaan bhi nahi karta.

---

## Notes

- **Koi remote font nahi** — sirf OS-native stacks. Sandbox mein Google Fonts
  blocked tha, aur waise bhi offline desktop app ke liye yahi sahi hai.
- **Saare icons inline SVG** hain `Icons.jsx` mein — koi icon package nahi.
- **Desktop-first** — mobile ke liye responsive pass abhi nahi hua.
- **Undo history memory mein** hai, reload pe clear ho jaati hai (by design).

---

## Aage kya

Poori list `ROADMAP.md` mein hai. Sabse upar:

1. Keyboard shortcuts ko wire karna (bindings record hote hain, kaam nahi karte)
2. Component kit ko baaki panels pe apply karna
3. Blank pages pe empty states
4. Favourites page ka content
5. Tauri desktop packaging
