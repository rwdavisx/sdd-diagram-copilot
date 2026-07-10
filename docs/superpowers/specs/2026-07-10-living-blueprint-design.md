# Living Blueprint: Planning tab + wireframe diagram with element-anchored flows

## Problem

Plan-project chat was buried in the Workflow tab and the Diagram tab showed only abstract dependency cards. The goal: a "living blueprint" — a dedicated Planning tab (iterative chat + live canvas) where Claude generates real HTML wireframes for frontend screens, rendered on the diagram, with connectors anchored to actual interactive elements (button → page, form → API → data).

## Design decisions

- **Wireframes generated in-app** by the plan-project session, saved as self-contained HTML at `design/wireframes/<item-id>.html` (inline CSS, no `<script>`, no external assets, 800px design width). Auto-detected by convention; an explicit `wireframe:` item field overrides.
- **Flows live in the wireframe HTML** — interactive elements carry `id`, `data-flow-to="<item-id>"`, `data-flow-kind="nav|api|data"`. The server parses these into element-anchored edges; no separate flows registry, so a wireframe and its connections can never drift apart.
- **One canvas**: the existing DiagramView evolved. Items with a wireframe render as `WireframeNode` (scaled same-origin iframe, measured height + anchor positions); everything else keeps the card node. Flow edges (nav solid / api dashed / data dotted) supersede plain `depends` edges over the same pair.
- **Planning tab** = plan-project chat (left, ~400px) + live DiagramView (right). Plan-project moved out of the Workflow tab.
- **Iteration UX**: selecting a frontend screen on the canvas focuses the chat on it; sent messages are prefixed client-side with `[Context: iterating on screen "<id>" — wireframe at <path>]`.

## Architecture

- `server.js`: wireframe detection in `loadProject()` (+ orphan/missing errors), `parseWireframeFlows()`/`loadWireframes()` (regex, no deps), `/design/wireframes/*` route (containment-checked, same-origin), recursive `design/` watcher feeding the shared SSE reload debounce. `/api/project` → `{project, items (with wireframe), errors, flows}`.
- `workflow.js`: `planProjectPrompt()` teaches the session the wireframe + data-flow conventions and the iteration-context prefix. Conventions also documented in `AGENTS.md`.
- `web/src/useWorkflowFeed.jsx`: shared chat plumbing (`post`, `mergeTranscript`, `TranscriptEvent`, `useWorkflowFeed`, `STEP_INFO`) used by WorkflowView and PlanningView.
- `web/src/PlanningView.jsx`: split view, start/stop plan-project, iteration chip + context prefix.
- `web/src/DiagramView.jsx`: `WireframeNode` (iframe, rAF measurement, per-anchor `Handle` + `useUpdateNodeInternals`), variable-size dagre/lane layout, flow edges with `sourceHandle` anchoring; iframes re-key on a `rev` counter bumped per SSE reload.

## Error handling

Declared-but-missing wireframe, orphan wireframe file, and dangling `data-flow-to` targets all surface in the existing error banner; dangling flows are dropped, never rendered. Edges fall back to the node's default handle until the iframe is measured.

## Testing

`test/wireframes.test.js` (node --test): flow parsing permutations, convention detection, declared-missing/orphan/dangling errors. UI verified live against the dogfood server.
