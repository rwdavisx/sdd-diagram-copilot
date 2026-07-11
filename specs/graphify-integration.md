# Graphify Integration — Design Spec

**Item:** `graphify-integration` · **Status:** approved 2026-07-11
**Upstream:** https://github.com/Graphify-Labs/graphify (CLI `graphifyy`, installed via uv/pipx)

## Goal

Workflow LLM sessions get better, faster codebase knowledge: instant
orientation from `GRAPH_REPORT.md` plus live graph query tools via MCP, with
the graph kept fresh automatically. Graphify is an enhancer, never a gate —
every failure degrades to today's behavior with a visible status.

## Components

### 1. `graphify-install` — auto-install

- On server start, check `graphify` on PATH.
- Missing → `uv tool install graphifyy`; no uv → `pipx install graphifyy`.
- Both installers absent or install fails → log + one-time UI hint; all other
  features degrade gracefully (sessions run without graph).
- Once per server start, run `uv tool upgrade graphifyy` (or pipx equivalent)
  in the background so the tool stays current.

### 2. `graphify-refresh` — refresh pipeline

- One shared graph per project, generated in the **main checkout** (worktree
  sessions point at it; their own in-progress diff doesn't need a graph).
- Graph outputs (`graph.html`, `graph.json`, `GRAPH_REPORT.md`) are
  gitignored in the target project.
- `ensureGraphFresh(projectDir) -> { state: fresh | stale-regenerating | missing }`
  - Compares repo HEAD + dirty-state hash against a marker recorded at last
    generation.
  - Stale/missing → spawn `graphify .` in the background, return immediately.
    **Never blocks session start** — first session after big changes sees a
    slightly-old graph; the graph converges to fresh.
- Called at every workflow session start and on server start.

### 3. `graphify-session-context` — graph pointer in session prompt

- Append one paragraph to each workflow session's initial prompt: main-checkout
  paths of `GRAPH_REPORT.md` / `graph.json` + "consult the graph before
  exploratory grepping".
- Skipped cleanly when the graph is unavailable.

### 4. `graphify-mcp-attach` — MCP server per session

- `sessions.js` adds Graphify's stdio MCP server to the Agent SDK
  `options.mcpServers` for every session.
- Gives the LLM live query tools: callers, shortest-path, explain-entity,
  plain-language graph queries.
- Omitted when graphify is unavailable.

### 5. `graphify-graph-tab` — Graph tab (human view)

- New top-level tab embedding Graphify's interactive `graph.html` in an iframe.
- `GET /api/graphify/graph.html` — serves the current graph (404 if none).
- `GET /api/graphify/status` — `{ state: fresh | stale-regenerating | missing | unavailable, generatedAt }`.
- Status chip + manual Regenerate button.
- Wireframe: `design/wireframes/graphify-graph-tab.html`.

## Decisions log

| Question | Decision |
|---|---|
| Consumption mechanism | Report pointer in prompt **and** MCP query tools (most powerful combo) |
| Freshness | Staleness check at session start, regen in background, non-blocking |
| Worktrees | One shared graph in main checkout; worktree sessions point at it |
| Missing CLI | App auto-installs (uv → pipx), graceful degradation on failure |
| UI | Yes — Graph tab embedding graph.html |

## Testing

- Unit: staleness detection (HEAD/dirty hash vs marker), prompt injection
  present/absent, install fallback chain — with a fake `graphify` binary.
- Manual (/verify skill): MCP tools visible in a session, Graph tab renders,
  status chip transitions.

## Build order

install → refresh → session-context (already useful on its own) →
mcp-attach → graph-tab.
