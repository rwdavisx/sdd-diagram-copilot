# analyze-project: reverse-engineer an existing codebase into project.yaml

## Problem

`diagram-copilot init` on an existing repo yields an empty `project.yaml`. The
only way to populate it is the plan-project interview, which assumes the
product doesn't exist yet. Repos with real code — features unmapped, specs
absent, structure organic — need the blueprint extracted *from* the code.

## Solution

A new single-step pipeline `['analyze-project']`, a sibling of
`['plan-project']`, run through the existing workflow engine. One headless
Claude Code session explores the codebase (dispatching its own parallel
Explore subagents per area), deconstructs it into items, and writes
`project.yaml` incrementally so the architecture diagram fills in live.

No new orchestration, session management, or merge logic: the session's own
harness provides multi-agent fan-out; the workflow engine provides transcript,
stop/retry, mid-run chat, and completion gating.

## Trigger / UX

- Design tab empty state gains a second button, **"Analyze codebase"**, next
  to "Plan project". POSTs `/api/workflow/analyze-project`.
- The button is always available — no repo-content detection heuristics.
- `initProject()`'s console hint mentions both paths (plan a new project /
  analyze an existing one).
- While running, the Design tab renders the analyze chat exactly as it does
  the plan-project chat (`isPlanning` treats both pipelines alike).
- Workflow tab running hint: agents are exploring the codebase; items appear
  on the diagram as areas are mapped; the user can interject below.

## The prompt (heart of the feature)

`analyzeProjectPrompt()` instructs the session to:

1. **Survey**: map the repo top-level — stack, entry points, layout.
2. **Fan out**: use the superpowers:dispatching-parallel-agents skill to run
   parallel Explore subagents per major area (frontend screens, backend
   routes/services, data layer, integrations, tests), each returning condensed
   findings, never raw file dumps.
3. **Deconstruct into items** per AGENTS.md schema, updating `project.yaml`
   incrementally as each area is synthesized (the human watches the diagram
   live):
   - every user-facing screen, API/service, and external integration becomes
     an item: kebab-case `id`, `name`, `type: frontend|backend|integration`;
   - `status: shipped` (the code exists and works) — `in-progress` only if
     visibly half-built;
   - `notes`: one line naming the key source paths so future work can find
     the code;
   - accurate `depends` (drives the diagram);
   - `contracts:` for each interface an item owns (API endpoints, DB tables,
     events) with name, kind, schema;
   - `flows:` for data movement between items;
   - existing tests mapped to their owning item's `tests:` with
     `status: unknown` (the suite is not run during analysis).
4. **Explicit non-goals**: no specs, no wireframes — those are written when an
   item is next iterated on. Do not modify any source code.
5. **Finish**: commit `project.yaml`, then write a summary report to
   `.superpowers/analyze-report.md` as the **last action**.

## Completion detection

- `check` (turn-end): `.superpowers/analyze-report.md` fresh since step start
  — same pattern as the review step's artifact.
- `checkOnEnd` (Stop pressed / session ended): `project.yaml` fresh — same as
  plan-project. Stopping mid-run after items landed is a graceful partial
  import, not a failure.
- Session death or ending with neither artifact → existing `needs-attention`
  + Retry path.

## Touch points

| File | Change |
|---|---|
| `workflow.js` | `analyzeProjectPrompt()`, `ANALYZE_PIPELINE`, `analyze-project` STEP_DEF, `analyzeProject()` on the workflow object, export prompt for tests |
| `server.js` | POST `/api/workflow/analyze-project`; init console hint mentions analyze |
| `web/src/DesignView.jsx` | second empty-state button; treat `analyze-project` like `plan-project` for chat rendering |
| `web/src/WorkflowView.jsx` | `RUNNING_HINTS['analyze-project']`; fix `retry()` to repost `state.pipeline[0]` instead of hardcoded plan-project |
| `AGENTS.md` | document the step (schema comment's step list + Workflow tab section) |
| `test/workflow.test.js` | mirror plan-project tests: completes on fresh report at turn-end; stop with fresh yaml completes; 409 while running |
| `project.yaml` (this repo) | new item for this feature per AGENTS.md rule 3 |

## Error handling

Inherited wholesale from the workflow engine: concurrent-workflow 409 (UI
already surfaces it), session failure → `needs-attention` with Retry,
interrupted-on-server-restart recovery.

## Out of scope

- Repo-content detection at init (button is always offered).
- Generating specs or wireframes for existing code.
- Running the target repo's test suite during analysis.
- Incremental re-analysis / diffing against an already-populated yaml. First
  version targets the empty-yaml case; re-running on a populated yaml is
  allowed but simply relies on the model reconciling against existing items
  (AGENTS.md rules already forbid casual renames/deletes).
