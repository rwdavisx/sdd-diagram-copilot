# Graphify as a required dependency

**Date:** 2026-07-12
**Status:** Approved

## Goal

Graphify is currently an optional enhancer: if the CLI can't be installed, every
graphify feature silently degrades. Change it to a required dependency — the app
must not run without the graphify CLI available — while keeping graph
*generation* asynchronous.

## Design

### 1. Auto-install chain (`graphify.js`)

`ensureInstalled()` gains a uv bootstrap step. New order:

1. `graphify --version` succeeds → available.
2. `uv` present → `uv tool install graphifyy`.
3. `uv` missing → install uv via the official Astral installer:
   - Windows: `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`
   - Other platforms: `curl -LsSf https://astral.sh/uv/install.sh | sh`
   then retry `uv tool install graphifyy`.
4. `pipx install graphifyy` fallback stays as-is.

**PATH gotcha:** a fresh uv install lands in `~/.local/bin`, which is not on the
current node process's PATH. After installing, resolve `uv` — and the `graphify`
shim it creates — by explicit path (`~/.local/bin/uv[.exe]`,
`~/.local/bin/graphify[.exe]`) when plain PATH lookup fails. All later
invocations (`graphify .`, the MCP `uv run` launcher, background upgrade) use
the resolved command.

### 2. Hard requirement at startup (`server.js`)

Startup awaits `ensureInstalled()` before binding the listener. On failure it
prints the install hint to stderr and exits non-zero. No degraded mode. First
launch on a fresh machine pauses while uv + graphify install.

### 3. Downstream unchanged

Graph generation stays background/async: the Graph tab keeps its
generating/stale chips, workflow sessions pick up the graph once it exists.
The existing "unavailable" UI/API states (Graph tab message,
`/api/graphify/status`, 503 on regenerate) remain as defensive dead code —
removing them buys nothing and churns tests.

## Testing

- Unit (`test/graphify.test.js`): uv missing → installer runs → retry succeeds;
  installer fails → `ensureInstalled()` false; resolved-path fallback used when
  PATH lookup fails post-install.
- Server: startup exits non-zero when `ensureInstalled()` resolves false.
- Live verify on this machine (uv genuinely absent): launch → uv auto-installs →
  graphify installs → Graph tab generates.
