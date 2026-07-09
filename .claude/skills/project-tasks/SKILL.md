---
name: project-tasks
description: Use when managing a diagram-copilot project.yaml - adding, removing, or updating tasks, choosing what to work on next, working a task end-to-end, or creating tests for a task. Triggers - "add a task", "remove task X", "mark X shipped", "what should I work on next", "work the next task", "work on <task-id>", "create tests for <task-id>".
---

# project-tasks: manage and work project.yaml tasks

project.yaml is the single source of truth for project state. **AGENTS.md in
this repo is the schema authority — read it before your first edit** and
follow its rules exactly (schema, status semantics, the six agent rules).
Edit the yaml directly; never through the viewer.

## Priority order

Work items in this order (this is what the Priority tab and
`GET /api/priority` show):

1. Exclude `status: shipped` items.
2. An item is **ready** when every id in its `depends` is shipped (or it has
   no `depends`).
3. Ready items come first, ranked by how many pending items they transitively
   unblock (most first); ties by id.
4. Blocked items follow in dependency (topological) order, each with the
   non-shipped deps blocking it.
5. Dependency cycles are a project.yaml bug — surface them to the user.

If the viewer is running (default port 4400), prefer fetching the computed
order instead of deriving it yourself:

    curl -s http://localhost:4400/api/priority

Otherwise read the yaml and apply the rules above.

## Operations

### Add a task
Append an item per the AGENTS.md schema: unique kebab-case `id`, `name`,
`type` (frontend | backend | integration), `status: planned`, optional
`depends`/`notes`. Ask the user only for what you can't infer.

### Remove a task
Delete the entry AND remove its id from every other item's `depends`
(dangling deps are validation errors). Never delete a shipped item unless
its code is being removed in the same change.

### Update a task
Change `status`/`depends`/`notes`/`spec` per AGENTS.md status semantics.
Keep `depends` accurate — it drives the diagram.

### Work the next task / work a specific task
1. Get the priority order. For "next", pick the top **ready** item. For a
   named id that is blocked, warn the user and list `blockedBy` before
   proceeding.
2. No `spec`? It needs planning first: invoke `superpowers:brainstorming`,
   then `superpowers:writing-plans`; save the spec as `specs/<id>.md` next to
   the yaml, set `spec:` on the item, keep `status: planned` until
   implementation starts.
3. Has a `spec`? Implement it: set `status: in-progress`, then invoke
   `superpowers:executing-plans` (or `superpowers:subagent-driven-development`)
   with `superpowers:test-driven-development` for the code.
4. When implemented, verified, and merged, set `status: shipped`. Add any
   newly discovered components as `status: planned` items immediately.

### Create tests for a task
Read the item's `spec`, then invoke `superpowers:test-driven-development`
to write tests against the spec'd behavior. If there is no spec, plan first
(see above).

## After every yaml edit

Re-read the file to confirm it is valid yaml and consistent (unique ids,
known type/status, no dangling depends). The running viewer shows validation
errors as a banner — keep it clean.
