# New Idea Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add new feature ideas to project.yaml from the browser — quick backlog capture, or capture + immediately start a fresh brainstorm session.

**Architecture:** One new server function (`addProjectItem`, line-targeted comment-preserving yaml append, same style as the existing `updateProjectItem`) exposed as `POST /api/items`, plus a "New idea" mini-form in the Workflow tab that calls it and optionally chains into the existing `/api/workflow/start` brainstorm step. No prompt or pipeline changes.

**Tech Stack:** Node (no framework) server, `node --test` for tests, React + @astryxdesign/core in `web/`, vite build.

**Spec:** `docs/superpowers/specs/2026-07-11-new-idea-intake-design.md`

## Global Constraints

- YAML edits must be line-targeted and preserve comments/formatting (never a js-yaml round-trip dump).
- Item `type` must be one of `frontend | backend | integration`; new items get `status: planned`.
- New items append at the end of the `items:` list — never after later top-level keys like `workflow:`.
- The UI gains exactly one write affordance (create planned item); all other state stays workflow/agent-owned.
- After web changes: rebuild `web/dist` (`npm run build` in `web/`) — the server serves the built bundle.

---

### Task 1: `addProjectItem` in server.js

**Files:**
- Modify: `server.js` (add function near `updateProjectItem` ~line 277; add to `module.exports` line ~530)
- Test: `test/add-item.test.js` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `addProjectItem(yamlPath, { name, type, notes }) → { id } | { error }` — exported from `server.js`. Task 2's route calls it.

- [ ] **Step 1: Write the failing tests**

Create `test/add-item.test.js`:

```js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { addProjectItem } = require('../server');

const YAML = `project: Test # keep me
items:
  - id: feat-a
    name: Feature A
    type: frontend
    status: planned
workflow:
  defaults: { model: sonnet }
`;

let file;
beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-')), 'project.yaml');
  fs.writeFileSync(file, YAML);
});

test('appends a planned item inside the items list, not after workflow:', () => {
  const r = addProjectItem(file, { name: 'PNG Export', type: 'frontend', notes: 'export: diagrams as "png"' });
  assert.strictEqual(r.id, 'png-export');
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(doc.items.length, 2);
  assert.deepStrictEqual(doc.items[1], {
    id: 'png-export', name: 'PNG Export', type: 'frontend',
    status: 'planned', notes: 'export: diagrams as "png"',
  });
  assert.deepStrictEqual(doc.workflow, { defaults: { model: 'sonnet' } }); // untouched
  assert.match(fs.readFileSync(file, 'utf8'), /# keep me/); // comments preserved
});

test('suffixes the id on collision', () => {
  assert.strictEqual(addProjectItem(file, { name: 'Feat A!!', type: 'backend' }).id, 'feat-a-2');
  assert.strictEqual(addProjectItem(file, { name: 'feat a', type: 'backend' }).id, 'feat-a-3');
});

test('omits notes when blank', () => {
  addProjectItem(file, { name: 'Thing', type: 'backend', notes: '  ' });
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(doc.items[1].notes, undefined);
});

test('handles an empty inline items list', () => {
  fs.writeFileSync(file, 'project: Empty\nitems: []\n');
  const r = addProjectItem(file, { name: 'First', type: 'frontend' });
  assert.strictEqual(r.id, 'first');
  assert.strictEqual(yaml.load(fs.readFileSync(file, 'utf8')).items[0].id, 'first');
});

test('rejects bad input and leaves the file alone', () => {
  assert.ok(addProjectItem(file, { name: '', type: 'frontend' }).error);
  assert.ok(addProjectItem(file, { name: 'x', type: 'db' }).error);
  assert.ok(addProjectItem(file, { name: '!!!', type: 'frontend' }).error);
  assert.ok(addProjectItem(file, {}).error);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), YAML);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/add-item.test.js`
Expected: FAIL — `addProjectItem is not a function`.

- [ ] **Step 3: Implement `addProjectItem`**

In `server.js`, directly below `updateProjectItem` (after its closing brace, ~line 295):

```js
const ITEM_TYPES = ['frontend', 'backend', 'integration'];

// Append a new planned item at the end of the `items:` list with a
// line-targeted edit (comment-preserving, like updateProjectItem above).
// Returns { id } on success or { error } on invalid input.
function addProjectItem(yamlPath, { name, type, notes } = {}) {
  name = String(name || '').trim();
  if (!name) return { error: 'name required' };
  if (!ITEM_TYPES.includes(type)) return { error: `type must be one of: ${ITEM_TYPES.join(', ')}` };
  let text;
  try { text = fs.readFileSync(yamlPath, 'utf8'); } catch { return { error: `Cannot read ${yamlPath}` }; }
  const lines = text.split('\n');
  const itemsAt = lines.findIndex((l) => /^items:/.test(l));
  if (itemsAt === -1) return { error: 'project.yaml has no items: list' };

  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!base) return { error: 'name must contain letters or numbers' };
  const ids = new Set();
  for (const l of lines) {
    const m = l.match(/^\s*-\s+id:\s*(\S+)/);
    if (m) ids.add(m[1]);
  }
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;

  notes = String(notes || '').trim();
  const block = [
    `  - id: ${id}`,
    `    name: ${JSON.stringify(name)}`,
    `    type: ${type}`,
    '    status: planned',
    ...(notes ? [`    notes: ${JSON.stringify(notes)}`] : []),
  ];
  // End of the items list = the next top-level key, else EOF; back up over
  // trailing blank lines so the block lands inside the list.
  let end = lines.length;
  for (let i = itemsAt + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) { end = i; break; }
  }
  while (end > itemsAt + 1 && lines[end - 1].trim() === '') end--;
  if (/^items:\s*\[\s*\]\s*$/.test(lines[itemsAt])) lines[itemsAt] = 'items:';
  lines.splice(end, 0, ...block);
  fs.writeFileSync(yamlPath, lines.join('\n'));
  return { id };
}
```

Note: `JSON.stringify` produces a double-quoted YAML scalar — always valid, handles `:` and quotes in names/notes.

Add `addProjectItem` to the exports line at the bottom of `server.js`:

```js
module.exports = { loadProject, computePriority, updateProjectItem, addProjectItem, parseWireframeFlows, loadWireframes, planInfo };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/add-item.test.js`
Expected: all 5 tests PASS. Then run the full suite: `npm test` — everything passes.

- [ ] **Step 5: Commit**

```bash
git add test/add-item.test.js server.js
git commit -m "feat: addProjectItem — comment-preserving append of a planned item"
```

---

### Task 2: `POST /api/items` route

**Files:**
- Modify: `server.js` — inside `main()`'s `http.createServer` handler, after the `/api/workflow/input` block (~line 459)

**Interfaces:**
- Consumes: `addProjectItem` from Task 1; existing `readBody`, `originAllowed`, `sendJson`.
- Produces: `POST /api/items` with JSON body `{ name, type, notes? }` → `200 { id }` or `400/403 { error }`. Task 3's form calls it.

- [ ] **Step 1: Add the route**

Insert after the `/api/workflow/input` handler block:

```js
    if (url.pathname === '/api/items' && req.method === 'POST') {
      if (!originAllowed(req, args.port)) return sendJson(res, 403, { error: 'Cross-origin request rejected' });
      return readBody(req).then((body) => {
        let fields = null;
        try { fields = JSON.parse(body); } catch { /* handled below */ }
        if (!fields || typeof fields !== 'object') return sendJson(res, 400, { error: 'Invalid request body' });
        const r = addProjectItem(args.yamlPath, fields);
        return r.error ? sendJson(res, 400, { error: r.error }) : sendJson(res, 200, r);
      }).catch(() => sendJson(res, 400, { error: 'Invalid request body' }));
    }
```

- [ ] **Step 2: Verify end-to-end with curl against a scratch project**

```bash
cd "$(mktemp -d)" && printf 'project: Scratch\nitems: []\n' > project.yaml
node /c/Users/rwdav/dev/diagram-copilot/server.js project.yaml --port 4499 --no-open &
sleep 1
curl -s -X POST localhost:4499/api/items -H 'Content-Type: application/json' -d '{"name":"PNG Export","type":"frontend","notes":"export diagrams"}'
curl -s -X POST localhost:4499/api/items -H 'Content-Type: application/json' -d '{"name":"x","type":"db"}'
cat project.yaml
kill %1
```

Expected: first curl prints `{"id":"png-export"}`; second prints a 400 `{"error":"type must be one of: ..."}`; `project.yaml` shows the appended item with `status: planned`.

- [ ] **Step 3: Run the test suite (regression)**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: POST /api/items — create a planned item from the browser"
```

---

### Task 3: "New idea" form in the Workflow tab + AGENTS.md amendment

**Files:**
- Modify: `web/src/WorkflowView.jsx`
- Modify: `AGENTS.md` (~line 5–7, the "read-only" sentence)

**Interfaces:**
- Consumes: `POST /api/items` (Task 2), existing `POST /api/workflow/start`, `post` helper from `useWorkflowFeed.jsx`, `TextInput`/`Selector`/`Button`/`HStack`/`VStack`/`Text` from @astryxdesign/core.
- Produces: `<NewIdeaForm onSelect={fn} />` rendered in both start locations of `WorkflowView`.

- [ ] **Step 1: Add the `NewIdeaForm` component**

In `web/src/WorkflowView.jsx`, add imports:

```jsx
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
```

Add below `StartControls`:

```jsx
const TYPE_OPTIONS = ['frontend', 'backend', 'integration'].map((t) => ({ value: t, label: t }));

// The UI's single write affordance: seed a planned item in project.yaml —
// optionally starting a fresh brainstorm session on it right away. All other
// state transitions stay workflow/agent-owned.
function NewIdeaForm({ onSelect }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('frontend');
  const [idea, setIdea] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const create = async (brainstorm) => {
    setBusy(true);
    setError(null);
    const r = await post('/api/items', { name, type, notes: idea });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { setError(data.error || 'Failed to add item'); setBusy(false); return; }
    setName(''); setIdea(''); setBusy(false);
    if (!brainstorm) return;
    const s = await post('/api/workflow/start', { itemId: data.id, step: 'brainstorm' });
    if (!s.ok) {
      const err = await s.json().catch(() => ({}));
      setError(`"${data.id}" is in the backlog, but brainstorm couldn't start: ${err.error || 'unknown error'}`);
    }
    onSelect(data.id);
  };

  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      <Text type="body">New idea:</Text>
      <TextInput label="Idea name" isLabelHidden size="sm" placeholder="Name (e.g. PNG export)" value={name} onChange={setName} />
      <Selector label="Type" isLabelHidden size="sm" value={type} onChange={setType} options={TYPE_OPTIONS} />
      <TextInput label="What is it?" isLabelHidden size="sm" placeholder="One-liner (optional)" value={idea} onChange={setIdea} />
      <Button label="Add to backlog" variant="ghost" size="sm" isDisabled={busy || !name.trim()} onClick={() => create(false)} />
      <Button label="Brainstorm now" variant="primary" size="sm" isDisabled={busy || !name.trim()} onClick={() => create(true)} />
      {error && <Text type="supporting" size="xsm">{error}</Text>}
    </HStack>
  );
}
```

- [ ] **Step 2: Render it in both start locations**

Empty state (the `actions={<StartControls …/>}` prop, ~line 157) — stack the two:

```jsx
actions={(
  <VStack gap={3}>
    <StartControls items={startable} selectedId={selectedId} onSelect={onSelect} />
    <NewIdeaForm onSelect={onSelect} />
  </VStack>
)}
```

"Start something else" row (~line 191) — add the form as a sibling line below `StartControls`:

```jsx
{!running && !gated && (
  <>
    <StartControls items={startable} selectedId={selectedId} onSelect={onSelect} prompt="Start something else:" />
    <NewIdeaForm onSelect={onSelect} />
  </>
)}
```

Also update the empty-state `description` text (~line 156) so the no-selection copy mentions the form: change `'Pick an item to take through the pipeline above. To plan the whole project first, use the Design tab.'` to `'Pick an item to take through the pipeline, or type a new idea below. To plan the whole project first, use the Design tab.'`

- [ ] **Step 3: Amend AGENTS.md**

In `AGENTS.md` lines 5–7, change:

```
what exists, what's being built, and what's still just an idea. **Agents read
and edit `project.yaml` directly — never through the viewer** (the UI is
read-only by design).
```

to:

```
what exists, what's being built, and what's still just an idea. **Agents read
and edit `project.yaml` directly — never through the viewer** (the UI's only
write is the New idea form, which seeds a planned item; everything else is
read-only by design).
```

- [ ] **Step 4: Lint and build the web app**

```bash
cd web && npm run lint && npm run build
```

Expected: lint clean, vite build succeeds (updates `web/dist`).

- [ ] **Step 5: Verify in the running app**

Restart the dogfood server (root project.yaml, port 4400), open the Workflow tab:
- Type a name, pick a type, click **Add to backlog** → item appears on the Design tab diagram within a second (live reload), form clears.
- Type another idea, click **Brainstorm now** → tab flips to the running brainstorm session seeded with the idea text.
- Click **Add to backlog** with an empty name → button disabled.

Remove any items created during verification from the root `project.yaml` afterwards.

- [ ] **Step 6: Commit**

```bash
git add web/src/WorkflowView.jsx web/dist AGENTS.md
git commit -m "feat: New idea form — backlog capture + brainstorm-now from the Workflow tab"
```
