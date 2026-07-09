# Design: Dependency-prioritized task list + project-tasks skill

Date: 2026-07-09
Status: approved

## Goal

1. Show a dependency-prioritized list of non-shipped tasks so humans and
   agents work in the correct order.
2. Ship an in-repo skill (`.claude/skills/project-tasks/`) that lets Claude
   add/remove/update tasks, work tasks in priority order, and create tests —
   driven by the superpowers skills.

## Part 1: Priority feature (app)

### Ordering algorithm

Implemented once, as `computePriority(items)` in `server.js`:

- Exclude `status: shipped` items.
- An item is **ready** when every id in `depends` has `status: shipped`
  (or `depends` is empty/absent).
- Order: all ready items first, ranked by transitive dependent count
  (descending — finishing them unblocks the most downstream work); ties by
  id. Then blocked items in topological order of the dependency graph, same
  tie-break.
- Each blocked item carries `blockedBy`: its non-shipped dependency ids.
- Dependency cycles do not crash: items in a cycle are appended last and
  flagged (`cycle: true`); a warning is included in the response, matching
  the existing validation-banner pattern.

### API

`GET /api/priority` →

```json
{
  "items": [
    { "id": "...", "name": "...", "type": "...", "status": "...",
      "spec": "specs/x.md", "ready": true, "blockedBy": [],
      "dependents": 3 }
  ],
  "warnings": []
}
```

### UI

- Third tab "Priority" in `App.jsx` alongside Diagram/Board.
- Ordered list: rank number, name, type, status. Ready items visually
  distinct; blocked items show "blocked by: X, Y". Clicking an item opens
  the existing `DetailPanel`.
- Live-reloads with the rest of the app (same data-refresh path).
- No new npm dependencies.

## Part 2: project-tasks skill

Location: `.claude/skills/project-tasks/SKILL.md` (repo-level, ships with
diagram-copilot). Markdown-only, no scripts. AGENTS.md remains the schema
authority; the skill references it rather than duplicating the schema.

Operations:

- **add / remove / update task** — edit `project.yaml` directly per
  AGENTS.md rules: unique kebab-case ids, valid type/status, fix dangling
  `depends` when removing, never casually delete shipped items, keep
  `depends` accurate.
- **work next** — get the priority order (apply the ordering rules above to
  the yaml, or `GET /api/priority` if the viewer is running), pick the top
  ready item, then:
  - no `spec` → invoke `superpowers:brainstorming` → `superpowers:writing-plans`,
    save spec as `specs/<id>.md`, set `spec:` in the yaml, keep `planned`.
  - has `spec` → implement via `superpowers:executing-plans` /
    `superpowers:test-driven-development`; set `in-progress` at start,
    `shipped` when verified.
- **work <id>** — same flow for a named task; if blocked, warn and list
  `blockedBy` before proceeding.
- **create tests <id>** — drive `superpowers:test-driven-development`
  against the item's spec.

The skill is built following `writing-skills`/`skill-development`
guidance (trigger-rich description, progressive disclosure).

## Testing

- Unit check for `computePriority`: ready-first ordering, dependent-count
  ranking, blocked topological order, cycle flagging — one small node test
  script run against fixture data (no test framework added).
- Manual: `npm start`, verify Priority tab against `example/project.yaml`
  (expected top item: `catalog-api` or `payments` depending on dependent
  counts; `checkout-flow` blocked by `orders-api`, `payments`).
- Skill verified by invoking it against the example project.

## Out of scope

- Manual priority/weight field in project.yaml.
- Editing project.yaml through the UI (stays read-only).
- Multi-project support.
