# HPOS Runtime (M1 — infrastructure only)

A local, invisible execution layer for HPOS: a small **daemon process** that
listens **only on `127.0.0.1`**, speaks the same HPOS envelope protocol as the
browser bridge (different transport, different action namespace), and runs
**tasks** through a small registry with a minimal lifecycle.

**This is M1 infrastructure only.** It contains **no DeepSeek integration**,
no process spawning, no shell execution, no network calls out of the daemon,
and no dependencies (Node built-ins only, Node 18+). Real DeepSeek behaviour
lands in a later milestone behind the same registry boundary — the existing
BrowserBridge / DeepSeekConnector / extension are untouched and remain the
browser path.

```
HPOS UI (later: LocalRuntimeBridge)
   │  HTTP, same hpos-bridge envelopes, X-HPOS-Token header
   ▼
hpos-runtime daemon  ── 127.0.0.1 only, origin-allowlisted CORS
   ├── GET  /health   liveness + version, no secrets
   ├── POST /rpc      authenticated RPC (envelope in/out)
   └── task registry   QUEUED → RUNNING → COMPLETE | CANCELLED
                         (service: stub — does nothing but run)
```

## Run

```bash
cd runtime
npm start                 # or: node bin/hpos-runtime.js
```

The daemon prints its bound port and the endpoint file location, then waits.
Stop it with `Ctrl+C` (SIGINT) — it releases the endpoint file on the way out.

Environment:

| Var | Default | Meaning |
| --- | --- | --- |
| `HPOS_RUNTIME_PORT` | `5190` | TCP port (always 127.0.0.1; `0` = ephemeral, mostly for tests) |
| `HPOS_RUNTIME_HOME` | `~/.hpos/runtime` | State dir (endpoint file). Overridable for tests/embedding |
| `HPOS_RUNTIME_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## Endpoints

### `GET /health`

No auth. Liveness only — never contains the token or task data.

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
| `RT_STATUS` | runtime + task status; optional `{ taskId }` for one task record | `{ status, version, services, tasks: {total, active, …}, recent, task? }` |
| `RT_TASK_RUN` | enqueue a stub task | `{ taskId, status: "QUEUED", service }` · payload: `{ service?: "stub", durationMs?: 0–60000, note?: ≤200 chars }` |
| `RT_TASK_STOP` | cancel an active task | `{ taskId, status: "CANCELLED" }` · payload: `{ taskId }` |

Unknown actions (including bridge `DS_*` actions, `EVAL`, `SCRAPE`,
`GET_COOKIES`, …) are rejected with `UNKNOWN_ACTION`. Error codes:
`RT_UNAUTHORIZED`, `RT_INVALID_REQUEST`, `RT_BODY_TOO_LARGE`,
`RT_INVALID_CONTENT_TYPE`, `UNKNOWN_ACTION`, `RT_INVALID_PAYLOAD`,
`RT_UNKNOWN_SERVICE`, `RT_QUEUE_FULL`, `RT_TASK_NOT_FOUND`,
`RT_TASK_NOT_CANCELABLE`.

Task lifecycle: `QUEUED → RUNNING → COMPLETE`, with `CANCELLED` reachable
from either non-terminal state via `RT_TASK_STOP`. M1 has one service,
`stub` (bounded no-op run); the registry shape (per-service limits,
correlation ids, lifecycle) is what later services plug into.

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
no network, temp dirs only (never touch the real `~/.hpos`):

```bash
cd runtime
npm test
```

- `tests/protocol.test.mjs` — envelope contract + allowlist (bridge `DS_*`
  actions are explicitly rejected)
- `tests/endpoints.test.mjs` — token file creation, `0600`/`0700` permissions,
  live-pid refusal, stale/corrupt replacement, release semantics
- `tests/daemon.test.mjs` — full integration over real HTTP (ephemeral
  port): health, auth, PING/PONG, RT_STATUS, task run/stop/cancel, queue
  full, malformed/oversized bodies, CORS origin allowlist, shutdown

## What is deliberately NOT here (yet)

- No DeepSeek service (that is the next milestone, behind the registry).
- No arbitrary command/shell execution, no `eval`, no generic
  fetch/SSRF, no cookie access. Registered services only, allowlisted.
- No multi-user/LAN support — this is a single-user local daemon on loopback.
- No new dependencies: Node built-ins only.
