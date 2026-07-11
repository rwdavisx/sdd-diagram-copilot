---
name: verify
description: Build, launch, and drive the diagram-copilot web app to verify a change end-to-end in a browser
---

# Verifying diagram-copilot changes

## Build + launch

```sh
cd web && npm run build          # server serves web/dist, not vite dev
node server.js project.yaml --port 4497 --no-open   # any free port; 4400 is the user's dogfood server — never take it
```

## Drive

- Open `http://localhost:4497` in a browser (claude-in-chrome works). Tabs: Design, Board, Schemas, Tests, Priority, Workflow.
- SSE live-reload: any write to project.yaml shows in the UI within ~1s (header planned/in-progress/shipped counts are a quick signal).
- API smoke without a browser: `POST /api/items` (`{name,type,notes?}` → `{id}`), plus 400 on bad input and 403 with a foreign `Origin:` header.
- "Brainstorm now" / "Start workflow" launch REAL headless Claude sessions (token cost) — confirm the state flips to running, then press Stop immediately.

## Gotchas

- Verification writes land in project.yaml — `git checkout -- project.yaml` and delete `.superpowers/workflow.json` afterwards.
- In a fresh worktree run `npm ci` at root AND in web/ first.
