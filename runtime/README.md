# HPOS Runtime (M1 — infrastructure only)

A local, invisible execution layer for HPOS: a small **daemon process** that
listens **only on `127.0.0.1`**, speaks the same HPOS envelope protocol as the
browser bridge (different transport, different action namespace), and runs
**tasks** as **supervised child processes** — one per task — through a task
registry with an explicit lifecycle.

**This is M1 infrastructure only.** It contains **no DeepSeek integration**, no
shell execution, no network calls out of the daemon, and no dependencies (Node
built-ins only, Node 18+). Real DeepSeek behaviour lands in a later milestone
behind the same registry boundary — the existing BrowserBridge /
DeepSeekConnector / extension are untouched and remain the browser path.

```
HPOS UI (later: LocalRuntimeBridge)
   │  HTTP, same hpos-bridge envelopes, X-HPOS-Token header
   ▼
hpos-runtime daemon  ── 127.0.0.1 only, origin-allowlisted CORS
   ├── GET  /health   liveness + version, no secrets
   ├── POST /rpc      authenticated RPC (envelope in/out)
   ├── task registry   QUEUED → RUNNING → COMPLETE | FAILED | CANCELLED
   └── process supervisor
         └── child_process: node runner.js   (one per task, own workspace)
```

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
                   RUNNING ──▶ exit 0        ─▶ COMPLETE
                          ──▶ exit ≠ 0      ─▶ FAILED  (NONZERO_EXIT)
                          ──▶ spawn error   ─▶ FAILED  (SPAWN_FAILED)
                          ──▶ timeout hit   ─▶ FAILED  (TIMEOUT)
                          ──▶ RT_TASK_STOP  ─▶ CANCELLED
                      ▼
                   settle(once) ─▶ dispose workspace ─▶ outcome to the registry
```

Hard rules this layer is built around:

- **Fixed argv.** The child is launched as `<process.execPath> --max-old-space-size=N
  runtime/runner.js`. No task text, no path, no id, no payload ever reaches the
  command line, so `ps` shows nothing interesting. There is no `shell: true`
  anywhere in this codebase.
- **No general-purpose endpoint.** There is no action that accepts a command,
  an executable path, a URL or a file path. `RT_TASK_RUN` picks a *registered
  service*, and M1 has one: `stub`.
- **Closed behaviour set.** `runner.js` implements a fixed table of modes
  (`noop`, `sleep`, `hang`, `fail`, `inspect-env`, `inspect-workspace`, `flood`)
  and refuses anything else with an error exit. No `eval`, no dynamic import, no
  require of task-supplied text, no child processes inside the child. M1's task
  is a harmless no-op by design — this step exists to prove supervised process
  execution, isolation and lifecycle handling, not to do work.
- **One process per task, ever.** A task that fails stays failed: nothing is
  re-sent, re-queued or restarted. Its record keeps `attempts: 1`.
- **Never reject, always settle.** `supervisor.done` resolves for every path,
  including spawn failure, so a task cannot be stranded in RUNNING.

## Run

```bash
cd runtime
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

## Supported actions (allowlist — nothing else is executed)

| Action | Purpose | Response payload |
| --- | --- | --- |
| `PING` | liveness + protocol version | `{ version, engine: "hpos-runtime", uptimeMs, now }` |
| `RT_STATUS` | runtime, task **and executor** status; optional `{ taskId }` for one task record | `{ status, version, services, tasks, executor, capabilities, capabilityNotes, recent, task? }` |
| `RT_TASK_RUN` | enqueue a task on the supervised executor | `{ taskId, status: "QUEUED", service }` · payload: `{ service?: "stub", durationMs?: 0–60000, timeoutMs?: 1000–max, note?: ≤200 chars }` |
| `RT_TASK_STOP` | cancel an active task (kills its child) | `{ taskId, status: "CANCELLED" }` · payload: `{ taskId }` |

`RT_TASK_RUN` ignores every field it does not whitelist. A payload that carries
`mode`, `command`, `cwd`, `env`, `execPath` or `shell` gets all of it dropped
before the executor ever sees the request — the service table decides what the
child does.

Unknown actions (including bridge `DS_*` actions, `EVAL`, `SCRAPE`,
`GET_COOKIES`, and every invented `RT_TASK_EXEC`/`RT_SPAWN`/`RT_FETCH` style
name) are rejected with `UNKNOWN_ACTION`. Error codes: `RT_UNAUTHORIZED`,
`RT_INVALID_REQUEST`, `RT_BODY_TOO_LARGE`, `RT_INVALID_CONTENT_TYPE`,
`UNKNOWN_ACTION`, `RT_INVALID_PAYLOAD`, `RT_UNKNOWN_SERVICE`, `RT_QUEUE_FULL`,
`RT_TASK_NOT_FOUND`, `RT_TASK_NOT_CANCELABLE`, `RT_EXECUTOR_UNAVAILABLE`.

## Task state machine

`QUEUED → RUNNING → COMPLETE`, with `FAILED` for anything the child did not
survive cleanly and `CANCELLED` reachable from either non-terminal state:

| Transition | Cause |
| --- | --- |
| `QUEUED → RUNNING` | the admission slot fired and a child was spawned |
| `RUNNING → COMPLETE` | child exited 0 (and its result line, if any, was not a failure) |
| `RUNNING → FAILED` | non-zero exit, spawn failure, timeout, or the workspace could not be created |
| `QUEUED → CANCELLED` | `RT_TASK_STOP` before a child existed — no process is ever made |
| `RUNNING → CANCELLED` | `RT_TASK_STOP`; the child is terminated |

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
- `RT_TASK_STOP` is **idempotent**: the transition to `CANCELLED` happens once,
  and `supervisor.cancel()` on an already-cancelling or already-settled task
  returns a no-op instead of a second kill or an error.
- Daemon shutdown (`SIGINT`/`SIGTERM`) cancels every live task, waits for the
  children to exit, force-kills whatever does not, and only then closes the
  listener. `process.on('exit')` fires one last synchronous SIGKILL sweep.
- **Orphan guard:** the child treats the end of its stdin pipe as "the daemon is
  gone" and exits itself (code `170`). If the daemon is `SIGKILL`ed — no handler
  runs at all — its tasks still disappear within a few hundred ms.

## Concurrency

Admission is checked at enqueue time against `maxActive`: while that many tasks
are `QUEUED`/`RUNNING`, `RT_TASK_RUN` returns `RT_QUEUE_FULL`. The queue is
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
- `tests/supervisor.test.mjs` — real child execution: success, non-zero exit,
  spawn failure, timeout, SIGTERM→SIGKILL escalation, idempotent cancel, one
  process per task, capacity cap, workspace create/isolation/cleanup, output
  cap, shutdown draining, argv/stdin/log-leak checks, and the runner's own spec
  validation and orphan guard
- `tests/lifecycle.test.mjs` — registry ↔ supervisor contract: every documented
  transition, cancel-before-spawn (no process ever made), late-outcome cannot
  revive a cancelled task, counters, clamped timeouts on the record, snapshot
  immutability, refusal without a supervisor
- `tests/daemon.test.mjs` — full integration over real HTTP (ephemeral port):
  health, auth, PING/PONG, RT_STATUS incl. executor + capabilities, task
  run/stop/timeout over RPC, payload that tries to steer the executor, queue
  full, malformed/oversized bodies, CORS origin allowlist, shutdown

## What is deliberately NOT here (yet)

**Step 2 does not provide:**

- **DeepSeek, in any form.** There is no DeepSeek service, no connector, no
  session, no auth, no model call, no chat storage in the runtime. The one
  registered service is `stub`, whose child process does nothing. LocalRuntimeBridge,
  the Vite proxy and SSE events are likewise not part of this step.
- **Arbitrary execution.** No command, script, executable path, URL or file
  path is accepted from RPC. No `eval`, no generic subprocess or fetch endpoint,
  no shell, no cookie access, no token scraping, no login bypass, no SSRF.
- **Real work in tasks.** The task body is a no-op stub on purpose; what is
  being proven is supervision, isolation and lifecycle, not output.
- **Hard resource guarantees.** No CPU-time cap, no address-space cap, no disk
  quota, no memory ceiling beyond the V8 heap flag. See *Platform capabilities*
  for what is enforced and what is only reported.
- **Process-tree guarantees on Windows.** The task child is always terminated;
  grandchildren it spawned may survive there, because Job Objects need a native
  helper. The capability report says so instead of hiding it.
- **Retries, persistence or priority.** A failed task stays failed, the queue is
  in-memory and bounded, and nothing survives a restart.
- **Multi-user or remote access.** A single-user local daemon on loopback; the
  token is a same-machine secret, not an identity system.

## File map

```
runtime/
├── bin/hpos-runtime.js   CLI entrypoint
├── daemon.js             composition root: endpoint → limits → workspaces →
│                         supervisor → registry → actions → transport → shutdown
├── transport.js          HTTP surface (127.0.0.1, token, CORS allowlist, size caps)
├── actions.js            RPC allowlist + payload pickers
├── protocol.js           envelope contract, error codes
├── tasks.js              task registry: state machine, admission, counters
├── supervisor.js         the process supervisor: spawn, watch, kill, tidy
├── runner.js             the child entrypoint (fixed mode table, no shell)
├── env.js                environment allowlist + scrubbing
├── workspace.js          per-task directory creation + guarded cleanup
├── limits.js             bound resolution + platform capability detection
├── endpoints.js          endpoint file + token
└── log.js                structured stdout log, secret-scrubbing
```
