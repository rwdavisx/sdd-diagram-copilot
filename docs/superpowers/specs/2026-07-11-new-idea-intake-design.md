# New idea intake: backlog capture + brainstorm from the browser

**Date:** 2026-07-11
**Status:** Approved

## Problem

New features currently enter project.yaml only from a terminal session: an
agent (or the human editing yaml by hand) seeds an item, and only then can the
Workflow tab's brainstorm step run on it. The human wants to ideate and add
features entirely from the web app — one fresh chat session per idea — so
browser-driven development is self-sufficient end to end.

## Design

One "New idea" mini-form in the Workflow tab with two actions. Everything
downstream (the six-step pipeline, fresh bounded session per step, live
diagram) is reused unchanged.

### Server (`server.js`)

- `addProjectItem(yamlPath, { name, type, notes })` — appends a new item at
  the end of the `items:` list with a line-targeted, comment-preserving edit
  (same style as `updateProjectItem`; no yaml round-trip). Fields written:
  `id`, `name`, `type`, `status: planned`, and `notes` when provided.
  - `id` is the kebab-cased name; on collision with an existing id, suffix
    `-2`, `-3`, ….
  - Returns the generated id, or false if the file/items list can't be found.
- `POST /api/items` — body `{ name, type, notes? }`. Validates: `name`
  required non-empty; `type` must be `frontend|backend|integration`. Returns
  `{ id }` on success, 400 with a message otherwise. The existing yaml
  file-watcher + SSE broadcast already live-reloads all views, so the new
  item appears on the diagram immediately; no extra push needed.

### UI (`web/src/WorkflowView.jsx`)

- "New idea" mini-form rendered alongside `StartControls` (both in the
  empty state and the "Start something else" row): name input, type selector
  (frontend/backend/integration), optional one-line idea text, two buttons:
  - **Add to backlog** — `POST /api/items`, clear the form. No session.
  - **Brainstorm now** — `POST /api/items`, then
    `POST /api/workflow/start { itemId, step: 'brainstorm' }` and select the
    item so the tab shows the running session. If a workflow is already
    running, the existing 409 surfaces; the item is still captured (worst
    case: backlog entry exists, user starts brainstorm later).
- No prompt changes: `brainstormPrompt` already injects the item's `notes`,
  which carries the idea text into the session.

### Fresh context per idea

Already guaranteed by the existing workflow: `begin()` resets the transcript
and each step runs its own bounded session. No new work.

### AGENTS.md

Amend the "UI is read-only" rule: the one human write is seeding a new
planned item via the New idea form. All other state transitions remain
workflow/agent-owned.

## Error handling

- Empty name or unknown type → 400 with message, shown by the form (existing
  `post` helper pattern).
- project.yaml missing or `items:` not a list → 400 with message.

## Testing

Unit tests in the existing `test/` style:

- `addProjectItem`: kebab id generation, collision suffixing, append position
  when `items:` is not the last top-level key (e.g. followed by `workflow:`),
  notes containing `:` or quotes serialize safely, comment preservation.
- Endpoint: 400 on missing name / bad type; `{ id }` on success.

## Out of scope

- Editing or deleting items from the UI (workflow/agent-owned).
- Claude-parsed bulk idea dumps (revisit if single-idea capture feels slow).
- Placement on other tabs (Board/Design) — Workflow tab only for v1.
