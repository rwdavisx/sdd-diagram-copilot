# Workflow Tab — Driving the Superpowers Pipeline from the Viewer

**Date:** 2026-07-09
**Status:** Approved

## Problem

diagram-copilot is a read-only viewer over a `project.yaml`. Working an item still means switching to a terminal and manually invoking the superpowers workflow (brainstorm → worktree → plan → execute → review → finish). We want the viewer to *drive* that workflow: start it on an item, converse with the brainstorm session, watch subagents implement tasks with TDD, review findings, and finish the branch — all from the browser, with Claude Code running headlessly behind the scenes.

## Decisions

- **Drive, not observe.** The server spawns headless Claude Code sessions; the UI is the control surface.
- **Permissions:** sessions run with `bypassPermissions` (fully autonomous; no approval plumbing).
- **Concurrency:** one active workflow at a time. `POST /api/workflow/start` returns 409 if one is active.
- **Target repo:** whatever repo the served `project.yaml` lives in. diagram-copilot stays a general tool.
- **Architecture:** step-orchestrated pipeline. One bounded session per step, a server-owned state machine, and **artifacts on disk as ground truth** — state survives crashes and restarts.

## Backend

### `sessions.js` — session runner

- Spawns Claude Code via `@anthropic-ai/claude-agent-sdk` (new dependency, the only one besides `js-yaml`).
- Options: `permissionMode: 'bypassPermissions'`, `cwd` = target repo (or its worktree once the worktree step completes), streaming input mode so the browser chat can feed the session mid-run.
- Every SDK message is relayed to the browser over SSE (same pattern as the existing `/api/events`).
- `POST /api/workflow/input {text}` forwards user chat into the active session's input stream.
- Supports interrupt and SDK session resume (for retry after crash/restart).

### `workflow.js` — state machine

- Steps: `brainstorm → worktree → plan → execute → review → finish`.
- Per-step status: `pending | running | needs-attention | interrupted | done`.
- Persisted to `.superpowers/workflow.json` in the target repo: `{ itemId, step, stepStatus, sessionIds, startedAt, worktreePath, branch }`.
- `POST /api/workflow/start {itemId}` — item must exist in project.yaml and not be shipped.
- `GET /api/workflow` — current state (for UI hydration on load).
- Each step spawns one session whose prompt invokes the matching superpowers skill:

| Step | Skill invoked | Completion artifact (server-verified) |
|---|---|---|
| brainstorm | `superpowers:brainstorming` | spec file at `specs/<id>.md` (project-tasks convention) |
| worktree | `superpowers:using-git-worktrees` | worktree dir + branch exist (`git worktree list`) |
| plan | `superpowers:writing-plans` | plan file in `docs/superpowers/plans/` |
| execute | `superpowers:subagent-driven-development` | `.superpowers/sdd/progress.md` shows all tasks complete |
| review | `superpowers:requesting-code-review` | review report file / final structured message |
| finish | `superpowers:finishing-a-development-branch` | branch merged or PR created; worktree cleaned |

- **Completion is artifact-based.** When a step's session ends, the server checks for the artifact. Present → step `done`, next step unlocked (auto-advance). Absent → `needs-attention`, with retry (fresh session) or follow-up (resume with a user message).
- After the worktree step, subsequent sessions run with `cwd` = the worktree path.
- The finish step's merge/PR/keep/discard question surfaces as buttons in the UI; the choice is sent back as chat input. Shipping flips the item's status in project.yaml (per AGENTS.md rules the skills already follow), which the existing live-reload picks up.

### Stream parsing (execute step)

The execute session dispatches per-task subagents itself (that is what the SDD skill does). The server derives live UI state from the message stream:

- `Task` tool_use / tool_result → subagent lifecycle per task (dispatched, finished).
- `Bash` tool calls matching test commands + their results → TDD red/green events per task.
- `TodoWrite` → task checklist state.

Parsed events feed the task grid and TDD timeline. Ground truth remains `progress.md`, task reports, and git commits — stream parsing is presentation, not state.

### Error handling

- Session crash / non-zero exit → step `needs-attention`.
- Server restart → reload `workflow.json`; any step that was `running` becomes `interrupted` (its process is gone) with a resume button (SDK resume by session id) and a retry button.
- Artifacts on disk mean no work is lost in either case.

## Frontend (`web/src`)

- **Workflow** — fourth tab in `App.jsx` alongside Diagram/Board/Priority.
- **Entry:** "Start workflow" button on non-shipped items in `PriorityView.jsx` and `DetailPanel.jsx`; navigates to the Workflow tab.
- **Layout:**
  - Left rail: six-step pipeline stepper with per-step status and links to artifacts (spec, plan, review report) rendered with the existing markdown viewer (`/api/spec`).
  - Center: transcript pane — streaming assistant markdown, collapsed tool-call chips (e.g. `Edit src/foo.js`, `Bash npm test ✓`), chat input box. This is where brainstorming questions get answered.
  - Step panel (contextual):
    - *Execute:* task grid from the plan — per-task status (queued / agent running / review / done) and a red→green TDD dot timeline from parsed test runs.
    - *Review:* findings listed by severity; critical findings visibly block finish.
    - *Finish:* merge / PR / keep / discard buttons.
- Existing tabs untouched. project.yaml edits made by sessions arrive via the existing SSE live-reload.

## Implementation decomposition

Sequential sub-projects, each with its own superpowers plan:

1. **workflow-session-runner** — SDK integration, SSE relay, input endpoint, Workflow tab with transcript + chat, start + brainstorm step only.
2. **workflow-orchestration** — full state machine, all six step prompts, artifact detection, persistence, stepper UI.
3. **workflow-execute-viz** — stream parsing, task grid, TDD red/green timeline, review findings panel.
4. **workflow-finish-polish** — finish buttons, resume/retry, interrupted/error states.

## Testing

- Unit (Node test runner, alongside `test/priority.test.js`): state-machine transitions; stream-parsing against fixture stream-json transcripts; artifact-detection checks.
- E2E: `npm run build && node server.js example/project.yaml`; start a workflow on a small example item, drive the brainstorm chat from the browser, confirm the spec file lands and the step auto-advances. Later phases: a full pipeline through merge on a scratch repo.

## Out of scope

- Multiple concurrent workflows.
- Permission prompting in the UI (bypassPermissions chosen deliberately).
- Editing project.yaml from the viewer (AGENTS.md rule: the yaml is agent/human edited).
