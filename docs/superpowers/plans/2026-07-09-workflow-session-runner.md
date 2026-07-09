# Workflow Session Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the viewer start a superpowers brainstorm on a project.yaml item and chat with the headless Claude Code session from the browser — sub-project 1 of `docs/superpowers/specs/2026-07-09-workflow-tab-design.md`.

**Architecture:** A pushable async-iterable input queue feeds `query()` from `@anthropic-ai/claude-agent-sdk` (streaming input mode). SDK messages are flattened into small UI events, relayed to the browser over the existing SSE channel, and buffered server-side so page reloads re-hydrate. A minimal workflow object (single step: `brainstorm`) owns the active session, persists to `.superpowers/workflow.json`, and marks the step done when the spec artifact `specs/<itemId>.md` appears on disk.

**Tech Stack:** Node built-in `http` server (CommonJS, no framework), `@anthropic-ai/claude-agent-sdk` (ESM — loaded via dynamic `import()`), React 19 + Vite in `web/`, Node built-in test runner.

## Global Constraints

- Root JS is CommonJS (`require`/`module.exports`), matching `server.js`. The Agent SDK is ESM-only: load it with `await import('@anthropic-ai/claude-agent-sdk')` — never top-level `require`.
- Only new runtime dependency allowed: `@anthropic-ai/claude-agent-sdk` (root `package.json`). No Express, no ws, no other additions.
- Sessions run with `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`, `systemPrompt: { type: 'preset', preset: 'claude_code' }`, `settingSources: ['user', 'project']` (required so superpowers plugin skills load).
- Tests use the Node built-in test runner: `node --test test/` from the repo root (pattern: `test/priority.test.js`).
- Frontend lint: `npm --prefix web run lint` (oxlint). Build: `npm run build`.
- One active workflow at a time; server-side state is the single source of truth for the transcript (the client never fabricates transcript entries).

## File Structure

- `sessions.js` (new) — input queue, SDK message → UI event flattening, `startSession` wrapper. No knowledge of workflows.
- `workflow.js` (new) — the single-workflow state object: start/input/state/transcript, persistence, brainstorm completion detection. No HTTP knowledge; dependencies injected.
- `server.js` (modify) — three `/api/workflow*` routes + SSE `workflow` event broadcast + `readBody` helper.
- `web/src/WorkflowView.jsx` (new) — transcript + chat + start picker.
- `web/src/App.jsx`, `web/src/PriorityView.jsx`, `web/src/DetailPanel.jsx`, `web/src/App.css` (modify) — fourth tab, start buttons, styles.
- `test/sessions.test.js`, `test/workflow.test.js` (new).

## UI Event Vocabulary (shared contract)

Everything that flows over SSE (`event: workflow`) and sits in the transcript buffer is one of:

| kind | fields | source |
|---|---|---|
| `session-start` | `sessionId`, `model` | SDK `system/init` message |
| `assistant-text` | `text` | assistant text blocks |
| `tool-use` | `name`, `summary` | assistant tool_use blocks |
| `turn-end` | `ok`, `costUsd` | SDK `result` message (per turn in streaming mode) |
| `user-text` | `text` | `workflow.input()` echoes the user's chat message |
| `workflow` | `state` | workflow state changes (not stored in transcript) |

Workflow state shape: `{ itemId, step: 'brainstorm', stepStatus: 'running'|'done'|'needs-attention'|'interrupted', sessionId, startedAt, error? }`.

---

### Task 1: sessions.js — input queue and message flattening

**Files:**
- Create: `sessions.js`
- Create: `test/sessions.test.js`
- Modify: `package.json` (add `"test": "node --test test/"` to scripts)

**Interfaces:**
- Produces: `createInputQueue()` → `{ push(msg): boolean, close(): void, closed: boolean, [Symbol.asyncIterator]() }`; `userMessage(text)` → SDK user message object; `summarizeToolInput(name, input)` → string; `toUiEvents(sdkMessage)` → array of UI events (see vocabulary table).

- [ ] **Step 1: Add the test script to package.json**

In `package.json` scripts:

```json
"scripts": {
  "start": "node server.js example/project.yaml",
  "build": "npm --prefix web run build",
  "test": "node --test test/"
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/sessions.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createInputQueue, userMessage, toUiEvents } = require('../sessions');

test('queue yields pushed messages in order, ends on close', async () => {
  const q = createInputQueue();
  q.push('a');
  q.push('b');
  q.close();
  const out = [];
  for await (const m of q) out.push(m);
  assert.deepStrictEqual(out, ['a', 'b']);
});

test('queue delivers messages pushed while a consumer is waiting', async () => {
  const q = createInputQueue();
  const consumer = (async () => {
    for await (const m of q) return m;
  })();
  setImmediate(() => q.push('late'));
  assert.strictEqual(await consumer, 'late');
});

test('push after close is refused', () => {
  const q = createInputQueue();
  q.close();
  assert.strictEqual(q.push('x'), false);
  assert.strictEqual(q.closed, true);
});

test('userMessage wraps text in the SDK user message shape', () => {
  assert.deepStrictEqual(userMessage('hi'), {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    parent_tool_use_id: null,
    session_id: '',
  });
});

test('toUiEvents: system init -> session-start', () => {
  const events = toUiEvents({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' });
  assert.deepStrictEqual(events, [{ kind: 'session-start', sessionId: 's1', model: 'm' }]);
});

test('toUiEvents: assistant text + tool_use blocks', () => {
  const events = toUiEvents({
    type: 'assistant',
    message: { content: [
      { type: 'text', text: 'Thinking about it.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: 'a.js' } },
      { type: 'text', text: '   ' },
    ] },
  });
  assert.deepStrictEqual(events, [
    { kind: 'assistant-text', text: 'Thinking about it.' },
    { kind: 'tool-use', name: 'Bash', summary: 'npm test' },
    { kind: 'tool-use', name: 'Edit', summary: 'a.js' },
  ]);
});

test('toUiEvents: result -> turn-end', () => {
  const events = toUiEvents({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.5 });
  assert.deepStrictEqual(events, [{ kind: 'turn-end', ok: true, costUsd: 0.5 }]);
});

test('toUiEvents: irrelevant messages produce nothing', () => {
  assert.deepStrictEqual(toUiEvents({ type: 'user' }), []);
  assert.deepStrictEqual(toUiEvents(null), []);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/sessions.test.js`
Expected: FAIL — `Cannot find module '../sessions'`

- [ ] **Step 4: Write the implementation**

Create `sessions.js`:

```js
// sessions.js — headless Claude Code session plumbing for workflow steps.
// CommonJS; the ESM-only Agent SDK is loaded via dynamic import() in Task 2.

// Async-iterable queue: HTTP handlers push user messages in while the SDK
// reads them out. Closing ends the iteration (and thus the session).
function createInputQueue() {
  const pending = [];
  let notify = null;
  let closed = false;
  return {
    push(msg) {
      if (closed) return false;
      pending.push(msg);
      if (notify) { const n = notify; notify = null; n(); }
      return true;
    },
    close() {
      closed = true;
      if (notify) { const n = notify; notify = null; n(); }
    },
    get closed() { return closed; },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (pending.length) yield pending.shift();
        if (closed) return;
        await new Promise((resolve) => { notify = resolve; });
      }
    },
  };
}

function userMessage(text) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '',
  };
}

// Short human label for a tool call, e.g. "Bash: npm test" -> shown as a chip.
function summarizeToolInput(name, input = {}) {
  for (const key of ['command', 'file_path', 'skill', 'description', 'pattern']) {
    if (input[key]) return String(input[key]);
  }
  return '';
}

// Flatten one SDK message into zero or more small UI events (see plan table).
function toUiEvents(msg) {
  if (!msg || typeof msg !== 'object') return [];
  if (msg.type === 'system' && msg.subtype === 'init') {
    return [{ kind: 'session-start', sessionId: msg.session_id, model: msg.model }];
  }
  if (msg.type === 'assistant') {
    const events = [];
    for (const block of (msg.message && msg.message.content) || []) {
      if (block.type === 'text' && block.text.trim()) {
        events.push({ kind: 'assistant-text', text: block.text });
      } else if (block.type === 'tool_use') {
        events.push({ kind: 'tool-use', name: block.name, summary: summarizeToolInput(block.name, block.input) });
      }
    }
    return events;
  }
  if (msg.type === 'result') {
    return [{ kind: 'turn-end', ok: msg.subtype === 'success' && !msg.is_error, costUsd: msg.total_cost_usd ?? null }];
  }
  return [];
}

module.exports = { createInputQueue, userMessage, summarizeToolInput, toUiEvents };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/sessions.test.js`
Expected: PASS (8 tests)

- [ ] **Step 6: Commit**

```bash
git add sessions.js test/sessions.test.js package.json
git commit -m "feat: session input queue and SDK message flattening"
```

---

### Task 2: sessions.js — startSession wrapper around the Agent SDK

**Files:**
- Modify: `sessions.js` (append `startSession`, extend exports)
- Modify: `test/sessions.test.js` (append tests)
- Modify: `package.json` (dependency added by `npm install`)

**Interfaces:**
- Consumes: `createInputQueue`, `userMessage`, `toUiEvents` from Task 1.
- Produces: `startSession({ initialPrompt, cwd, resume?, onEvent, queryFn? })` → `{ send(text): boolean, close(): void, interrupt(): Promise<void>, done: Promise<{ ok, sessionId, error? }> }`. `queryFn(args)` defaults to the real SDK `query`; injectable for tests. `onEvent` receives UI events from the vocabulary table.

- [ ] **Step 1: Install the SDK**

Run from repo root: `npm install @anthropic-ai/claude-agent-sdk`
Expected: `package.json` dependencies gains `@anthropic-ai/claude-agent-sdk`; install succeeds.

- [ ] **Step 2: Write the failing tests**

Append to `test/sessions.test.js`:

```js
const { startSession } = require('../sessions');

function fakeQueryFn(messages, { onPrompt } = {}) {
  return async ({ prompt }) => {
    if (onPrompt) onPrompt(prompt);
    return (async function* () {
      for (const m of messages) yield m;
    })();
  };
}

test('startSession relays flattened events and resolves done with the session id', async () => {
  const seen = [];
  const session = startSession({
    initialPrompt: 'go',
    cwd: '.',
    onEvent: (ev) => seen.push(ev),
    queryFn: fakeQueryFn([
      { type: 'system', subtype: 'init', session_id: 'sid-1', model: 'm' },
      { type: 'assistant', session_id: 'sid-1', message: { content: [{ type: 'text', text: 'hello' }] } },
      { type: 'result', subtype: 'success', is_error: false, session_id: 'sid-1', total_cost_usd: 0.1 },
    ]),
  });
  const result = await session.done;
  assert.deepStrictEqual(result, { ok: true, sessionId: 'sid-1' });
  assert.deepStrictEqual(seen.map((e) => e.kind), ['session-start', 'assistant-text', 'turn-end']);
});

test('startSession seeds the input stream with the initial prompt', async () => {
  let captured;
  const session = startSession({
    initialPrompt: 'the initial prompt',
    cwd: '.',
    onEvent: () => {},
    queryFn: async ({ prompt }) => {
      const first = await prompt[Symbol.asyncIterator]().next();
      captured = first.value;
      return (async function* () {})();
    },
  });
  await session.done;
  assert.strictEqual(captured.message.content[0].text, 'the initial prompt');
});

test('startSession resolves done with ok:false when the SDK throws', async () => {
  const session = startSession({
    initialPrompt: 'go',
    cwd: '.',
    onEvent: () => {},
    queryFn: async () => { throw new Error('spawn failed'); },
  });
  const result = await session.done;
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /spawn failed/);
});

test('send() after close() is refused', async () => {
  const session = startSession({
    initialPrompt: 'go',
    cwd: '.',
    onEvent: () => {},
    queryFn: fakeQueryFn([]),
  });
  await session.done;
  assert.strictEqual(session.send('more'), false);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/sessions.test.js`
Expected: FAIL — `startSession is not a function`

- [ ] **Step 4: Write the implementation**

Append to `sessions.js` (above `module.exports`) and extend the exports line:

```js
async function defaultQueryFn(args) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  return query(args);
}

// Start a headless Claude Code session with streaming input. The session
// stays alive across turns until close() (or an SDK error) ends it.
function startSession({ initialPrompt, cwd, resume, onEvent, queryFn = defaultQueryFn }) {
  const input = createInputQueue();
  input.push(userMessage(initialPrompt));
  let q = null;
  let sessionId = resume || null;

  const done = (async () => {
    try {
      q = await queryFn({
        prompt: input,
        options: {
          cwd,
          resume,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          settingSources: ['user', 'project'],
        },
      });
      for await (const msg of q) {
        if (msg.session_id) sessionId = msg.session_id;
        for (const ev of toUiEvents(msg)) onEvent(ev);
      }
      return { ok: true, sessionId };
    } catch (e) {
      return { ok: false, sessionId, error: e.message };
    } finally {
      input.close();
    }
  })();

  return {
    send: (text) => input.push(userMessage(text)),
    close: () => input.close(),
    interrupt: async () => { if (q && q.interrupt) await q.interrupt().catch(() => {}); },
    done,
  };
}

module.exports = { createInputQueue, userMessage, summarizeToolInput, toUiEvents, startSession };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/sessions.test.js`
Expected: PASS (12 tests)

- [ ] **Step 6: Commit**

```bash
git add sessions.js test/sessions.test.js package.json package-lock.json
git commit -m "feat: startSession wrapper around the Agent SDK"
```

---

### Task 3: workflow.js — single-workflow state with brainstorm step

**Files:**
- Create: `workflow.js`
- Create: `test/workflow.test.js`

**Interfaces:**
- Consumes: a `runSession` function with `startSession`'s exact signature (Task 2) — injected, so tests use a fake.
- Produces: `createWorkflow({ projectDir, loadItems, runSession, broadcast })` → `{ start(itemId): { state } | { error, code }, input(text): boolean, getState(): state|null, getTranscript(): event[] }`. `loadItems()` returns project.yaml items (`{ id, name, status, notes? }`). `broadcast(event)` is called for every transcript event and every `{ kind: 'workflow', state }` change. Also exports `brainstormPrompt(item)` → string.

- [ ] **Step 1: Write the failing tests**

Create `test/workflow.test.js`:

```js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkflow, brainstormPrompt } = require('../workflow');

const ITEMS = [
  { id: 'feat-a', name: 'Feature A', status: 'planned', notes: 'some notes' },
  { id: 'feat-b', name: 'Feature B', status: 'shipped' },
];

let dir, sessions, broadcasts;
function fakeRunSession(args) {
  const session = {
    args,
    sent: [],
    closed: false,
    send(text) { this.sent.push(text); return !this.closed; },
    close() { this.closed = true; },
    interrupt: async () => {},
  };
  session.done = new Promise((resolve) => { session.finish = resolve; });
  sessions.push(session);
  return session;
}
function makeWorkflow() {
  return createWorkflow({
    projectDir: dir,
    loadItems: () => ITEMS,
    runSession: fakeRunSession,
    broadcast: (ev) => broadcasts.push(ev),
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  sessions = [];
  broadcasts = [];
});

test('start rejects unknown and shipped items', () => {
  const wf = makeWorkflow();
  assert.strictEqual(wf.start('nope').code, 400);
  assert.strictEqual(wf.start('feat-b').code, 400);
  assert.strictEqual(sessions.length, 0);
});

test('start spawns a brainstorm session and persists running state', () => {
  const wf = makeWorkflow();
  const { state } = wf.start('feat-a');
  assert.strictEqual(state.step, 'brainstorm');
  assert.strictEqual(state.stepStatus, 'running');
  assert.strictEqual(sessions.length, 1);
  assert.match(sessions[0].args.initialPrompt, /superpowers:brainstorming/);
  assert.match(sessions[0].args.initialPrompt, /specs\/feat-a\.md/);
  assert.match(sessions[0].args.initialPrompt, /some notes/);
  assert.strictEqual(sessions[0].args.cwd, dir);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, '.superpowers', 'workflow.json'), 'utf8'));
  assert.strictEqual(saved.itemId, 'feat-a');
});

test('start returns 409 while a workflow is running', () => {
  const wf = makeWorkflow();
  wf.start('feat-a');
  assert.strictEqual(wf.start('feat-a').code, 409);
});

test('input echoes user-text to transcript/broadcast and forwards to the session', () => {
  const wf = makeWorkflow();
  wf.start('feat-a');
  assert.strictEqual(wf.input('my answer'), true);
  assert.deepStrictEqual(sessions[0].sent, ['my answer']);
  assert.deepStrictEqual(wf.getTranscript().at(-1), { kind: 'user-text', text: 'my answer' });
  assert.ok(broadcasts.some((e) => e.kind === 'user-text'));
});

test('input is refused with no running workflow', () => {
  const wf = makeWorkflow();
  assert.strictEqual(wf.input('hello'), false);
});

test('turn-end without the spec artifact keeps the step running', () => {
  const wf = makeWorkflow();
  wf.start('feat-a');
  sessions[0].args.onEvent({ kind: 'turn-end', ok: true, costUsd: 0 });
  assert.strictEqual(wf.getState().stepStatus, 'running');
});

test('turn-end with specs/<id>.md present completes the step and closes the session', () => {
  const wf = makeWorkflow();
  wf.start('feat-a');
  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'specs', 'feat-a.md'), '# spec');
  sessions[0].args.onEvent({ kind: 'turn-end', ok: true, costUsd: 0 });
  assert.strictEqual(wf.getState().stepStatus, 'done');
  assert.strictEqual(sessions[0].closed, true);
});

test('session ending while still running marks needs-attention', async () => {
  const wf = makeWorkflow();
  wf.start('feat-a');
  sessions[0].finish({ ok: true, sessionId: 's1' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(wf.getState().stepStatus, 'needs-attention');
});

test('session-start records the session id', () => {
  const wf = makeWorkflow();
  wf.start('feat-a');
  sessions[0].args.onEvent({ kind: 'session-start', sessionId: 'sid-9', model: 'm' });
  assert.strictEqual(wf.getState().sessionId, 'sid-9');
});

test('a persisted running workflow loads as interrupted after restart', () => {
  const wf = makeWorkflow();
  wf.start('feat-a');
  const wf2 = makeWorkflow(); // simulates a fresh server process
  assert.strictEqual(wf2.getState().stepStatus, 'interrupted');
});

test('brainstormPrompt omits the notes line when the item has none', () => {
  assert.doesNotMatch(brainstormPrompt({ id: 'x', name: 'X' }), /notes/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/workflow.test.js`
Expected: FAIL — `Cannot find module '../workflow'`

- [ ] **Step 3: Write the implementation**

Create `workflow.js`:

```js
// workflow.js — the single active workflow: which item, which step, its
// session, and a transcript buffer so browser reloads can re-hydrate.
// Phase 1 implements only the brainstorm step; later steps extend `step`.
const fs = require('fs');
const path = require('path');

function brainstormPrompt(item) {
  return `You are working on the item "${item.id}" ("${item.name}") from this project's project.yaml.
Use the superpowers:brainstorming skill to refine this idea into an approved design. Ask me questions one at a time; I am answering from a chat UI, so keep each question self-contained.
When the design is approved: save the spec to specs/${item.id}.md, set this item's spec field in project.yaml to specs/${item.id}.md, and commit both.${item.notes ? `\nExisting notes: ${item.notes}` : ''}`;
}

function createWorkflow({ projectDir, loadItems, runSession, broadcast }) {
  const stateFile = path.join(projectDir, '.superpowers', 'workflow.json');
  const transcript = [];
  let state = null;
  let session = null;

  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    // Its session died with the previous server process.
    if (state && state.stepStatus === 'running') state.stepStatus = 'interrupted';
  } catch { state = null; }

  function persist() {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }

  function setStatus(stepStatus, extra = {}) {
    state = { ...state, stepStatus, ...extra };
    persist();
    broadcast({ kind: 'workflow', state });
  }

  function record(ev) {
    transcript.push(ev);
    broadcast(ev);
  }

  function onEvent(ev) {
    if (ev.kind === 'session-start') { state = { ...state, sessionId: ev.sessionId }; persist(); }
    record(ev);
    // Artifact-based completion: the brainstorm step is done when the skill
    // has saved the spec file, regardless of what the transcript says.
    if (ev.kind === 'turn-end' && fs.existsSync(path.join(projectDir, 'specs', `${state.itemId}.md`))) {
      setStatus('done');
      session.close();
    }
  }

  function start(itemId) {
    if (state && state.stepStatus === 'running') return { error: 'A workflow is already running', code: 409 };
    const item = loadItems().find((i) => i && i.id === itemId);
    if (!item) return { error: `Unknown item "${itemId}"`, code: 400 };
    if (item.status === 'shipped') return { error: `"${itemId}" is already shipped`, code: 400 };

    transcript.length = 0;
    state = { itemId, step: 'brainstorm', stepStatus: 'running', sessionId: null, startedAt: new Date().toISOString() };
    persist();
    broadcast({ kind: 'workflow', state });

    session = runSession({ initialPrompt: brainstormPrompt(item), cwd: projectDir, onEvent });
    session.done.then(({ ok, error }) => {
      if (state.stepStatus === 'running') {
        setStatus('needs-attention', { error: error || (ok ? 'Session ended before the spec was saved' : 'Session failed') });
      }
    });
    return { state };
  }

  function input(text) {
    if (!session || !state || state.stepStatus !== 'running') return false;
    record({ kind: 'user-text', text });
    session.send(text);
    return true;
  }

  return { start, input, getState: () => state, getTranscript: () => transcript };
}

module.exports = { createWorkflow, brainstormPrompt };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/workflow.test.js`
Expected: PASS (11 tests). Also run `node --test test/` — all suites PASS.

- [ ] **Step 5: Commit**

```bash
git add workflow.js test/workflow.test.js
git commit -m "feat: workflow state object with brainstorm step"
```

---

### Task 4: server.js — workflow routes and SSE relay

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: `createWorkflow` (Task 3), `startSession` (Task 2), existing `loadProject`, `sendJson`, `sseClients`.
- Produces HTTP API: `GET /api/workflow` → `{ state, transcript }`; `POST /api/workflow/start` body `{ itemId }` → 200 state | 400/409 `{ error }`; `POST /api/workflow/input` body `{ text }` → 200 `{ ok: true }` | 400/409 `{ error }`. SSE: `event: workflow` with a UI event as JSON data, on the existing `/api/events` stream.

- [ ] **Step 1: Wire the workflow into main()**

In `server.js`, add to the top-level requires (after `const yaml = require('js-yaml');`):

```js
const { createWorkflow } = require('./workflow');
const { startSession } = require('./sessions');
```

Add a body reader next to `sendJson` (before `const MIME = {`):

```js
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
```

Inside `main()`, right after `const sseClients = new Set();`:

```js
  const workflow = createWorkflow({
    projectDir,
    loadItems: () => loadProject(args.yamlPath).items,
    runSession: startSession,
    broadcast: (ev) => {
      const frame = `event: workflow\ndata: ${JSON.stringify(ev)}\n\n`;
      for (const client of sseClients) client.write(frame);
    },
  });
```

- [ ] **Step 2: Add the three routes**

Inside the request handler, after the `/api/priority` block and before `/api/spec`:

```js
    if (url.pathname === '/api/workflow' && req.method === 'GET') {
      return sendJson(res, 200, { state: workflow.getState(), transcript: workflow.getTranscript() });
    }

    if (url.pathname === '/api/workflow/start' && req.method === 'POST') {
      return readBody(req).then((body) => {
        let itemId = null;
        try { itemId = JSON.parse(body).itemId; } catch { /* handled below */ }
        if (!itemId) return sendJson(res, 400, { error: 'itemId required' });
        const r = workflow.start(itemId);
        return r.error ? sendJson(res, r.code, { error: r.error }) : sendJson(res, 200, r.state);
      });
    }

    if (url.pathname === '/api/workflow/input' && req.method === 'POST') {
      return readBody(req).then((body) => {
        let text = null;
        try { text = JSON.parse(body).text; } catch { /* handled below */ }
        if (!text || !String(text).trim()) return sendJson(res, 400, { error: 'text required' });
        return workflow.input(String(text))
          ? sendJson(res, 200, { ok: true })
          : sendJson(res, 409, { error: 'No running workflow session' });
      });
    }
```

- [ ] **Step 3: Verify with a smoke test**

Run: `node --test test/` — all suites still PASS.
Then start the server without opening a browser: `node server.js example/project.yaml --no-open --port 4499` (leave running), and in another shell:

```bash
curl -s http://localhost:4499/api/workflow
# Expected: {"state":null,"transcript":[]}
curl -s -X POST http://localhost:4499/api/workflow/input -H "Content-Type: application/json" -d "{\"text\":\"hi\"}"
# Expected: {"error":"No running workflow session"}
curl -s -X POST http://localhost:4499/api/workflow/start -H "Content-Type: application/json" -d "{}"
# Expected: {"error":"itemId required"}
```

Stop the server. Do NOT POST a valid itemId here — that would launch a real Claude session; that is Task 6.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: /api/workflow routes and SSE workflow relay"
```

---

### Task 5: Workflow tab in the viewer

**Files:**
- Create: `web/src/WorkflowView.jsx`
- Modify: `web/src/App.jsx`
- Modify: `web/src/PriorityView.jsx`
- Modify: `web/src/DetailPanel.jsx`
- Modify: `web/src/App.css`

**Interfaces:**
- Consumes: HTTP API from Task 4 and the UI event vocabulary table.
- Produces: `WorkflowView({ items })` React component; `onStartWorkflow(itemId)` prop threaded from App into PriorityView and DetailPanel.

- [ ] **Step 1: Create WorkflowView.jsx**

```jsx
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';

const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export default function WorkflowView({ items }) {
  const [wf, setWf] = useState(null); // { state, transcript }
  const [text, setText] = useState('');
  const [pickedId, setPickedId] = useState('');
  const endRef = useRef(null);

  useEffect(() => {
    let stale = false;
    fetch('/api/workflow')
      .then((r) => r.json())
      .then((d) => { if (!stale) setWf(d); })
      .catch(() => { if (!stale) setWf({ state: null, transcript: [] }); });
    const es = new EventSource('/api/events');
    es.addEventListener('workflow', (e) => {
      const ev = JSON.parse(e.data);
      setWf((cur) => {
        const base = cur || { state: null, transcript: [] };
        if (ev.kind === 'workflow') {
          const isNewRun = ev.state.stepStatus === 'running' && base.state?.startedAt !== ev.state.startedAt;
          return { state: ev.state, transcript: isNewRun ? [] : base.transcript };
        }
        return { ...base, transcript: [...base.transcript, ev] };
      });
    });
    return () => { stale = true; es.close(); };
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [wf?.transcript.length]);

  if (!wf) return <div className="loading">Loading…</div>;
  const { state, transcript } = wf;
  const running = state?.stepStatus === 'running';
  const item = state && items.find((i) => i.id === state.itemId);
  const startable = items.filter((i) => i.status !== 'shipped');

  const send = () => {
    const t = text.trim();
    if (!t || !running) return;
    post('/api/workflow/input', { text: t });
    setText('');
  };

  return (
    <div className="workflow">
      {!state && (
        <div className="wf-empty">
          <p>No workflow yet. Pick an item to brainstorm:</p>
          <select value={pickedId} onChange={(e) => setPickedId(e.target.value)}>
            <option value="">— choose an item —</option>
            {startable.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <button disabled={!pickedId} onClick={() => post('/api/workflow/start', { itemId: pickedId })}>
            Start workflow
          </button>
        </div>
      )}

      {state && (
        <>
          <div className="wf-header">
            <strong>{item ? item.name : state.itemId}</strong>
            <span className="badge">{state.step}</span>
            <span className={`badge wf-${state.stepStatus}`}>{state.stepStatus}</span>
            {state.error && <span className="wf-error">{state.error}</span>}
          </div>
          <div className="wf-transcript">
            {transcript.map((ev, i) => {
              if (ev.kind === 'assistant-text') return <div key={i} className="msg assistant"><Markdown>{ev.text}</Markdown></div>;
              if (ev.kind === 'user-text') return <div key={i} className="msg user">{ev.text}</div>;
              if (ev.kind === 'tool-use') return <div key={i} className="msg tool"><code>{ev.name}</code> {ev.summary}</div>;
              if (ev.kind === 'session-start') return <div key={i} className="msg meta">session started ({ev.model})</div>;
              return null;
            })}
            {state.stepStatus === 'done' && <div className="msg meta">brainstorm complete — spec saved to specs/{state.itemId}.md</div>}
            <div ref={endRef} />
          </div>
          <div className="wf-input">
            <textarea
              rows={2}
              value={text}
              placeholder={running ? 'Answer Claude…' : 'Session is not running'}
              disabled={!running}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            />
            <button disabled={!running || !text.trim()} onClick={send}>Send</button>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the tab and start callback in App.jsx**

Add the import (after the PriorityView import):

```jsx
import WorkflowView from './WorkflowView.jsx';
```

Add inside `App()` (after the `refetch` callback):

```jsx
  const startWorkflow = useCallback((itemId) => {
    fetch('/api/workflow/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId }),
    }).finally(() => setView('workflow'));
  }, []);
```

Add the toggle button after the Priority button:

```jsx
          <button className={view === 'workflow' ? 'active' : ''} onClick={() => setView('workflow')}>Workflow</button>
```

Update the main section — add the view and thread the callback:

```jsx
        {view === 'priority' && <PriorityView items={items} selectedId={selectedId} onSelect={setSelectedId} onStartWorkflow={startWorkflow} />}
        {view === 'workflow' && <WorkflowView items={items} />}
```

and in the DetailPanel line add `onStartWorkflow={startWorkflow}`:

```jsx
          <DetailPanel item={selected} items={items} onSelect={setSelectedId} onClose={() => setSelectedId(null)} onStartWorkflow={startWorkflow} />
```

- [ ] **Step 3: Start buttons in PriorityView and DetailPanel**

`PriorityView.jsx`: change the signature to `({ items, selectedId, onSelect, onStartWorkflow })` and add a sibling button inside each `<li>` after the card `</button>` (cards are buttons; nesting is invalid HTML):

```jsx
            {item.status !== 'shipped' && (
              <button className="wf-start" title="Start workflow" onClick={() => onStartWorkflow(item.id)}>▶</button>
            )}
```

`DetailPanel.jsx`: change the signature to `({ item, items, onSelect, onClose, onStartWorkflow })` and add after the `detail-meta` div:

```jsx
      {item.status !== 'shipped' && (
        <button className="wf-start" onClick={() => onStartWorkflow(item.id)}>▶ Start workflow</button>
      )}
```

- [ ] **Step 4: Styles**

Append to `web/src/App.css`:

```css
/* Workflow tab */
.workflow { display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 1rem; gap: 0.5rem; }
.wf-empty { display: flex; gap: 0.5rem; align-items: center; }
.wf-header { display: flex; gap: 0.5rem; align-items: center; }
.wf-header .wf-running { background: #2b6cb0; color: #fff; }
.wf-header .wf-done { background: #276749; color: #fff; }
.wf-header .wf-needs-attention, .wf-header .wf-interrupted { background: #c05621; color: #fff; }
.wf-error { color: #c53030; font-size: 0.85rem; }
.wf-transcript { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 0.4rem; }
.msg { max-width: 46rem; padding: 0.4rem 0.7rem; border-radius: 8px; }
.msg.assistant { background: rgba(120, 120, 120, 0.12); }
.msg.user { background: #2b6cb0; color: #fff; align-self: flex-end; white-space: pre-wrap; }
.msg.tool { font-size: 0.8rem; opacity: 0.75; padding: 0.1rem 0.7rem; }
.msg.meta { font-size: 0.8rem; opacity: 0.6; font-style: italic; }
.wf-input { display: flex; gap: 0.5rem; }
.wf-input textarea { flex: 1; resize: vertical; }
.wf-start { font-size: 0.8rem; }
```

(If existing `.badge`/color variables differ, match the surrounding conventions rather than these literals.)

- [ ] **Step 5: Lint and build**

Run: `npm --prefix web run lint`
Expected: no errors.
Run: `npm run build`
Expected: Vite build succeeds.

- [ ] **Step 6: Commit**

```bash
git add web/src/WorkflowView.jsx web/src/App.jsx web/src/PriorityView.jsx web/src/DetailPanel.jsx web/src/App.css
git commit -m "feat: Workflow tab with transcript, chat, and start buttons"
```

---

### Task 6: End-to-end verification (human in the loop)

**Files:** none (verification only)

This launches a real Claude Code session and spends tokens — requires the human partner at the browser.

- [ ] **Step 1: Full test suite**

Run: `node --test test/`
Expected: all suites PASS.

- [ ] **Step 2: Launch against this repo's own project.yaml**

Run: `npm run build` then `node server.js project.yaml --port 4400`
Expected: browser opens; Diagram/Board/Priority tabs work as before; a Workflow tab appears.

- [ ] **Step 3: Drive a brainstorm from the browser**

1. Add a small scratch item to `project.yaml` (e.g. `id: scratch-test, name: Scratch test item, type: backend, status: planned`).
2. Open the Workflow tab, pick the scratch item, click Start workflow.
3. Expected within ~30s: `session started` meta line, then assistant text (brainstorming questions) streams in.
4. Answer a question in the chat box — expected: your message appears right-aligned; Claude responds.
5. Drive the brainstorm to approval; expected: when the session saves `specs/scratch-test.md`, the status badge flips to `done` and the completion meta line appears.
6. Reload the page mid-conversation — expected: transcript re-hydrates from `GET /api/workflow`.
7. Check `.superpowers/workflow.json` exists and matches the UI state.
8. Revert the scratch item and delete `specs/scratch-test.md` afterward.

- [ ] **Step 4: Update project.yaml and commit**

Set `workflow-session-runner` to `in-progress` when work starts (per AGENTS.md rule 2) and `shipped` once step 3 passes; commit:

```bash
git add project.yaml
git commit -m "chore: mark workflow-session-runner shipped"
```
