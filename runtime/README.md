# HPOS Runtime — Step 6 browser-based AI execution

A local execution layer for HPOS. The daemon listens **only on `127.0.0.1`**,
uses authenticated HPOS envelopes, and runs every task in a supervised child
process with the existing timeout, cancellation, environment, workspace and
output bounds.

Step 6 adds one real, fixed-purpose service: `browser.deepseek`. The runtime
owns admission and lifecycle while the DeepSeek-specific browser provider stays
isolated under `runtime/browser/providers/deepseek/`. There is still no shell,
generic browser endpoint, DeepSeek API, cookie import, credential extraction or
automatic retry.

```
HPOS Chat ── LocalRuntimeBridge ──▶ Vite dev proxy ──▶ hpos-runtime daemon
        same HPOS envelopes; credential stays on the dev host       │
                                                                    ├─ GET /health
                                                                    ├─ POST /rpc
                                                                    └─ GET /events (SSE)
                                                                        │
 task registry: QUEUED → RUNNING → GENERATING → STREAMING → terminal
        │
        └─ service → executor → backend                       (Step 5)
                        │          ├─ native: stub, browser.deepseek
                        │          └─ linux: linux-stub (capability-gated)
                        ▼
              one shared process supervisor
              validated plan, workspace, scrubbed env, timeout/kill chain
                        ▼
                  fixed runner child
                        ├─ closed lifecycle/Linux probe modes
                        └─ fixed provider router → DeepSeek page in the user's
                                                   visible Chromium CDP session
                        │
              allowlisted progress/final task events over SSE ──▶ HPOS Chat
```

The existing extension BrowserBridge/DeepSeekConnector remains in the
repository for compatibility, but HPOS AI Chat now uses the runtime service as
its primary execution path.

## Supported browser/session mechanism

HPOS attaches to a **user-started, visible Chromium browser** on loopback CDP
(default `127.0.0.1:9222`). Use a dedicated profile, open exactly one DeepSeek
chat, and authenticate normally in the visible browser. For example on Linux:

```bash
chromium --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.hpos/deepseek-browser"
# or use google-chrome with the same two flags
```

Then open `https://chat.deepseek.com/` and sign in normally. HPOS does not fill
login forms, read password values, inspect CAPTCHA contents, read browser
storage, call cookie APIs, copy session material, launch a browser, or close the
user's browser. If the browser is absent, login is required, verification is
present, no supported page is open, or more
than one candidate page is open, the task fails with an explicit safe state and
is never resent.

`playwright-core` is protocol transport only; it does **not** download or
install Chromium. Run `npm install` in `runtime/` once. The operator may change
only the fixed loopback CDP port with `HPOS_DEEPSEEK_CDP_PORT`; callers cannot
supply a host, URL, selector, browser method or executable.

## Architecture: the daemon supervises, the child executes

Task code never runs inside the daemon's event loop. `runtime/supervisor.js`
spawns exactly one child per task, and the child (`runtime/runner.js`) is the
only thing that "does" anything. A blocked, crashing or misbehaving task can
therefore never hang or take down the RPC server that answers `RT_STATUS`.

```
RT_TASK_RUN ─▶ registry (QUEUED)
                │  admits against maxActive, then releases the RPC call
                ▼
             supervisor.start()
                ├─ capacity guard          (maxConcurrent children)
                ├─ create task workspace    (workspace.js)
                ├─ sanitize the environment (env.js)
                └─ spawn: [node, --max-old-space-size=N, runner.js]
                      │   detached on POSIX (own process group)
                      │   spec arrives on stdin, never in argv
                      ▼
                   RUNNING ──▶ GENERATING ─▶ STREAMING ─▶ COMPLETE
                          ──▶ exit ≠ 0      ─▶ FAILED  (named safe cause)
                          ──▶ spawn error   ─▶ FAILED  (SPAWN_FAILED)
                          ──▶ timeout hit   ─▶ FAILED  (TIMEOUT)
                          ──▶ RT_TASK_STOP  ─▶ CANCELLED
                      ▼
                   settle(once) ─▶ dispose workspace ─▶ outcome to the registry
```

Hard rules this layer is built around:

- **Fixed argv.** The child is launched as
  `<process.execPath> --max-old-space-size=N runtime/runner.js`. No task text,
  no path, no id, no payload ever reaches the
  command line, so `ps` shows nothing interesting. There is no `shell: true`
  anywhere in this codebase.
- **No general-purpose endpoint.** There is no action that accepts a command,
  executable path, URL, selector or browser method. `RT_TASK_RUN` selects only
  `stub`, capability-gated `linux-stub`, or `browser.deepseek`; the browser route
  accepts prompt + bounded correlation ids and nothing else.
- **Closed behaviour set.** `runner.js` implements fixed internal modes
  (`noop`, `sleep`, `hang`, `fail`, test probes, and `browser-provider`) and
  refuses anything else. `browser-provider` independently seals its stdin spec
  and routes only the source-registered `deepseek` module. No task-supplied
  import, eval, shell or provider name is interpreted.
- **One process per task, ever.** A task that fails stays failed: nothing is
  re-sent, re-queued or restarted. Its record keeps `attempts: 1`.
- **Never reject, always settle.** `supervisor.done` resolves for every path,
  including spawn failure, so a task cannot be stranded in RUNNING.

## Run

```bash
cd runtime
npm install               # playwright-core transport; installs no browser
npm start                 # or: node bin/hpos-runtime.js
```

The daemon prints its bound port, the endpoint file location, the workspace
root and the executor's timeout ceiling, then waits. Stop it with `Ctrl+C`
(SIGINT) — it cancels its children, waits for them to leave, removes their
workspaces and releases the endpoint file on the way out.

Environment:

| Var | Default | Meaning |
| --- | --- | --- |
| `HPOS_RUNTIME_PORT` | `5190` | TCP port (always 127.0.0.1; `0` = ephemeral, mostly for tests) |
| `HPOS_RUNTIME_HOME` | `~/.hpos/runtime` | State dir (endpoint file, task workspaces) |
| `HPOS_RUNTIME_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `HPOS_RUNTIME_MAX_ACTIVE_TASKS` | `16` | Concurrent tasks; the 17th is `RT_QUEUE_FULL` (clamped to 1–64) |
| `HPOS_RUNTIME_TASK_TIMEOUT_MS` | `120000` | Default per-task wall-clock timeout |
| `HPOS_RUNTIME_MAX_TASK_TIMEOUT_MS` | `600000` | Longest timeout a task may ask for |
| `HPOS_RUNTIME_KILL_GRACE_MS` | `1500` | SIGTERM → SIGKILL escalation window (0–30000) |
| `HPOS_RUNTIME_MAX_OUTPUT_BYTES` | `65536` | Per-stream captured output cap (1 KB–1 MB) |
| `HPOS_RUNTIME_MAX_OLD_SPACE_MB` | `512` | V8 heap ceiling for each task child (64–8192) |
| `HPOS_RUNTIME_TASK_WORKSPACE_ROOT` | `<stateDir>/workspaces` | Where task dirs live; **must be outside the repository** |
| `HPOS_RUNTIME_TASK_WORKSPACE_KEEP` | off | `1` retains workspaces after a run, for debugging |
| `HPOS_DEEPSEEK_CDP_PORT` | `9222` | Dedicated user Chromium CDP port; host is always `127.0.0.1` |

Every value is clamped: the environment can move a number inside its window, it
can never remove a bound.

## Endpoints

### `GET /health`

No auth. Liveness only — never contains the token, task data or executor config.

```json
{ "status": "up", "name": "hpos-runtime", "version": "0.1.0", "uptimeMs": 1234, "time": "…" }
```

### `POST /rpc`

Requires the header `X-HPOS-Token: <token>` (timing-safe compared). Body is a
single JSON envelope — the same shape the browser bridge uses
(`channel: "hpos-bridge"`, `type: "HPOS_REQUEST"`, `action`, `requestId`,
`payload`):

```json
{ "channel": "hpos-bridge", "type": "HPOS_REQUEST", "action": "PING", "requestId": "…", "payload": null, "ts": 0 }
```

Responses are envelopes too (`success`, `payload` or `error: {code, message}`,
`requestId` echoed) with HTTP `200`; transport-level failures (auth, shape,
size, content-type) are flat `{ error: { code, message } }` with `4xx`.

Body must be `application/json`, capped at ~264 KB.

### `GET /events`

Authenticated Server-Sent Events stream for allowlisted lifecycle events and
bounded DeepSeek assistant response delivery.

- Requires the **same** `X-HPOS-Token` header as `/rpc` (timing-safe
  comparison). The token is **never** accepted in the URL/query string, and
  the browser never holds it: in dev, `EventSource` connects to the
  same-origin route `/hpos-runtime/events` and the Vite proxy injects the
  header server-side, exactly like `/rpc`.
- CORS behaves exactly like `/rpc`: origin-allowlisted, `Vary: Origin`, never
  `*`. A request with no/foreign `Origin` gets no CORS headers.
- SSE headers: `Content-Type: text/event-stream; charset=utf-8`,
  `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`.
- The daemon writes a `: …` comment heartbeat every 15 s so proxies/browsers
  cannot mistake a quiet stream for a dead one (test-tunable).
- The number of simultaneous event clients is **bounded** (`maxEventClients`,
  default 12); beyond it a new client is refused with
  `503 RT_EVENTS_BUSY` instead of accumulating unbounded sockets.
- Disconnected clients are removed immediately (socket close), and the
  heartbeat stops when the last client leaves.

Each SSE frame is an event envelope (see *Runtime events* below):

```text
id: 17
data: {"channel":"hpos-runtime-events","id":17,"type":"task.completed","ts":…,"taskId":"task-…","payload":{…}}
```

## Runtime events (M1 Step 4)

A small **explicit event allowlist** with a stable envelope. Events contain no
commands, prompts, paths, environment, browser/session data or credentials.
Step 6 adds only bounded, visible **assistant response text** to the dedicated
`task.streaming`/`task.completed` payloads so HPOS Chat can render the answer;
the Linux Activity model deliberately discards that text.

Envelope (JSON, one per SSE `data:` line):

```json
{ "channel": "hpos-runtime-events", "id": 17, "type": "task.completed", "ts": 1720000000000, "taskId": "task-…", "payload": { "taskId": "task-…", "service": "stub", "durationMs": 42 } }
```

`channel` is always `hpos-runtime-events`; `id` is a strictly increasing
integer (used for `Last-Event-ID` and client deduplication); `ts` is a
timestamp; `taskId` appears on task events only; `payload` is allowlisted per
type — every other input field is dropped before the event exists.

| Type | Payload | Meaning |
| --- | --- | --- |
| `runtime.started` | `{ pid, version }` | the daemon finished starting |
| `runtime.stopped` | `{ reason: "shutdown" \| … }` | the daemon is stopping |
| `runtime.status` | `{ status, pid, uptimeMs, tasks{…}, active[…], metrics{…} }` | snapshot/counters/metrcis |
| `task.queued` | `{ taskId, service, correlationId? }` | task admitted to the queue |
| `task.started` | `{ taskId, service, correlationId? }` | a supervised child was spawned |
| `task.generating` | `{ taskId, service, correlationId, sequence }` | DeepSeek confirmed one send and began generating |
| `task.streaming` | `{ taskId, service, correlationId, sequence, op, text }` | bounded visible assistant-text patch |
| `task.completed` | `{ taskId, service, durationMs, correlationId?, response? }` | child exited 0; browser task includes final answer |
| `task.failed` | `{ taskId, service, kind, code?, exitCode, correlationId? }` | named non-timeout failure |
| `task.cancelled` | `{ taskId, service, reason, correlationId? }` | cancelled (user or shutdown) |
| `task.timeout` | `{ taskId, service, timeoutMs, correlationId? }` | terminal TIMEOUT failure |

Failure `kind` is drawn from the same closed set the supervisor records
(`NONZERO_EXIT`, `SPAWN_FAILED`, `TERMINATED`, `RUNNER_FAILURE`,
`WORKSPACE_ERROR`, `CAPACITY`, `INTERNAL`, …). Messages that could carry a
path are **not** published.

**Exactly-once terminals.** A task emits one terminal event — `completed`,
`cancelled`, or `timeout`/`failed` — and never more than one. The registry
guards the transition, and a late child-process outcome (the kill settling
after a cancel, a slow exit after a timeout) can never produce a second
terminal event; the tests assert this.

**History/reconnect.** The bus keeps only a **bounded in-memory** recent-event
ring (default 128 events, configurable) — nothing is written to disk and the
buffer cannot grow without a bound.

- A new client receives the buffered snapshot, then a fresh `runtime.status`
  convergence event with current counters/active tasks/metrics.
- `Last-Event-ID` is honoured when the requested history is still in the
  buffer (only newer events are replayed). When the requested history is no
  longer available the client simply gets the safe `runtime.status` resync —
  never an error and never a fabricated history.
- The browser client replays through the same path on reconnect and
  deduplicates by event id, so overlaps are harmless.

**Publisher boundary.** Task code publishes through `runtime/events.js` (an
event bus); the registry never knows about HTTP or SSE clients. The SSE
transport subscribes to the bus. `runtime.status` is produced by the daemon
from allowlisted counters + safe process metrics; it is never a serialization
of internal task records.

## Process metrics (Step 4)

`runtime.status` payloads include a `metrics` object with **only** the daemon's
own safe numbers: `pid`, `cpu: { userUs, systemUs }` and
`memory: { rssBytes, heapUsedBytes, heapTotalBytes }` (all from
`process.cpuUsage()` / `process.memoryUsage()`). No process lists, no command
lines, no environment, no paths, no network state.

A metric is reported as `null` (UI shows “unavailable”) when it cannot be
measured reliably on the current platform — the daemon never invents a value.
CPU/memory above are process-wide daemon values; per-child CPU/memory are not
reported because they are not reliable cross-platform without extra tooling.

## Supported actions (allowlist — nothing else is executed)

| Action | Purpose | Response payload |
| --- | --- | --- |
| `PING` | liveness + protocol version | `{ version, engine: "hpos-runtime", uptimeMs, now }` |
| `RT_STATUS` | runtime, task **and executor** status; optional `{ taskId }` for one task record | `{ status, version, services, browserProviders, tasks, executor, capabilities, capabilityNotes, linux, recent, task? }` |
| `RT_TASK_RUN` | enqueue a registered supervised task | `{ taskId, status: "QUEUED", service, correlationId? }` · `stub` / `linux-stub`: `{ service, durationMs?, timeoutMs?, note? }`; DeepSeek: `{ service: "browser.deepseek", prompt, correlationId, conversationId, messageId, timeoutMs? }` |
| `RT_TASK_STOP` | cancel an active task (kills its child) | `{ taskId, status: "CANCELLED" }` · payload: `{ taskId }` |

`RT_TASK_RUN` copies only service-specific fields. `mode`, `command`, `cwd`,
`env`, `execPath`, `shell`, `executor`, URL and selector hints are dropped before
the executor sees them; credential/session/CAPTCHA-shaped keys are rejected
outright with `RT_SECRET_FIELD_REJECTED`. The closed service table alone decides
what the child does **and which backend runs it** (Step 5). A service registered
on the Linux executor is refused with `RT_EXECUTOR_UNAVAILABLE` (carrying the
detection reason) when no Linux backend adapter exists here; it is never quietly
re-run on the native backend.

Unknown actions (including bridge `DS_*` actions, `EVAL`, `SCRAPE`,
`GET_COOKIES`, and every invented `RT_TASK_EXEC`/`RT_SPAWN`/`RT_FETCH` style
name) are rejected with `UNKNOWN_ACTION`. Error codes: `RT_UNAUTHORIZED`,
`RT_INVALID_REQUEST`, `RT_BODY_TOO_LARGE`, `RT_INVALID_CONTENT_TYPE`,
`UNKNOWN_ACTION`, `RT_INVALID_PAYLOAD`, `RT_UNKNOWN_SERVICE`, `RT_QUEUE_FULL`,
`RT_DUPLICATE_TASK`, `RT_PROVIDER_BUSY`, `RT_SECRET_FIELD_REJECTED`,
`RT_TASK_NOT_FOUND`, `RT_TASK_NOT_CANCELABLE`, `RT_EXECUTOR_UNAVAILABLE`, and
(Step 5) `RT_UNKNOWN_EXECUTOR` / `RT_WORKSPACE_REFUSED`. The executor/workspace
codes are refusals, never capabilities. Browser task failures include
`BROWSER_UNAVAILABLE`, `AUTH_REQUIRED`, `CAPTCHA_REQUIRED`, `UNSUPPORTED_PAGE`,
`AMBIGUOUS_SESSION`, `PROVIDER_BUSY`, `SEND_FAILED`, `RESPONSE_NOT_DETECTED`,
`BROWSER_TIMEOUT`, and `BROWSER_INTERRUPTED`.

## Task state machine

Stub tasks retain `QUEUED → RUNNING → COMPLETE`. Browser tasks add the visible
AI phases `QUEUED → RUNNING → GENERATING → STREAMING → COMPLETE`; `FAILED` and
`CANCELLED` are terminal from any active state:

| Transition | Cause |
| --- | --- |
| `QUEUED → RUNNING` | admission fired and a supervised child was spawned |
| `RUNNING → GENERATING` | DeepSeek confirmed the one submit gesture |
| `GENERATING → STREAMING` | first visible final-answer text arrived |
| active → `COMPLETE` | child exited 0 with a bounded result |
| active → `FAILED` | named provider/process/timeout/workspace failure |
| `QUEUED → CANCELLED` | stopped before spawn; no process is made |
| running phase → `CANCELLED` | supervisor terminates the child; provider best-effort clicks visible Stop |

`FAILED` carries a machine-readable `failure.kind`: `NONZERO_EXIT`,
`SPAWN_FAILED`, `TIMEOUT`, `TERMINATED`, `RUNNER_FAILURE`, `WORKSPACE_ERROR`,
`CAPACITY`, `INTERNAL`. A cancelled-then-killed task stays `CANCELLED`: the
late outcome from the child records facts (`processEndedAt`, `exitCode`) but can
never move a terminal task. `RT_STATUS` exposes the whole record — `pid`,
`exitCode`, `exitSignal`, `timedOut`, `timeoutMs`, `resources`,
`workspaceDir`, `workspaceRemoved`, `history`.

The registry refuses to run anything when it has no supervisor
(`RT_EXECUTOR_UNAVAILABLE`) rather than quietly falling back to executing a task
in the daemon. That refusal is the guarantee above, enforced in code.

## Per-task workspaces

Each task gets exactly one directory — `<stateDir>/workspaces/<taskId>` — and
becomes a child of nothing else:

- created **before** the spawn, and passed as the child's `cwd`, so a task can
  never inherit the daemon's directory (the repository);
- one directory per task, never shared: a collision on a reused id fails the
  task instead of merging two runs;
- holds our marker file `.hpos-workspace.json` naming the task;
- removed when the task settles — completed, failed, cancelled or timed out.

Cleanup only deletes a path that passes three checks: the directory name is a
well-formed task id, its realpath is a direct child of the workspace root, and
our marker inside it names that same task. Anything else is *refused* and
reported (`refused:marker-mismatch`, `refused:not-a-real-directory`, …) rather
than deleted — so a symlink swap or a corrupt record cannot turn cleanup into a
recursive delete of something outside the workspace. Two further guards:
`HPOS_RUNTIME_TASK_WORKSPACE_ROOT` pointing inside the repository is rejected at
startup, and the root itself is only ever pruned when it is empty (`rmdir`,
never `rm -r`).

A task that chmods its own directory read-only can survive cleanup; that shows
up as `workspaceCleanup.reason: "rm-failed"` and a non-empty workspace root,
never as a silent success.

## Environment sanitization

The child is **not** given the daemon's environment. `env.js` builds it from an
explicit allowlist (`PATH`, `HOME`, `TMPDIR`, `LANG`, `TZ`, and on Windows
`SystemRoot`, `USERPROFILE`, `TEMP`, `PATHEXT`, …) plus a couple of fixed
daemon-owned extras (`NO_COLOR`, `HPOS_ENGINE`). Name matching is
case-insensitive on Windows and case-sensitive elsewhere.

Two extra nets, so the allowlist is never the only defence:

- any name that looks sensitive (`*TOKEN`, `*SECRET`, `*PASSWORD`, `*KEY`,
  `*CREDENTIAL*`, `*COOKIE`, `*SESSION*`, …) is dropped **even if it were
  allowlisted**;
- interpreter-hijacking names (`NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`,
  `DYLD_INSERT_LIBRARIES`, `BASH_ENV`, `SSH_AUTH_SOCK`, `GIT_CONFIG_GLOBAL`, …)
  are blocked outright, so a child cannot be steered into loading something.

The result is reported as **names and counts only** — `kept`, `dropped`,
`droppedSensitiveCount`. Values never enter the report, the daemon logs the
counts and nothing else, captured task output is never logged, and the task
spec travels on stdin instead of the command line. `inspect-env` mode exists so
the tests can assert from *inside a real child* that `PATH` arrived and
`GITHUB_TOKEN`-shaped names did not.

## Timeouts and cancellation

- Every task has a bounded wall-clock timeout: `timeoutMs` from the payload, or
  the configured default, always inside `[minTimeoutMs, maxTimeoutMs]`. There is
  no such thing as an unbounded task — `0` and out-of-range values are refused
  with `RT_INVALID_PAYLOAD`.
- On expiry the supervisor escalates: **SIGTERM first** (the runner flushes a
  `terminated` result line and exits 143), then **SIGKILL** after
  `killGraceMs` if the child is still alive. A task that ignores SIGTERM is
  still ended; the record distinguishes `graceful: true` from `forceKilled: true`.
- On POSIX the signal goes to the child's **process group**, so helpers a task
  spawned go with it.
- Cancellation is **idempotent inside the supervisor**: the transition to
  `CANCELLED` happens once, and a repeated internal `supervisor.cancel()` is a
  no-op. A repeated public `RT_TASK_STOP` receives
  `RT_TASK_NOT_CANCELABLE`, making the already-terminal state explicit.
- Daemon shutdown (`SIGINT`/`SIGTERM`) cancels every live task, waits for the
  children to exit, force-kills whatever does not, and only then closes the
  listener. `process.on('exit')` fires one last synchronous SIGKILL sweep.
- **Orphan guard:** the child treats the end of its stdin pipe as "the daemon is
  gone" and exits itself (code `170`). If the daemon is `SIGKILL`ed — no handler
  runs at all — its tasks still disappear within a few hundred ms.

## Concurrency

Admission is checked at enqueue time against `maxActive`: while that many tasks
are in any active phase, `RT_TASK_RUN` returns `RT_QUEUE_FULL`. The
`browser.deepseek` route has an additional per-provider limit of one active task
and returns `RT_PROVIDER_BUSY` rather than creating ambiguous browser work. The queue is
bounded — there is no backlog to grow, so a caller that wants more concurrency
gets an error, not a hidden queue. The supervisor independently refuses to hold
more than `maxConcurrent` live children (a task so refused `FAILED`s with
`CAPACITY`), which bounds process count even if a future service bypasses the
registry. Records older than 512 are evicted, active ones never are.

## Platform capabilities

Resource limiting is modelled as a *capability*, reported honestly by
`RT_STATUS.capabilities` rather than assumed:

| Capability | Linux / macOS | Windows |
| --- | --- | --- |
| one child process per task | enforced | enforced |
| wall-clock timeout + kill chain | enforced | enforced |
| V8 heap cap (`--max-old-space-size`) | enforced | enforced |
| output volume cap | enforced | enforced |
| graceful SIGTERM handling | enforced (the task can catch it) | nominal — `TerminateProcess` is immediate |
| process-group kill (reaps grandchildren) | enforced | **not available** (no POSIX groups) |
| `RLIMIT` via `prlimit` | **not enforced** | not applicable |
| Job Objects (CPU/memory/tree) | n/a | **not enforced** |
| workspace disk quota | measured, not enforced | measured, not enforced |

The two "not enforced" rows are deliberate. `prlimit` only applies limits
*after* spawn, which races the very workload it should bound, and Job Objects
need a native helper — so rather than pretend, the daemon reports
`supported: false` with the reason in `capabilityNotes`. On Windows the report
says so explicitly (no group-kill claim), and the code never calls
`process.kill(-pid, …)` there. `useGroups`/`detached` are decided from
`process.platform`, and no desktop environment, container or VM is assumed or
required anywhere.

## Linux execution backend (M1 Step 5)

An **invisible, background execution capability** — not a desktop environment,
not a terminal, not a shell. Step 5 installs the architecture that lets a future
feature ask for Linux tooling through one registered service row.

```
RT_TASK_RUN { service } ─▶ service → executor ─▶ backend router ─┬─ native ─┐
        (capability-gated)                                       └─ linux ─┴─▶ ONE supervisor
```

- **Detection, not assumption.** `runtime/linux/capabilities.js` separates *"this
  is a Linux host"* from *"a usable Linux backend exists"*. Only
  `platform === 'linux'` plus a passing probe from an **implemented** adapter
  (`host-linux`) yields `available: true`, and it yields `support: "partial"` —
  no namespaces, no privilege drop, no network isolation, so `full` would be a
  lie. win32/darwin report `available: false` with
  `reason: "no-backend-adapter-for-platform"`. That is a normal answer: the
  daemon starts, native tasks keep working, nothing is installed, enabled or
  suggested. `wsl`, `docker` and `vm` adapters are declared
  `implemented: false` and can never be selected — not by env
  (`HPOS_LINUX_EXECUTOR=on` included), not by RPC, not by configuration.
- **Safe reporting.** `RT_STATUS.linux` is the output of
  `publicLinuxCapabilities()`: a fixed key set (`available, support, platform,
  isLinuxHost, executor, adapter, reason, services, isolation, notes`),
  closed-set values, capped strings, and `isolation.shell: false` forced. No
  path, command line, environment value or credential can be published through
  it, and a capability record cannot talk its way into a wider shape.
- **One service proves the boundary.** `linux-stub` is a registered Linux
  service whose child does nothing (same fixed mode table as `stub`, plus the
  booleans-only `inspect-linux` probe). `future-python`, `future-ffmpeg`,
  `future-git` and `future-deepseek` are placeholders in `PLANNED_SERVICES`,
  explicitly **not** registered and not runnable.
- **Supervision is reused, not duplicated.** The Linux backend has
  `detectCapabilities / isAvailable / plan / run / stop / getStatus`, but
  `run()` delegates to the shared `supervisor.start()` and `stop()` to
  `supervisor.cancel()`. Timeout, cancellation, shutdown drain, exit
  classification, the `task.*` events and Runtime Activity rows therefore all
  work for a Linux task with no Linux-specific code. The supervisor **validates
  every plan** before a child exists: the daemon's own interpreter only, a short
  plain-string argv, no shell, three pipes, cwd exactly the task workspace, no
  sensitive env name, and caps that may shrink but never grow.
- **Workspace + environment are the same guarantees, tightened.** Linux tasks
  pass `runtime/linux/workspace.js` on the way in (per-task directory under the
  runtime state root, marker + realpath verified, never the repository, never
  the daemon cwd, never a caller-supplied path) and get `sanitizeEnv` output
  minus `SHELL`/`TERM`/`COMSPEC`/`PATHEXT`, plus a **value-level** scan that
  removes the runtime token even under a harmless variable name. Reports are
  names and counts; values are never logged.
- **UI:** one Linux row in Runtime Activity (`Linux  Available (partial)` /
  `Unavailable`), fed only by `RT_STATUS`, with client-owned wording. No Linux
  terminal, page, panel or install flow.

Full details, the state table and the security list: `runtime/linux/README.md`.

## Authentication

- On start the daemon writes `endpoints.json` **outside the repository**, at
  `~/.hpos/runtime/endpoints.json` (or `$HPOS_RUNTIME_HOME`):
  `{ version, host: "127.0.0.1", port, pid, token, protocol, startedAt }`
  — file mode `0600`, directory mode `0700`.
- The token is 256 bits of `crypto.randomBytes` hex. It is **never** returned
  by the daemon (not in `/health`, not in RPC responses, not in logs — the
  logger scrubs secret-looking keys), and it is never accepted in URLs.
- A client gets the token out-of-band (in dev: the local dev proxy / desktop
  host reads the file on the same machine) and sends it in the header.
- If a **live** process already owns the same port (endpoint file with a
  living pid), a new daemon refuses to start instead of stealing the token.
  Stale files (dead pid / corrupt) are replaced.
- On clean shutdown the daemon deletes the file — but only if it still holds
  its own token.

## Web UI integration (M1 Steps 3–4)

During `npm run dev` from the repository root, Vite exposes only these
same-origin development routes:

- `GET /hpos-runtime/health` — proxied to runtime `/health`; liveness only.
- `POST /hpos-runtime/rpc` — proxied to runtime `/rpc`; the proxy reads the
  local endpoint file and injects `X-HPOS-Token` on the server side.
- `GET /hpos-runtime/events` — proxied to runtime `/events` (SSE); same
  server-side token injection, GET only, streaming passthrough.

The proxy target is fixed to `127.0.0.1` and accepts only those three routes;
it is not a generic forwarding endpoint. `src/lib/bridge/LocalRuntimeBridge.js`
knows only those fixed browser routes, uses the existing HPOS envelope shape,
and never receives the credential. Runtime status is `connected` only after an
authenticated `PING` and `RT_STATUS`; a successful `/health` check cannot claim
RPC connectivity. The header chip uses conservative polling and distinguishes
`unknown`, `checking`, `connected`, `disconnected`, `unauthorized`, and `error`.

### Runtime Activity UI (purpose and non-goals)

The small **Runtime Activity** popover (open the header chip) shows what the
invisible runtime is doing: connection state, live event-stream state, the
current active tasks (`taskId`, `stub`/`linux-stub`/`browser.deepseek` service,
the closed executor label when known, and
`QUEUED`/`RUNNING`/`GENERATING`/`STREAMING`, with a **Stop** action for known
active task ids), the safe Linux capability row, a bounded `Recent` list of
terminal tasks, basic counters, and safe process metrics
(`pid`, `uptime`, active/queued counts, CPU and memory — `unavailable` when a
platform cannot provide them reliably). Stop calls `RT_TASK_STOP` through the
existing bridge for a task id already in the active set — never from raw user
text — and the UI updates from server events/status, never by assuming the
stop succeeded.

**This Activity UI is deliberately NOT a terminal.** It shows no shell, no
command strings, no raw process output, no environment variables, no
credentials and no filesystem internals. Dedicated chat response fields are
consumed only by the chat adapter and discarded by the Activity controller. Its
only job is answering *“what is the invisible HPOS runtime doing?”*, not
*“give me a Linux terminal.”*

Client-side, `RuntimeEventStream` (EventSource over `/hpos-runtime/events`)
reconnects with conservative capped backoff, ignores malformed/unknown
messages, deduplicates by event id, and cleans up listeners/timers on close.
`RuntimeActivityController` keeps the bounded activity state; nothing about
runtime activity is written to `localStorage` (it is live state, not
conversation data).

The checked-in web transport integration uses the Vite development proxy. A
future packaged desktop host can provide the same fixed same-origin routes; no
remote runtime deployment is defined here.

## Tests

Plain Node assert scripts, same style as the rest of the repo — no framework,
no network, temp dirs only (never touch the real `~/.hpos`). The supervisor and
lifecycle suites spawn **real** child processes and assert on real pids:

```bash
cd runtime
npm test
```

- `tests/protocol.test.mjs` — envelope contract + allowlist (bridge `DS_*` and
  every exec/shell-shaped `RT_*` name rejected, four actions and no more)
- `tests/endpoints.test.mjs` — token file creation, `0600`/`0700` permissions,
  live-pid refusal, stale/corrupt replacement, release semantics
- `tests/limits.test.mjs` — clamping of every configured bound, the public
  timeout window, and capability reporting for linux / darwin / win32 /
  freebsd (win32 branch tested by injection, not by owning a Windows box)
- `tests/env.test.mjs` — allowlist behaviour, sensitive + blocked names, Windows
  case-insensitivity, and that no value ever reaches the report
- `tests/workspace.test.mjs` — root safety guards, per-task isolation, the three
  cleanup proofs, symlink and marker-mismatch refusals, `keep`, prune-only-empty
- `tests/linux.test.mjs` — Step 5 units: capability detection for linux/win32/
  darwin/unknown/disabled/probe-failed (all by injection, so no Linux required),
  the safe RT_STATUS projection, the service → executor rules, the workspace
  gate, the launch plan (fixed argv, env drops, credential-by-value scan), the
  backend interface, the router's refusals, and the supervisor's plan validation
- `tests/linux-task.test.mjs` — Step 5 integration: linux tasks through the real
  supervisor (complete, timeout, cancel, shutdown drain), native tasks proven
  unchanged, an unavailable Linux executor refused at enqueue with no task
  record and no fallback, RT_STATUS `linux` over RPC, planned services
  unreachable, and a win32-shaped daemon that still runs the whole M1 path
- `tests/supervisor.test.mjs` — real child execution: success, non-zero exit,
  spawn failure, timeout, SIGTERM→SIGKILL escalation, idempotent cancel, one
  process per task, capacity cap, workspace create/isolation/cleanup, output
  cap, shutdown draining, argv/stdin/log-leak checks, and the runner's own spec
  validation and orphan guard
- `tests/lifecycle.test.mjs` — registry ↔ supervisor contract: every documented
  transition, cancel-before-spawn (no process ever made), late-outcome cannot
  revive a cancelled task, counters, clamped timeouts on the record, snapshot
  immutability, refusal without a supervisor
- `tests/events.test.mjs` — Step 4 event bus: envelope contract, event
  allowlist (unknown types refused), payload sanitization (hostile fields never
  reach an envelope), bounded history + eviction, `eventsAfter` replay /
  stale-history semantics, subscriber isolation, per-client unpublished status
- `tests/sse.test.mjs` — Step 4 SSE over real HTTP: `/events` auth (incl. token
  never accepted in the query string), CORS/SSE headers, heartbeat, client-cap
  refusal + disconnect cleanup, lifecycle event order, exactly-once terminal
  events (cancel + timeout, incl. late child outcomes), `Last-Event-ID` replay,
  stale-history resync, shutdown event
- `tests/deepseek-provider.test.mjs` — fixed provider routing, successful visible
  response streaming, unavailable/auth/CAPTCHA/unsupported/busy/timeout/
  interrupted states, one-submit guarantee, cancellation and provider isolation
- `tests/deepseek-task.test.mjs` — supervised DeepSeek lifecycle, duplicate and
  provider-busy guards, final event/result handling, secret-field rejection and
  restart/no-auto-resend behaviour
- `tests/daemon.test.mjs` — full integration over real HTTP (ephemeral port):
  health, auth, PING/PONG, RT_STATUS incl. executor + capabilities, task
  run/stop/timeout over RPC, payload that tries to steer the executor, queue
  full, malformed/oversized bodies, CORS origin allowlist, shutdown

## What is deliberately NOT in the runtime

**The runtime daemon does not provide:**

- **A DeepSeek API client.** The fixed provider interacts only with the visible
  web page in the user-authenticated browser session.
- **Authentication automation.** HPOS does not fill login forms, read passwords,
  inspect CAPTCHA contents, copy profile state, read cookies/storage, extract
  tokens or bypass access controls. Those states stop with explicit errors and
  require normal user action in the browser.
- **Arbitrary execution.** No command, script, executable path, URL, selector or
  browser method is accepted from RPC. There is no generic subprocess,
  navigation, evaluate, scrape, fetch, filesystem or shell endpoint.
- **A managed Linux environment.** No WSL, distro, Docker image or VM is
  installed, enabled, pulled or offered; no adapter exists for Windows or
  macOS; there is no Linux terminal, desktop, file browser, settings panel or
  install flow. `linux-stub` only proves the boundary. Planned Linux Python,
  FFmpeg, Git and DeepSeek services remain unreachable placeholders.
- **Retries, restart recovery or priority.** One DeepSeek correlation creates
  one task and at most one submit gesture. Timeout, disconnect, provider failure
  and daemon restart are terminal/interrupted; nothing automatically resends or
  reconstructs work. The in-memory queue has no priority mechanism.
- **Hard CPU/address-space/disk guarantees.** There is no CPU-time cap,
  address-space cap or disk quota, and no memory ceiling beyond the V8 heap
  flag. See *Platform capabilities* for what is enforced and what is reported.
- **Process-tree guarantees on Windows.** The task child is always terminated;
  grandchildren it spawned may survive there because Job Objects need a native
  helper. The capability report says so instead of hiding it.
- **Remote or multi-user access.** The daemon and CDP target are fixed to
  loopback. The runtime token stays in the local host/proxy boundary and is not
  an identity system.
- **A terminal UI.** Runtime Activity shows safe lifecycle/capability/metrics
  only. It does not display prompts, assistant output, browser data, commands,
  process output, environment or filesystem details.
- **A persisted runtime/event queue.** Task records and the bounded event ring
  are memory-only; HPOS conversation persistence remains the existing chat
  store, and stale SSE history is replaced by a safe status resync.

## File map

```
runtime/
├── bin/hpos-runtime.js   CLI entrypoint
├── daemon.js             composition root: endpoint → limits → workspaces →
│                         supervisor → registry → event bus → actions → transport
├── transport.js          HTTP surface (127.0.0.1, token, CORS, size caps, SSE)
├── events.js             Step 4 event bus: allowlist + envelope + bounded history
├── metrics.js            Step 4 safe process metrics (cpu/memory/pid or null)
├── actions.js            RPC allowlist + payload pickers (+ Step 5 linux status)
├── executors.js          Step 5: closed executor vocabulary + service → executor
│                         rules + planned (unimplemented) services
├── backend.js            Step 5: backend router — native adapter + linux
│                         selection; a refusal, never a fallback
├── protocol.js           envelope contract, error codes
├── tasks.js              task registry: state machine, admission, counters,
│                         publishes lifecycle events to the bus
├── supervisor.js         the process supervisor: spawn, watch, kill, tidy
├── runner.js             supervised child entrypoint + fixed provider route
├── executors/services.js closed service/mode routing table
├── browser/
│   ├── contracts.js      sealed browser task/session/failure contract
│   ├── executor.js       fixed provider router
│   ├── session/playwrightCdp.js  loopback user-browser attachment
│   └── providers/deepseek/       isolated selectors + one-send executor
├── env.js                environment allowlist + scrubbing
├── workspace.js          per-task directory creation + guarded cleanup
├── limits.js             bound resolution + platform capability detection
├── endpoints.js          endpoint file + token
├── log.js                structured stdout log, secret-scrubbing
└── linux/                Step 5: the Linux execution backend
    ├── capabilities.js   detection + the safe RT_STATUS projection
    ├── launcher.js       the fixed launch plan: argv, cwd, scrubbed env, caps
    ├── workspace.js      the workspace gate (reuses ../workspace.js)
    ├── backend.js        the backend interface the router/registry speak
    └── README.md         the milestone's boundary, in prose
```
