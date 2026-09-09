# Linux execution backend (M1 — Step 5)

**Linux is an invisible, background execution capability. It is not a desktop
environment, not a terminal, not a shell, and not a replacement OS.** This
directory exists so that a future HPOS feature which *genuinely* needs Linux
tooling can say so in one place — a service registration — and get a supervised
Linux child process, without the core task registry, supervisor or transport
changing at all.

Step 5 delivers the **foundation**: the abstraction, the capability detection,
the boundary and the wiring. It deliberately delivers **no Linux feature**.

```
HPOS UI ──▶ LocalRuntimeBridge ──▶ Runtime daemon ──┬──▶ native backend   ─┐
   (RPC)                (RT_TASK_RUN { service })   │                      ├──▶ ONE process
                                                    └──▶ linux backend ────┘    supervisor
              service ─▶ executors.js ─▶ backend.js (router) ─▶ linux/*        (spawn, timeout,
                                                                    │            kill chain,
                                                                    ▼            workspace, env)
                                                          Linux environment (when one exists)
```

## Files

| File | Owns |
| --- | --- |
| `capabilities.js` | the detection verdict: is there a usable Linux execution backend here, and how far does it go? |
| `launcher.js` | the fixed launch plan for one Linux task: argv, cwd, scrubbed environment, caps |
| `workspace.js` | the workspace gate: this task's directory under the runtime state root, and nothing else |
| `backend.js` | the backend interface the router and registry speak (`detectCapabilities` / `isAvailable` / `plan` / `run` / `stop` / `getStatus`) |

Above it, in `runtime/`: `executors.js` (the closed executor vocabulary + the
service → executor rules) and `backend.js` (the router that maps an executor
name onto the object that can run it). `supervisor.js` stays the **only** process
authority for both backends.

## Capability detection

`detectLinuxCapabilities({ platform, env, probeExists, execPath, services })`
is pure and injectable, so every branch below is a tested fact on every host —
including a Windows development machine with no Linux installed.

The two questions are separate and must not be confused:

1. **Is this a Linux host?** `platform === 'linux'`. Nothing else counts.
2. **Is there a usable Linux backend?** An *implemented* adapter for that
   platform **and** that adapter's probes passing.

| Situation | `available` | `support` | `reason` |
| --- | --- | --- | --- |
| Linux host, `host-linux` adapter probes pass | `true` | `partial` | `backend-adapter-ready` |
| Linux host, probe failed (no usable interpreter / no `/proc`) | `false` | `none` | `backend-adapter-probe-failed` |
| win32 / darwin / any other host (no implemented adapter) | `false` | `none` | `no-backend-adapter-for-platform` |
| `HPOS_LINUX_EXECUTOR=off` on any host | `false` | `none` | `disabled-by-configuration` |
| platform could not be classified | `false` | `none` | `unknown-platform` |

**`support: partial` on a Linux host is the honest ceiling for Step 5.** Tasks
execute, and they are supervised, workspace-isolated and environment-scrubbed —
but there are no namespaces, no privilege drop and no network isolation, so the
runtime must not claim `full`. That label is the difference between an
execution backend and a lie about a sandbox.

The adapter table is the reason nothing gets installed:

- `host-linux` — implemented; only applies to `linux`; executes directly on the
  host that is already running the daemon.
- `wsl`, `docker`, `vm` — **declared, `implemented: false`.** Listed so that
  RT_STATUS and the docs can say precisely what is missing. An unimplemented
  adapter is never selected, never probed, and cannot be enabled by `env`, RPC,
  configuration or a UI toggle. `HPOS_LINUX_EXECUTOR=on` therefore does **not**
  try WSL on Windows; it reports `no-backend-adapter-for-platform`. Nothing
  installs, enables, pulls or starts anything, ever.

`publicLinuxCapabilities()` is the only shape that leaves the process: a fixed
key set, closed-set values, capped strings, and `isolation.shell: false` forced
by construction. A capability record can never smuggle a path, a command line,
an environment value or a credential into `RT_STATUS`.

## Service → executor model

A Linux task is not "run this on Linux"; it is "**run this service**, which is
registered on the Linux executor":

| Service | Executor | Status |
| --- | --- | --- |
| `stub` | `native` | Steps 1–4 lifecycle stub, unchanged |
| `linux-stub` | `linux` | Step 5 boundary proof: a supervised child that does nothing |
| `future-python`, `future-ffmpeg`, `future-git`, `future-deepseek` | `linux` | **placeholders only** — `PLANNED_SERVICES` in `runtime/executors.js`, deliberately *not* registered, so they cannot be run |

`RT_TASK_RUN` accepts `{ service, durationMs, timeoutMs, note }`. It has **no**
field for an executable, a command, a shell string, a URL, a working directory
or an environment — and `executor` is one of the fields the picker drops, so a
caller cannot choose a backend. The service table decides; `assertExecutorMatch`
refuses a direct caller that tries to promote or downgrade a service anyway.

Adding a real Linux-backed service later means: one row in `SERVICES`
(`executor: 'linux'`, a fixed `execMode`), the mode's behaviour in the runner's
closed table, and a capability claim in `capabilities.js`. **No change to the
supervisor, the transport, the workspace model or the RPC allowlist.**

## The boundary, end to end

For `RT_TASK_RUN { service: "linux-stub" }` on a Linux host:

1. `actions.js` picks the whitelisted fields only.
2. `tasks.js` resolves `service → executor` and asks the router whether that
   executor is available. **Unavailable → `RT_EXECUTOR_UNAVAILABLE` with the
   detection reason, before a task record exists.** Never a silent fallback to
   native execution.
3. The registry schedules the task and calls `backend.run(spec)`.
4. `backend.run` hands the spec to the shared supervisor (`supervisor.start`),
   which asks the backend for a plan.
5. `launcher.js` builds it: `argv = [<daemon interpreter>, heap flags, runner.js]`
   — fixed constants, no caller text — with the workspace gate below and the
   scrubbed environment after that.
6. `supervisor.js` **validates the plan** before a child can exist: the
   interpreter must be the daemon's own, argv must be short plain strings, no
   shell, three pipes, cwd must be exactly this task's workspace, no
   sensitive-named env var, and caps may shrink but never grow. A refused plan
   is an ordinary synchronous failure with a counted `plansRefused`.
7. From there it is all Steps 1–4 machinery: `QUEUED → RUNNING → terminal`,
   timeout timer, SIGTERM → SIGKILL escalation, `task.*` events on the bus,
   Runtime Activity rows, shutdown drain, workspace cleanup. There is no second
   supervisor and no second event channel.

### Workspace

`assertLinuxWorkspace()` is an extra gate in front of the existing
`workspace.js` model, never a replacement for it: one directory per task, named
after the taskId, under the runtime state root (`~/.hpos/runtime/workspaces`),
`0700`, ownership marker verified, realpath-checked against symlink swaps, and
removed when the task settles. It refuses: the workspace root itself, the
repository, the runtime package directory, the daemon's cwd, another task's
directory, a path that was not computed from a task id, a non-directory, and a
directory without our marker. **No RPC field is ever a path**, and the Linux
backend never lists, browses or exposes the filesystem to the UI.

### Environment

`launcher.js` starts from `sanitizeEnv` (allowlist by name, sensitive names and
runtime-hijacking names blocked) and then tightens further for Linux tasks:

- `SHELL`, `TERM`, `COMSPEC`, `PATHEXT`, `NUMBER_OF_PROCESSORS` are dropped — a
  Linux task is never given a shell to reach for;
- `HPOS_EXECUTOR=linux`, `HPOS_ENGINE`, `NO_COLOR`, `HPOS_WORKSPACE_POLICY` are
  set by the daemon (fixed keys, fixed values);
- every remaining **value** is scanned against the runtime's own credential, so
  a token parked under a harmless name (`USER=<token>`) is removed too;
- the report is names, counts and reasons. Nothing in this path can return or
  log a value, and the supervisor logs only `envKeys`/`envDropped` counts.

## Windows development compatibility

Steps 1–4 keep working, unchanged, on Windows:

- the daemon starts without any Linux present;
- native tasks (`stub`) spawn, time out, cancel and drain exactly as before —
  the native plan is computed by the supervisor itself, and the Step 1–4 code
  path is literally the same call (`supervisor.start(spec)` with no backend);
- `RT_STATUS.linux` reports `available: false` with `reason:
  no-backend-adapter-for-platform` — an answer, not an error, not a warning,
  not a crash;
- `linux-stub` is refused politely at `RT_TASK_RUN`;
- nothing is installed, enabled or suggested. There is no WSL workflow, no
  download, no setup wizard, and no "Linux settings panel".

## Runtime Activity (the whole of the Linux UI)

One row in the existing popover, fed only by `RT_STATUS`:

```
● Runtime connected
● Linux        Available (partial)   [backend-adapter-ready]
● Linux        Unavailable           [no-backend-adapter-for-platform]
```

Labels and wording come from `src/lib/bridge/linuxStatus.js`, never from the
runtime's strings — the page validates the closed sets and renders `Unknown` for
anything else, and goes back to `Unknown` when the runtime is unreachable
instead of showing a stale verdict. Active/recent task rows may carry a tiny
`linux` tag (the executor name, allowlisted to `native`/`linux` upstream).
There is **no** Linux terminal, no Linux desktop surface, no install UI, no
command input, and no output pane.

## Security boundary

Step 5 adds no new way to make a process, read a file or reach a network.
Specifically absent, and asserted by `tests/linux.test.mjs` at source level:

- no arbitrary command, script, executable path, argument list or shell string
  anywhere in the Linux path;
- no `child_process`, `spawn`, `exec`, `eval`, `new Function`, dynamic `import`
  or `fetch` in `runtime/linux/*.js`;
- no generic subprocess or "run this in Linux" RPC action — the allowlist is
  still exactly `PING`, `RT_STATUS`, `RT_TASK_RUN`, `RT_TASK_STOP`;
- no caller-supplied working directory or environment (the plan's cwd must be
  the task workspace; caps can only shrink);
- no credentials, cookies or environment values in status, events, logs or the
  UI; the runtime token is also scanned **by value** out of a Linux child's
  environment;
- no remote or LAN access (the transport is unchanged, loopback-only);
- no WSL/Docker/VM installation or enablement workflow;
- no SSRF: nothing in this path opens a socket.

Linux remains an internal execution capability reached only through a registered
service — never a feature the user or a page can drive.

## Not implemented here (by design)

DeepSeek (any part of it), Python, FFmpeg, Git, Docker, a connector router,
Tauri packaging, a Linux desktop environment, WSL/VM auto-installation, remote
runtime support, and any real Linux workload. `linux-stub`'s child runs the
same fixed mode table as the native stub and does nothing.

The browser bridge, `DeepSeekConnector`, the extension and the existing DeepSeek
browser workflow are untouched and remain the browser path.
