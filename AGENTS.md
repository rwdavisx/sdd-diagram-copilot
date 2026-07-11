# Agent guide: project.yaml is the master state

This repo is **diagram-copilot**, a viewer for spec-driven development. Each
target project keeps a `project.yaml` that is the single source of truth for
what exists, what's being built, and what's still just an idea. **Agents read
and edit `project.yaml` directly — never through the viewer** (the UI is
read-only by design).

## Schema

```yaml
project: My App            # display name
workflow:                  # optional; which model/effort the Workflow tab's sessions use
  defaults: { model: sonnet, effort: medium }    # any Claude Code alias or full model id; effort: low|medium|high|xhigh|max
  steps:                   # per-step overrides (brainstorm|worktree|plan|execute|review|finish|plan-project|analyze-project)
    execute: { model: claude-fable-5, effort: high }
    worktree: { model: haiku, effort: low }
items:
  - id: login-page         # required, unique, kebab-case, stable (never rename casually)
    name: Login Page       # required, human-readable
    type: frontend         # required: frontend | backend | integration
    status: planned        # required: planned | in-progress | shipped
    spec: docs/specs/login.md   # optional; path relative to this yaml file
    depends: [auth-api]    # optional; ids of items this item calls/uses
    notes: freeform text   # optional
    workflow: { model: fable, effort: xhigh }   # optional; overrides workflow.steps/defaults for this item's sessions
    wireframe: design/wireframes/login-page.html  # optional; defaults to this convention path when the file exists
    flows:                 # optional; data movement this item initiates (drawn as labeled edges)
      - { to: users-db, kind: data, label: "user rows" }   # kind: nav | api | data (default data)
    contracts:             # optional; the interfaces this item owns (browsable in the Schemas tab)
      - name: POST /api/login      # required
        kind: api                  # api | db | event (free-form, badge only)
        description: optional one-liner
        schema: |                  # free-form block — shape, fields, SQL, JSON, whatever reads best
          request:  { email: string, password: string }
          response: { token: string }
    tests:                 # optional; the item's tests (Tests tab + pass/fail chip on its diagram node)
      - name: rejects a bad password   # required
        file: test/login.test.js       # optional
        status: passing                # passing | failing | unknown (default unknown)
```

The server validates on every load: unknown `type`/`status`, duplicate `id`s,
and `depends` referencing nonexistent ids are surfaced as errors in the UI.
Keep the file valid.

## Status semantics

| status | meaning |
|---|---|
| `planned` | The item is known to be needed. It may or may not have a spec yet. |
| `in-progress` | Implementation has started but isn't usable/complete. |
| `shipped` | Implemented, merged, and working end-to-end. |

## Rules for agents

1. **Update `project.yaml` when you plan, start, or ship an item.** The file
   must always reflect reality — it's what humans look at to see project state
   and what other agents use to decide what to work on next.
2. **An item without a `spec` needs planning.** Before implementing an item,
   write its spec (markdown, stored near the yaml, e.g. `specs/<id>.md`), set
   the `spec:` path, and keep `status: planned` until implementation starts.
3. **Add new items as soon as they're identified** — a new component, API, or
   integration discovered during work gets an entry with `status: planned`.
4. **Keep `depends` accurate.** When an item starts or stops calling another,
   update its `depends` list. This drives the architecture diagram.
5. **Never delete shipped items**; if something is removed from the product,
   delete its entry in the same change that removes the code.
6. **Declare contracts and flows as soon as an interface exists.** When you
   design an API endpoint, database table, or event, record it under the owning
   item's `contracts:` (name, kind, schema). When an item reads or writes
   another item's data outside of a wireframe interaction, add a `flows:` entry
   with a short label — this is what makes data movement visible on the diagram.
7. **Record tests under the owning item's `tests:`.** When you write a test
   for an item, add it (name, file, status); whenever you run tests, update
   the statuses so the Tests tab and diagram chips reflect reality.
8. **Don't edit the viewer's code to change project state.** State lives only
   in `project.yaml`.

## Wireframes

Frontend items can have an HTML wireframe that the diagram renders live inside
the item's node. Conventions:

- **Path:** `design/wireframes/<item-id>.html` (auto-detected; an explicit
  `wireframe:` field overrides). A wireframe file with no matching item is an
  error.
- **Self-contained:** one file, inline CSS only, no `<script>`, no external
  assets. Design the body at 800px wide.
- **Flows live in the HTML:** every interactive element that leads somewhere
  gets a unique `id` plus `data-flow-to="<item-id>"` and
  `data-flow-kind="nav|api|data"`:
  - `nav` — the user navigates to another screen
  - `api` — the element triggers a backend item
  - `data` — the element displays data from a backend/integration item

  ```html
  <button id="checkout-btn" data-flow-to="checkout" data-flow-kind="nav">Check out</button>
  <form id="order-form" data-flow-to="orders-api" data-flow-kind="api">…</form>
  ```

  The server parses these attributes to draw connectors on the architecture
  diagram (parallel flows between the same two items are bundled into one
  labeled edge) — there is no separate flows registry to maintain. An optional
  `data-flow-label="…"` names the edge. `data-flow-to` referencing a
  nonexistent item id is surfaced as an error.

## Finding work

- `status: planned` with no `spec` → needs a spec written.
- `status: planned` with a `spec` → ready to implement.
- `status: in-progress` → in flight; check notes and recent commits before
  picking it up.

## Running the viewer

```sh
diagram-copilot init                 # scaffold project.yaml + this guide in any repo, then serve
diagram-copilot [path/to/project.yaml] [--port 4400] [--no-open]   # defaults to ./project.yaml
```

(`node server.js …` works the same when running from a checkout.) The UI
live-reloads when `project.yaml` changes.

## The Workflow tab

The viewer can also *drive* development: the Workflow tab runs headless
Claude Code sessions through the superpowers pipeline (brainstorm → worktree
→ plan → execute → review → finish), one bounded session per step, with
artifacts on disk as ground truth. Each step ends at a gate: the human
reviews the step's output and presses Continue before the next step starts —
steps never auto-advance. The
server updates `project.yaml` itself at the milestones (spec recorded after
brainstorm, `in-progress` when execution starts, `shipped` when the branch
merges) — agents running inside the workflow don't need to remember.
"Plan project" starts a chat that interviews the human and fills
`project.yaml` with planned items. "Analyze codebase" is its inverse for
existing repos: agents explore the code in parallel, deconstruct it into
items (with depends, contracts, flows, and tests), and fill `project.yaml`
with what's already built, marked `shipped`.
