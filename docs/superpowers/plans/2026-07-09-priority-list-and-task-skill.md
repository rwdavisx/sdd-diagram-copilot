# Priority List + project-tasks Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dependency-prioritized task list (API + UI tab) to diagram-copilot, and an in-repo `project-tasks` skill that manages/works project.yaml tasks via superpowers skills.

**Architecture:** One `computePriority(items)` function in `server.js` (the only implementation of the ordering), exposed at `GET /api/priority`; a new `PriorityView` React tab fetches it. The skill is markdown-only, tells agents to edit project.yaml directly per AGENTS.md, and hands implementation work to superpowers skills.

**Tech Stack:** Node stdlib `http` server, js-yaml, React + Vite viewer. No test framework — plain `node` scripts with `assert`.

**Spec:** `docs/superpowers/specs/2026-07-09-priority-list-and-task-skill-design.md`

## Global Constraints

- No new npm dependencies anywhere.
- No test framework; tests are plain Node scripts using `assert`, run with `node <file>`.
- The viewer stays read-only; all state lives in project.yaml.
- Item ids are kebab-case; valid `type`: `frontend | backend | integration`; valid `status`: `planned | in-progress | shipped`.
- Follow existing code style in `server.js` / `web/src` (match existing formatting).

---

### Task 1: `computePriority` in server.js + tests

**Files:**
- Modify: `server.js` (add function after `loadProject`, ~line 64; change last line)
- Test: `test/priority.test.js` (new file, new dir)

**Interfaces:**
- Produces: `computePriority(items) -> { items: [{id, name, type, status, spec, ready, blockedBy, dependents, cycle?}], warnings: string[] }`, exported from `server.js` via `module.exports = { loadProject, computePriority }`.

**Ordering rules (from spec):** exclude shipped; ready = every `depends` entry is shipped (missing/dangling ids don't block — validation elsewhere reports them); ready items first sorted by transitive pending-dependent count desc then id asc; then blocked items in topological (Kahn) order with the same tie-break; cycle members appended last, sorted by id, flagged `cycle: true` plus one warning.

- [ ] **Step 1: Write the failing test**

Create `test/priority.test.js`:

```js
// Run: node test/priority.test.js
const assert = require('assert');
const { computePriority } = require('../server.js');

const item = (id, status, depends, type = 'backend') =>
  ({ id, name: id, type, status, ...(depends ? { depends } : {}) });

// Mirrors example/project.yaml shape.
const fixture = [
  item('login-page', 'shipped', ['auth-api'], 'frontend'),
  item('product-list', 'in-progress', ['catalog-api'], 'frontend'),
  item('checkout-flow', 'planned', ['orders-api', 'payments'], 'frontend'),
  item('auth-api', 'shipped'),
  item('catalog-api', 'in-progress'),
  item('orders-api', 'planned', ['payments', 'email']),
  item('payments', 'planned', undefined, 'integration'),
  item('email', 'shipped', undefined, 'integration'),
];

{
  const { items, warnings } = computePriority(fixture);
  // shipped items excluded
  assert.ok(!items.some((i) => ['login-page', 'auth-api', 'email'].includes(i.id)));
  // ready first (payments unblocks 2 transitively, catalog-api 1), then topo order
  assert.deepStrictEqual(items.map((i) => i.id),
    ['payments', 'catalog-api', 'orders-api', 'checkout-flow', 'product-list']);
  assert.strictEqual(items[0].ready, true);
  assert.strictEqual(items[0].dependents, 2);
  assert.strictEqual(items[1].ready, true);
  // blockedBy lists only non-shipped deps
  const orders = items.find((i) => i.id === 'orders-api');
  assert.deepStrictEqual(orders.blockedBy, ['payments']);
  assert.strictEqual(orders.ready, false);
  assert.deepStrictEqual(warnings, []);
}

{
  // cycle: a <-> b flagged, appended after non-cycle items, one warning
  const { items, warnings } = computePriority([
    item('a', 'planned', ['b']),
    item('b', 'planned', ['a']),
    item('c', 'planned'),
  ]);
  assert.deepStrictEqual(items.map((i) => i.id), ['c', 'a', 'b']);
  assert.strictEqual(items[1].cycle, true);
  assert.strictEqual(items[2].cycle, true);
  assert.strictEqual(items[0].cycle, undefined);
  assert.strictEqual(warnings.length, 1);
  assert.ok(warnings[0].includes('a') && warnings[0].includes('b'));
}

{
  // dangling dep does not block readiness
  const { items } = computePriority([item('a', 'planned', ['ghost'])]);
  assert.strictEqual(items[0].ready, true);
  assert.deepStrictEqual(items[0].blockedBy, []);
}

console.log('priority tests: ok');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/priority.test.js`
Expected: FAIL — `TypeError: computePriority is not a function` (server.js exports nothing yet; it may also start the server — that's the `require.main` fix in Step 3).

Note: `require('../server.js')` currently executes `main()` and exits with a usage error. That confirms the test can't pass yet; Step 3 fixes both.

- [ ] **Step 3: Implement**

In `server.js`, insert after the `loadProject` function (after line 64):

```js
// Priority order for non-shipped items: ready items (all depends shipped)
// first, ranked by how much downstream work they unblock, then blocked items
// in dependency order. Cycles are flagged, not fatal.
function computePriority(items) {
  const valid = items.filter((i) => i && typeof i === 'object' && i.id);
  const pendingIds = new Set(valid.filter((i) => i.status !== 'shipped').map((i) => i.id));
  const pending = valid.filter((i) => pendingIds.has(i.id));

  // Deps that block: exist and aren't shipped (dangling ids are reported by loadProject).
  const blockers = (item) =>
    (Array.isArray(item.depends) ? item.depends : []).filter((d) => pendingIds.has(d));

  // Transitive pending dependents: finishing this item helps that many others.
  const dependents = new Map();
  for (const item of pending) {
    const seen = new Set();
    const stack = [item.id];
    while (stack.length) {
      const cur = stack.pop();
      for (const other of pending) {
        if (!seen.has(other.id) && blockers(other).includes(cur)) {
          seen.add(other.id);
          stack.push(other.id);
        }
      }
    }
    dependents.set(item.id, seen.size);
  }

  const byRank = (a, b) =>
    dependents.get(b.id) - dependents.get(a.id) || a.id.localeCompare(b.id);

  // Ready items first, then Kahn's algorithm over the blocked ones.
  // ponytail: O(n^2) frontier rescan; fine for hand-edited project files.
  const ready = pending.filter((i) => blockers(i).length === 0).sort(byRank);
  const done = new Set(ready.map((i) => i.id));
  const ordered = [...ready];
  while (ordered.length < pending.length) {
    const frontier = pending
      .filter((i) => !done.has(i.id) && blockers(i).every((d) => done.has(d)))
      .sort(byRank);
    if (frontier.length === 0) break; // the rest are in a cycle
    done.add(frontier[0].id);
    ordered.push(frontier[0]);
  }
  const inCycle = pending
    .filter((i) => !done.has(i.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  const toEntry = (i, cycle) => ({
    id: i.id, name: i.name, type: i.type, status: i.status, spec: i.spec || null,
    ready: blockers(i).length === 0,
    blockedBy: blockers(i),
    dependents: dependents.get(i.id),
    ...(cycle ? { cycle: true } : {}),
  });
  return {
    items: [...ordered.map((i) => toEntry(i, false)), ...inCycle.map((i) => toEntry(i, true))],
    warnings: inCycle.length
      ? [`Dependency cycle involving: ${inCycle.map((i) => i.id).join(', ')}`]
      : [],
  };
}
```

Then replace the last line of `server.js`:

```js
main();
```

with:

```js
if (require.main === module) main();
module.exports = { loadProject, computePriority };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/priority.test.js`
Expected: `priority tests: ok`

Also verify the server still starts: `node server.js example/project.yaml --no-open --port 4411` (Ctrl-C / kill after seeing the "serving" log lines).

- [ ] **Step 5: Commit**

```bash
git add server.js test/priority.test.js
git commit -m "feat: computePriority - dependency-prioritized ordering of non-shipped items"
```

---

### Task 2: `GET /api/priority` endpoint

**Files:**
- Modify: `server.js` (inside the request handler, right after the `/api/project` block, ~line 103)

**Interfaces:**
- Consumes: `computePriority`, `loadProject` (Task 1).
- Produces: `GET /api/priority` → `200 {"items":[...],"warnings":[...]}` — the shape Task 3's UI and the Task 4 skill rely on.

- [ ] **Step 1: Add the endpoint**

In `server.js`, after the `/api/project` handler block:

```js
    if (url.pathname === '/api/priority') {
      return sendJson(res, 200, computePriority(loadProject(args.yamlPath).items));
    }
```

- [ ] **Step 2: Verify with curl**

```bash
node server.js example/project.yaml --no-open --port 4411 &
sleep 1
curl -s http://localhost:4411/api/priority
kill %1
```

Expected: JSON whose `items` ids are, in order: `payments, catalog-api, orders-api, checkout-flow, product-list`; `payments` and `catalog-api` have `"ready":true`; `warnings` is `[]`.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: GET /api/priority endpoint"
```

---

### Task 3: Priority tab in the viewer

**Files:**
- Create: `web/src/PriorityView.jsx`
- Modify: `web/src/App.jsx` (import; toggle buttons ~line 45-48; view render ~line 59-61)
- Modify: `web/src/App.css` (append rules)

**Interfaces:**
- Consumes: `GET /api/priority` (Task 2); existing `card`, `badge`, `status-*`, `type-*`, `column-empty`, `errors` CSS classes; `DetailPanel` opens via the same `onSelect(id)` mechanism as the other views.
- Produces: `PriorityView({ items, selectedId, onSelect })` component.

- [ ] **Step 1: Create `web/src/PriorityView.jsx`**

```jsx
import { useEffect, useState } from 'react';

export default function PriorityView({ items, selectedId, onSelect }) {
  const [data, setData] = useState(null);

  // Refetch whenever project data changes (items is fresh on every reload).
  useEffect(() => {
    fetch('/api/priority')
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData(null));
  }, [items]);

  if (!data) return <div className="fatal">Loading…</div>;

  return (
    <div className="priority">
      {data.warnings.length > 0 && (
        <div className="errors"><ul>{data.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>
      )}
      <ol className="priority-list">
        {data.items.map((item) => (
          <li key={item.id}>
            <button
              className={`card status-${item.status} ${item.id === selectedId ? 'selected' : ''}`}
              onClick={() => onSelect(item.id)}
            >
              <div className="card-name">{item.name}</div>
              <div className="card-meta">
                <span className={`badge type-${item.type}`}>{item.type}</span>
                {item.spec ? <span className="spec-flag">spec</span>
                  : <span className="spec-flag missing">no spec</span>}
                {item.ready
                  ? <span className="ready-flag">ready{item.dependents > 0 ? ` · unblocks ${item.dependents}` : ''}</span>
                  : <span className="blocked-flag">blocked by: {item.blockedBy.join(', ')}</span>}
                {item.cycle && <span className="blocked-flag">dependency cycle</span>}
              </div>
            </button>
          </li>
        ))}
      </ol>
      {data.items.length === 0 && <div className="column-empty">everything is shipped</div>}
    </div>
  );
}
```

- [ ] **Step 2: Wire into `web/src/App.jsx`**

Add the import next to the other view imports:

```jsx
import PriorityView from './PriorityView.jsx';
```

Add a third toggle button after the Board button:

```jsx
          <button className={view === 'priority' ? 'active' : ''} onClick={() => setView('priority')}>Priority</button>
```

Replace the view ternary in `<main>`:

```jsx
        {view === 'diagram' && <DiagramView items={items} selectedId={selectedId} onSelect={setSelectedId} />}
        {view === 'board' && <BoardView items={items} selectedId={selectedId} onSelect={setSelectedId} />}
        {view === 'priority' && <PriorityView items={items} selectedId={selectedId} onSelect={setSelectedId} />}
```

- [ ] **Step 3: Append styles to `web/src/App.css`**

First skim the existing file to match its color variables/conventions; adjust the colors below to any existing status color vars if present, otherwise use as-is:

```css
/* Priority view */
.priority { padding: 16px; overflow-y: auto; flex: 1; }
.priority-list { max-width: 680px; margin: 0 auto; padding-left: 32px; }
.priority-list li { margin-bottom: 8px; }
.priority-list .card { width: 100%; text-align: left; }
.ready-flag { color: #2e7d32; font-weight: 600; }
.blocked-flag { color: #b26a00; }
```

- [ ] **Step 4: Build and verify**

```bash
npm run build
node server.js example/project.yaml --no-open --port 4411
```

Open `http://localhost:4411`, click the Priority tab. Expected: 5 items in order payments → catalog-api → orders-api → checkout-flow → product-list; first two marked ready ("unblocks 2" / "unblocks 1"); blocked ones show their blockers; clicking an item opens the DetailPanel. Then kill the server.

- [ ] **Step 5: Commit**

```bash
git add web/src/PriorityView.jsx web/src/App.jsx web/src/App.css web/dist
git commit -m "feat: Priority tab - dependency-ordered task list in the viewer"
```

(Include `web/dist` only if the repo already tracks it — check `git status`; it does contain `web/dist/favicon.svg`, but follow whatever `.gitignore` says.)

---

### Task 4: `project-tasks` skill

**Files:**
- Create: `.claude/skills/project-tasks/SKILL.md`

**Interfaces:**
- Consumes: AGENTS.md (schema authority), `GET /api/priority` (optional convenience), superpowers skills by name.
- Produces: a repo-level skill invocable as `project-tasks`.

- [ ] **Step 1: Create `.claude/skills/project-tasks/SKILL.md`**

```markdown
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
```

- [ ] **Step 2: Verify frontmatter parses and structure is sane**

```bash
node -e "const y=require('js-yaml');const s=require('fs').readFileSync('.claude/skills/project-tasks/SKILL.md','utf8');const fm=s.split('---')[1];const d=y.load(fm);if(!d.name||!d.description)throw new Error('bad frontmatter');console.log('skill frontmatter ok:',d.name)"
```

Expected: `skill frontmatter ok: project-tasks`

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/project-tasks/SKILL.md
git commit -m "feat: project-tasks skill - manage and work project.yaml tasks via superpowers"
```

---

## Final verification (after all tasks)

1. `node test/priority.test.js` → `priority tests: ok`
2. `npm run build` succeeds.
3. `node server.js example/project.yaml --no-open` + curl `/api/priority` → expected order.
4. Priority tab renders and DetailPanel opens from it.
5. `.claude/skills/project-tasks/SKILL.md` exists with valid frontmatter.
