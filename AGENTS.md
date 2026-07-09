# Agent guide: project.yaml is the master state

This repo is **diagram-copilot**, a viewer for spec-driven development. Each
target project keeps a `project.yaml` that is the single source of truth for
what exists, what's being built, and what's still just an idea. **Agents read
and edit `project.yaml` directly — never through the viewer** (the UI is
read-only by design).

## Schema

```yaml
project: My App            # display name
items:
  - id: login-page         # required, unique, kebab-case, stable (never rename casually)
    name: Login Page       # required, human-readable
    type: frontend         # required: frontend | backend | integration
    status: planned        # required: planned | in-progress | shipped
    spec: docs/specs/login.md   # optional; path relative to this yaml file
    depends: [auth-api]    # optional; ids of items this item calls/uses
    notes: freeform text   # optional
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
6. **Don't edit the viewer's code to change project state.** State lives only
   in `project.yaml`.

## Finding work

- `status: planned` with no `spec` → needs a spec written.
- `status: planned` with a `spec` → ready to implement.
- `status: in-progress` → in flight; check notes and recent commits before
  picking it up.

## Running the viewer

```sh
node server.js path/to/project.yaml [--port 4400] [--no-open]
```

The UI live-reloads when `project.yaml` changes.
