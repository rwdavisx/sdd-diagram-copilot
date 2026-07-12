# Service Runner — design

2026-07-12

## Problem

diagram-copilot is installed into other repos as a central command center, but it
can only *describe* an app — it can't launch, stop, or report on the processes
that make up the app (dev servers, APIs, etc.). Add process control and live
status to the dashboard.

## Decisions

- Run commands are declared in `project.yaml` on existing items (no separate file).
- V1 scope: start / stop / restart / live status. Log *viewer*, docker visibility,
  auto-restart, and watch-mode rebuilds are explicitly v2.
- Services are child processes of the copilot server; when the copilot exits,
  everything it launched dies. No detached processes, no PID files.
- UI: status chips on existing views + controls in the detail panel + a dedicated
  Run tab.

## Schema

Optional `run` block on any item:

```yaml
- id: tasks-api
  ...
  run:
    cmd: node src/server.js       # required — shell command
    cwd: .                        # optional, relative to the yaml file (default: yaml dir)
    port: 3000                    # optional — enables readiness + external detection
    env: { NODE_ENV: development }  # optional, merged over process.env
```

Items with a `run` block are "services". Dependency order comes from the existing
`depends` edges.

## Server side — `runner.js`

Modeled on `workflow.js` (spawn/stop/broadcast pattern).

- Spawn with `shell: true`, cwd resolved against the yaml directory, env merged
  over `process.env`.
- Kill: on Windows `taskkill /pid <pid> /t /f` so the whole process tree dies
  (npm → node child); elsewhere kill the process group.
- States: `stopped | starting | running | crashed | external`.
  - `starting → running` when the declared port accepts a TCP connection, or
    after ~2s if no port is declared.
  - Exit with non-zero code and no stop requested → `crashed`.
  - `external`: item declares a port, something we didn't start is listening.
    Shown as alive; Stop is disabled for it.
- Output: last ~200 lines of combined stdout/stderr per service in a ring
  buffer, returned with service detail. Not a streaming log viewer.
- Start All: start services in dependency order (topological over `depends`,
  restricted to services); a service whose service-dependencies are starting
  waits for them to reach `running`/`external` before spawning. Stop All:
  reverse order.
- On copilot server exit (including SIGINT), kill all children before exiting.
- project.yaml edits live-reload already; if a running service's `run` block
  changes, keep it running under the old config and mark it `stale: true` in
  status until restarted.

### Endpoints

- `GET  /api/services` — all services: id, name, status, port, pid, startedAt, stale.
- `GET  /api/services/:id` — same + output ring buffer.
- `POST /api/services/:id/start | stop | restart`
- `POST /api/services/start-all | stop-all`
- Status changes broadcast on the existing `/api/events` SSE stream as
  `{ type: 'service', id, status }`.

## UI

- **Chips**: small colored dot on runnable items in diagram and board views —
  grey stopped, amber starting, green running, red crashed, blue external.
- **Detail panel**: for a runnable item — status, Start/Stop/Restart buttons,
  port, uptime, last output lines (monospace block).
- **Run tab**: table of all services (name, status chip, port, uptime,
  Start/Stop/Restart per row) with Start All / Stop All in the header.
- All views update from the SSE `service` events; no polling.

## Error handling

- Bad `run` block (missing cmd, unknown cwd) → validation banner, same channel
  as existing yaml validation; service shown but Start disabled.
- Spawn failure (command not found) → `crashed` with the error in the output
  buffer.
- Start on an already-running service / stop on a stopped one → 409, no-op.

## Testing

- Unit: state transitions in `runner.js` using a trivial long-running command
  (`node -e "setInterval(()=>{},1e3)"`) — start→running, stop→stopped,
  crash detection with `node -e "process.exit(1)"`, port readiness with a tiny
  listener, dependency-ordered start-all.
- Existing test setup in `test/` is the home for these.

## Out of scope (v2)

Docker visibility (`docker ps`, container start/stop), streaming log viewer,
auto-restart on crash, health checks beyond TCP port, watch-mode rebuilds.
