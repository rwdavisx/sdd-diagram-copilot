# Graphify Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Workflow LLM sessions get instant codebase orientation (GRAPH_REPORT.md pointer in the prompt) and live graph query tools (Graphify MCP server per session), with the graph auto-installed, auto-refreshed in the background, and viewable in a new Graph tab.

**Architecture:** All Graphify logic lives in one new CommonJS module, `graphify.js`, built as a factory (`createGraphify(deps)`) with injectable `execFile`/`execFileSync`/`spawn` — the same DI-for-tests pattern `createWorkflow` already uses. `server.js` creates one instance at startup and passes it to `createWorkflow`; `workflow.js` calls it at every step start (refresh + prompt paragraph + MCP config); `sessions.js` just forwards an `mcpServers` option to the Agent SDK. Graphify is an enhancer, never a gate: every function degrades to a no-op/empty value when the CLI is missing or the graph doesn't exist yet, and `ensureGraphFresh` never blocks — regeneration is a background spawn.

**Tech Stack:** Node.js (CommonJS, no new npm dependencies), `node:child_process`, `node --test` for tests, React (existing `web/` Vite app) for the Graph tab.

## Global Constraints

- **No new npm dependencies** (server deps are exactly `@anthropic-ai/claude-agent-sdk` + `js-yaml`).
- **CommonJS** for all server-side files (`graphify.js` matches `workflow.js`/`sessions.js` style).
- **Never block session start**: `ensureGraphFresh` returns immediately; regen is a detached-from-flow background spawn.
- **Graceful degradation everywhere**: CLI missing / install failed / graph absent → sessions run exactly as today; UI shows status `unavailable`.
- Upstream facts (from https://github.com/Graphify-Labs/graphify): CLI command is `graphify`, PyPI package is `graphifyy` (double-y), `graphify .` writes `graphify-out/graph.html`, `graphify-out/graph.json`, `graphify-out/GRAPH_REPORT.md` relative to cwd; MCP server is `python -m graphify.serve <graph.json> --transport stdio`; there is no `graphify mcp` subcommand.
- One shared graph per project, generated in the **main checkout** (`projectDir`); worktree sessions point at it via absolute paths.
- `graphify-out/` must be gitignored in the target project (the project being served, not this repo).
- API contracts (already in project.yaml): `GET /api/graphify/status` → `{ state: fresh | stale-regenerating | missing | unavailable, generatedAt }`; `GET /api/graphify/graph.html` → the graph or 404.
- Run tests with `node --test` (or `node --test test/graphify.test.js` for one file) from the repo root.
- Platform is Windows-friendly: never shell out to `which`; detect commands by running them (`execFile('graphify', ['--version'])` → ENOENT means absent). Pass `windowsHide: true` to spawns.

---

### Task 1: `graphify.js` — factory + auto-install fallback chain

**Files:**
- Create: `graphify.js`
- Test: `test/graphify.test.js`

**Interfaces:**
- Produces: `createGraphify({ log?, execFileFn?, execFileSyncFn?, spawnFn? })` → object with (this task) `ensureInstalled(): Promise<boolean>`, `available` (getter, boolean), `installHint` (getter, string|null). Later tasks add more methods to the same returned object.

- [ ] **Step 1: Write the failing tests**

Create `test/graphify.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createGraphify } = require('../graphify');

// Fake execFile: commands in `ok` succeed, everything else fails (ENOENT-ish).
function fakeExec(ok) {
  const calls = [];
  const execFileFn = (cmd, args, opts, cb) => {
    calls.push([cmd, ...args]);
    setImmediate(() => cb(ok.includes(cmd) ? null : new Error(`spawn ${cmd} ENOENT`)));
  };
  return { calls, execFileFn };
}

test('ensureInstalled: graphify already on PATH -> available, no installer runs', async () => {
  const { calls, execFileFn } = fakeExec(['graphify', 'uv']);
  const g = createGraphify({ execFileFn, log: () => {} });
  assert.strictEqual(await g.ensureInstalled(), true);
  assert.strictEqual(g.available, true);
  assert.ok(!calls.some((c) => c.includes('install')));
});

test('ensureInstalled: missing -> uv tool install graphifyy', async () => {
  const { calls, execFileFn } = fakeExec(['uv']);
  const g = createGraphify({ execFileFn, log: () => {} });
  assert.strictEqual(await g.ensureInstalled(), true);
  assert.deepStrictEqual(calls.find((c) => c[0] === 'uv' && c[1] === 'tool' && c[2] === 'install'),
    ['uv', 'tool', 'install', 'graphifyy']);
});

test('ensureInstalled: no uv -> pipx install graphifyy', async () => {
  const { calls, execFileFn } = fakeExec(['pipx']);
  const g = createGraphify({ execFileFn, log: () => {} });
  assert.strictEqual(await g.ensureInstalled(), true);
  assert.deepStrictEqual(calls.find((c) => c[0] === 'pipx'), ['pipx', 'install', 'graphifyy']);
});

test('ensureInstalled: nothing works -> unavailable with a hint, no throw', async () => {
  const { execFileFn } = fakeExec([]);
  const logged = [];
  const g = createGraphify({ execFileFn, log: (m) => logged.push(m) });
  assert.strictEqual(await g.ensureInstalled(), false);
  assert.strictEqual(g.available, false);
  assert.match(g.installHint, /uv|pipx/);
  assert.strictEqual(logged.length, 1);
});

test('ensureInstalled: kicks a background upgrade once when available', async () => {
  const { calls, execFileFn } = fakeExec(['graphify', 'uv']);
  const g = createGraphify({ execFileFn, log: () => {} });
  await g.ensureInstalled();
  await new Promise((r) => setImmediate(r)); // let the fire-and-forget upgrade land
  assert.ok(calls.some((c) => c[0] === 'uv' && c[1] === 'tool' && c[2] === 'upgrade' && c[3] === 'graphifyy'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/graphify.test.js`
Expected: FAIL — `Cannot find module '../graphify'`

- [ ] **Step 3: Write the implementation**

Create `graphify.js`:

```js
// graphify.js — Graphify codebase-knowledge-graph integration: auto-install,
// background refresh, session prompt pointer, per-session MCP config, status.
// An enhancer, never a gate: every function degrades to a no-op / empty value
// when the CLI or graph is unavailable.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');

const OUT_DIR = 'graphify-out';

function createGraphify({
  log = console.error,
  execFileFn = execFile,
  execFileSyncFn = execFileSync,
  spawnFn = spawn,
} = {}) {
  let available = false;
  let hasUv = false;
  let installHint = null;

  // Resolves true iff the command ran and exited 0. ENOENT -> false.
  const run = (cmd, args) => new Promise((resolve) => {
    execFileFn(cmd, args, { windowsHide: true }, (err) => resolve(!err));
  });

  // Check `graphify` on PATH; missing -> uv tool install, then pipx. On any
  // success, fire a background upgrade so the tool stays current. Failure is
  // logged once with a hint surfaced via installHint (shown by /api/graphify/status).
  async function ensureInstalled() {
    hasUv = await run('uv', ['--version']);
    if (await run('graphify', ['--version'])) available = true;
    else if (hasUv && await run('uv', ['tool', 'install', 'graphifyy'])) available = true;
    else if (await run('pipx', ['install', 'graphifyy'])) available = true;
    if (!available) {
      installHint = 'Graphify could not be installed (no uv or pipx found, or install failed). Install uv or pipx, then run: uv tool install graphifyy';
      log(installHint);
      return false;
    }
    // Fire-and-forget upgrade, once per server start; a failed upgrade is fine.
    run(hasUv ? 'uv' : 'pipx', hasUv ? ['tool', 'upgrade', 'graphifyy'] : ['upgrade', 'graphifyy']);
    return true;
  }

  return {
    ensureInstalled,
    get available() { return available; },
    get installHint() { return installHint; },
  };
}

module.exports = { createGraphify, OUT_DIR };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/graphify.test.js`
Expected: PASS (5 tests). Also run `node --test` — all existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add graphify.js test/graphify.test.js
git commit -m "feat: graphify-install — auto-install fallback chain (PATH -> uv -> pipx) with graceful degradation"
```

---

### Task 2: Refresh pipeline — staleness marker, background regen, status

**Files:**
- Modify: `graphify.js` (add methods inside `createGraphify`, before the `return`)
- Test: `test/graphify.test.js` (append)

**Interfaces:**
- Consumes: `createGraphify` internals from Task 1 (`available`, `spawnFn`, `execFileSyncFn`, `OUT_DIR`).
- Produces, on the object returned by `createGraphify`:
  - `paths(projectDir)` → `{ dir, html, json, report, marker }` (absolute paths under `<projectDir>/graphify-out/`)
  - `ensureGraphFresh(projectDir, { force = false } = {})` → `{ state: 'fresh' | 'stale-regenerating' | 'missing' }` — never blocks, spawns background `graphify .` when stale/missing
  - `status(projectDir)` → `{ state: 'fresh' | 'stale-regenerating' | 'missing' | 'unavailable', generatedAt: string | null, hint?: string }`

- [ ] **Step 1: Write the failing tests**

Append to `test/graphify.test.js`:

```js
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const { EventEmitter } = require('node:events');

// A graphify instance whose CLI is "installed", with fake git + fake spawn.
// gitState = { head, porcelain } drives the staleness stamp.
function installed({ gitState = { head: 'aaa', porcelain: '' } } = {}) {
  const spawned = [];
  const { execFileFn } = fakeExec(['graphify', 'uv']);
  const g = createGraphify({
    execFileFn,
    log: () => {},
    execFileSyncFn: (cmd, args) => {
      if (args[0] === 'rev-parse') return gitState.head + '\n';
      if (args[0] === 'status') return gitState.porcelain;
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    },
    spawnFn: (cmd, args, opts) => {
      const child = new EventEmitter();
      spawned.push({ cmd, args, opts, child });
      return child;
    },
  });
  return { g, spawned, ready: g.ensureInstalled() };
}

function tmpProject() {
  return fs.mkdtempSync(pathMod.join(os.tmpdir(), 'gfy-'));
}

test('ensureGraphFresh: no graph at all -> missing + background regen spawned', async () => {
  const { g, spawned, ready } = installed();
  await ready;
  const dir = tmpProject();
  assert.deepStrictEqual(g.ensureGraphFresh(dir), { state: 'missing' });
  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(spawned[0].cmd, 'graphify');
  assert.deepStrictEqual(spawned[0].args, ['.']);
  assert.strictEqual(spawned[0].opts.cwd, dir);
});

test('ensureGraphFresh: marker matches repo stamp -> fresh, nothing spawned', async () => {
  const { g, spawned, ready } = installed();
  await ready;
  const dir = tmpProject();
  // Generate once: regen spawn exits 0 -> marker written with the spawn-time stamp.
  g.ensureGraphFresh(dir);
  fs.mkdirSync(g.paths(dir).dir, { recursive: true });
  fs.writeFileSync(g.paths(dir).html, '<html>');
  spawned[0].child.emit('exit', 0);
  assert.deepStrictEqual(g.ensureGraphFresh(dir), { state: 'fresh' });
  assert.strictEqual(spawned.length, 1);
});

test('ensureGraphFresh: repo moved on -> stale-regenerating + regen', async () => {
  const gitState = { head: 'aaa', porcelain: '' };
  const { g, spawned, ready } = installed({ gitState });
  await ready;
  const dir = tmpProject();
  g.ensureGraphFresh(dir);
  fs.mkdirSync(g.paths(dir).dir, { recursive: true });
  fs.writeFileSync(g.paths(dir).html, '<html>');
  spawned[0].child.emit('exit', 0);
  gitState.head = 'bbb'; // new commit since generation
  assert.deepStrictEqual(g.ensureGraphFresh(dir), { state: 'stale-regenerating' });
  assert.strictEqual(spawned.length, 2);
});

test('ensureGraphFresh: only one regen in flight per project', async () => {
  const { g, spawned, ready } = installed();
  await ready;
  const dir = tmpProject();
  g.ensureGraphFresh(dir);
  g.ensureGraphFresh(dir);
  assert.strictEqual(spawned.length, 1);
});

test('ensureGraphFresh: failed regen (exit 1) writes no marker, next call retries', async () => {
  const { g, spawned, ready } = installed();
  await ready;
  const dir = tmpProject();
  g.ensureGraphFresh(dir);
  spawned[0].child.emit('exit', 1);
  assert.strictEqual(fs.existsSync(g.paths(dir).marker), false);
  g.ensureGraphFresh(dir);
  assert.strictEqual(spawned.length, 2);
});

test('ensureGraphFresh: CLI unavailable -> no spawn, missing/fresh from what exists', async () => {
  const { execFileFn } = fakeExec([]);
  const g = createGraphify({ execFileFn, log: () => {}, spawnFn: () => { throw new Error('must not spawn'); } });
  await g.ensureInstalled();
  const dir = tmpProject();
  assert.deepStrictEqual(g.ensureGraphFresh(dir), { state: 'missing' });
  fs.mkdirSync(g.paths(dir).dir, { recursive: true });
  fs.writeFileSync(g.paths(dir).html, '<html>'); // stale-but-usable old graph
  assert.deepStrictEqual(g.ensureGraphFresh(dir), { state: 'fresh' });
});

test('regen adds graphify-out/ to the target project .gitignore once', async () => {
  const { g, ready } = installed();
  await ready;
  const dir = tmpProject();
  g.ensureGraphFresh(dir);
  g.ensureGraphFresh(dir, { force: true });
  const gi = fs.readFileSync(pathMod.join(dir, '.gitignore'), 'utf8');
  assert.strictEqual(gi.split('\n').filter((l) => l.trim() === 'graphify-out/').length, 1);
});

test('status: unavailable / missing / fresh / stale-regenerating + generatedAt', async () => {
  const off = createGraphify({ execFileFn: fakeExec([]).execFileFn, log: () => {} });
  await off.ensureInstalled();
  assert.strictEqual(off.status(tmpProject()).state, 'unavailable');
  assert.match(off.status(tmpProject()).hint, /graphifyy/);

  const gitState = { head: 'aaa', porcelain: '' };
  const { g, spawned, ready } = installed({ gitState });
  await ready;
  const dir = tmpProject();
  assert.deepStrictEqual(g.status(dir), { state: 'missing', generatedAt: null });
  g.ensureGraphFresh(dir);
  fs.mkdirSync(g.paths(dir).dir, { recursive: true });
  fs.writeFileSync(g.paths(dir).html, '<html>');
  spawned[0].child.emit('exit', 0);
  const st = g.status(dir);
  assert.strictEqual(st.state, 'fresh');
  assert.ok(!Number.isNaN(Date.parse(st.generatedAt)));
  gitState.head = 'ccc';
  assert.strictEqual(g.status(dir).state, 'stale-regenerating');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/graphify.test.js`
Expected: FAIL — `g.ensureGraphFresh is not a function` (Task 1 tests still pass).

- [ ] **Step 3: Write the implementation**

Inside `createGraphify` in `graphify.js`, after `ensureInstalled`, add (and extend the returned object):

```js
  const regenerating = new Set(); // projectDirs with a `graphify .` in flight

  function paths(projectDir) {
    const dir = path.join(projectDir, OUT_DIR);
    return {
      dir,
      html: path.join(dir, 'graph.html'),
      json: path.join(dir, 'graph.json'),
      report: path.join(dir, 'GRAPH_REPORT.md'),
      marker: path.join(dir, 'marker.json'),
    };
  }

  // Repo identity at a moment in time: HEAD + a hash of the dirty state.
  // null (not a git repo / git missing) means "can't tell" -> always regen.
  function stamp(projectDir) {
    try {
      const head = execFileSyncFn('git', ['rev-parse', 'HEAD'], { cwd: projectDir, encoding: 'utf8' }).trim();
      const dirty = execFileSyncFn('git', ['status', '--porcelain'], { cwd: projectDir, encoding: 'utf8' });
      return `${head}:${crypto.createHash('sha1').update(dirty).digest('hex')}`;
    } catch { return null; }
  }

  function readMarker(projectDir) {
    try { return JSON.parse(fs.readFileSync(paths(projectDir).marker, 'utf8')); } catch { return null; }
  }

  // The graph outputs are build artifacts of the *target* project — keep them
  // out of its git history (same pattern as initProject's .superpowers/ entry).
  function ensureGitignored(projectDir) {
    const giPath = path.join(projectDir, '.gitignore');
    const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
    if (!gi.split('\n').some((l) => l.trim() === `${OUT_DIR}/`)) {
      fs.writeFileSync(giPath, `${gi.replace(/\n?$/, '\n')}${OUT_DIR}/\n`);
    }
  }

  function regenerate(projectDir, stampAtSpawn) {
    if (regenerating.has(projectDir)) return;
    regenerating.add(projectDir);
    ensureGitignored(projectDir);
    let child;
    try {
      child = spawnFn('graphify', ['.'], { cwd: projectDir, stdio: 'ignore', windowsHide: true });
    } catch { regenerating.delete(projectDir); return; }
    child.on('error', () => regenerating.delete(projectDir));
    child.on('exit', (code) => {
      regenerating.delete(projectDir);
      if (code === 0) {
        // Marker records what the repo looked like when regen *started* —
        // edits made during a long regen correctly read as stale next check.
        fs.mkdirSync(paths(projectDir).dir, { recursive: true });
        fs.writeFileSync(paths(projectDir).marker,
          JSON.stringify({ stamp: stampAtSpawn, generatedAt: new Date().toISOString() }));
      }
    });
  }

  // Non-blocking freshness guarantee: compare marker vs current stamp; kick a
  // background regen when stale/missing and return immediately. The first
  // session after big changes sees a slightly-old graph; it converges.
  function ensureGraphFresh(projectDir, { force = false } = {}) {
    const hasGraph = fs.existsSync(paths(projectDir).html);
    if (!available) return { state: hasGraph ? 'fresh' : 'missing' }; // best we can offer
    const now = stamp(projectDir);
    const marker = readMarker(projectDir);
    if (!force && hasGraph && marker && now && marker.stamp === now) return { state: 'fresh' };
    regenerate(projectDir, now);
    return { state: hasGraph ? 'stale-regenerating' : 'missing' };
  }

  function status(projectDir) {
    if (!available) return { state: 'unavailable', generatedAt: null, hint: installHint };
    const marker = readMarker(projectDir);
    const generatedAt = marker ? marker.generatedAt : null;
    if (!fs.existsSync(paths(projectDir).html)) return { state: 'missing', generatedAt };
    const now = stamp(projectDir);
    const fresh = marker && now && marker.stamp === now && !regenerating.has(projectDir);
    return { state: fresh ? 'fresh' : 'stale-regenerating', generatedAt };
  }
```

Extend the return statement:

```js
  return {
    ensureInstalled,
    paths,
    ensureGraphFresh,
    status,
    get available() { return available; },
    get installHint() { return installHint; },
  };
```

Note: `paths()` never creates directories — the real `graphify .` creates `graphify-out/` itself, and `regenerate`'s exit handler `mkdirSync`s it defensively before writing the marker. That's why the tests above `mkdirSync(g.paths(dir).dir, ...)` before pre-writing `graph.html`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/graphify.test.js`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add graphify.js test/graphify.test.js
git commit -m "feat: graphify-refresh — marker-based staleness (HEAD + dirty hash), non-blocking background regen, status"
```

---

### Task 3: Session context — graph pointer in every workflow prompt + server-start wiring

**Files:**
- Modify: `graphify.js` (add `sessionContext`)
- Modify: `workflow.js` (createWorkflow signature ~line 176; startStep ~line 265)
- Modify: `server.js` (main() ~line 395: create instance, wire into createWorkflow, kick install+refresh)
- Test: `test/graphify.test.js`, `test/workflow.test.js` (append)

**Interfaces:**
- Consumes: `paths`, `available` from Task 2.
- Produces:
  - `graphify.js`: `sessionContext(projectDir)` → string — one paragraph pointing at the main-checkout `GRAPH_REPORT.md` / `graph.json` absolute paths, or `''` when the graph is unavailable.
  - `workflow.js`: `createWorkflow({ ..., graphify })` — new optional dep; default is an inert stub `{ ensureGraphFresh: () => {}, sessionContext: () => '', mcpServers: () => null }` so all existing callers/tests are untouched. `startStep` calls `graphify.ensureGraphFresh(projectDir)` (try/catch) and appends `graphify.sessionContext(projectDir)` to `initialPrompt`.
  - `server.js`: a `createGraphify()` instance named `graphify`, in scope for the request handler (Tasks 5 uses it).

- [ ] **Step 1: Write the failing tests**

Append to `test/graphify.test.js`:

```js
test('sessionContext: names the report and json absolute paths', async () => {
  const { g, ready } = installed();
  await ready;
  const dir = tmpProject();
  fs.mkdirSync(g.paths(dir).dir, { recursive: true });
  fs.writeFileSync(g.paths(dir).report, '# report');
  fs.writeFileSync(g.paths(dir).json, '{}');
  const ctx = g.sessionContext(dir);
  assert.ok(ctx.includes(g.paths(dir).report));
  assert.ok(ctx.includes(g.paths(dir).json));
  assert.match(ctx, /before exploratory grepping/i);
});

test('sessionContext: empty string when the graph does not exist', async () => {
  const { g, ready } = installed();
  await ready;
  assert.strictEqual(g.sessionContext(tmpProject()), '');
});
```

Append to `test/workflow.test.js` (uses the existing `makeWorkflow`/`lastSession` helpers; first widen the helper):

```js
// In makeWorkflow, allow overrides: change the existing declaration to
//   function makeWorkflow(extra = {}) {
//     return createWorkflow({ ...existing args..., ...extra });
//   }

test('startStep appends graph context to the prompt and refreshes the graph', () => {
  const refreshed = [];
  const wf = makeWorkflow({
    graphify: {
      ensureGraphFresh: (d) => refreshed.push(d),
      sessionContext: () => '\n\nGRAPH POINTER',
      mcpServers: () => null,
    },
  });
  wf.start('feat-a');
  assert.ok(lastSession().args.initialPrompt.endsWith('GRAPH POINTER'));
  assert.deepStrictEqual(refreshed, [dir]);
});

test('no graphify dep -> prompt is exactly the step prompt (unchanged behavior)', () => {
  const wf = makeWorkflow();
  wf.start('feat-a');
  assert.ok(lastSession().args.initialPrompt.startsWith('You are working on the item "feat-a"'));
  assert.ok(!lastSession().args.initialPrompt.includes('GRAPH'));
});

test('a throwing graphify never blocks the session (enhancer, not a gate)', () => {
  const wf = makeWorkflow({
    graphify: {
      ensureGraphFresh: () => { throw new Error('boom'); },
      sessionContext: () => '',
      mcpServers: () => null,
    },
  });
  const r = wf.start('feat-a');
  assert.ok(!r.error);
  assert.strictEqual(sessions.length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/graphify.test.js test/workflow.test.js`
Expected: FAIL — `g.sessionContext is not a function`; workflow prompt tests fail on missing appending.

- [ ] **Step 3: Implement**

`graphify.js` — inside `createGraphify`, add and export on the returned object:

```js
  // One paragraph appended to each workflow session's initial prompt. Absolute
  // main-checkout paths so sessions running inside a worktree still find the
  // shared graph. Empty string when there is nothing to point at.
  function sessionContext(projectDir) {
    const p = paths(projectDir);
    if (!fs.existsSync(p.report) || !fs.existsSync(p.json)) return '';
    return `\n\nA Graphify knowledge graph of this codebase is available. For instant orientation read ${p.report} (key concepts, connections, suggested questions); the full graph is at ${p.json}. Consult the graph before exploratory grepping.`;
  }
```

`workflow.js` — in the `createWorkflow` parameter list add:

```js
  graphify = { ensureGraphFresh: () => {}, sessionContext: () => '', mcpServers: () => null },
```

In `startStep`, before `session = runSession({...})`:

```js
    // Graphify is an enhancer, never a gate — any failure means "no graph".
    try { graphify.ensureGraphFresh(projectDir); } catch { /* degrade */ }
    let graphCtx = '';
    try { graphCtx = graphify.sessionContext(projectDir) || ''; } catch { /* degrade */ }
```

and change the `initialPrompt` line to:

```js
      initialPrompt: def.prompt(item) + graphCtx,
```

`server.js` — add to the requires at the top:

```js
const { createGraphify } = require('./graphify');
```

In `main()`, right before `const workflow = createWorkflow({`:

```js
  const graphify = createGraphify();
  // Install check + first freshness pass, fully in the background; a failure
  // degrades every graphify feature and surfaces via /api/graphify/status.
  graphify.ensureInstalled().then((ok) => { if (ok) graphify.ensureGraphFresh(projectDir); });
```

and pass `graphify,` into the `createWorkflow({ ... })` options.

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS — all files, including untouched existing workflow tests (the inert default keeps old behavior byte-identical).

- [ ] **Step 5: Commit**

```bash
git add graphify.js workflow.js server.js test/graphify.test.js test/workflow.test.js
git commit -m "feat: graphify-session-context — graph pointer appended to every workflow session prompt; install+refresh on server start"
```

---

### Task 4: MCP attach — Graphify stdio server on every session

**Files:**
- Modify: `graphify.js` (add `mcpServers`)
- Modify: `sessions.js` (startSession ~line 90: accept + forward `mcpServers`)
- Modify: `workflow.js` (startStep: pass `mcpServers` to runSession)
- Test: `test/graphify.test.js`, `test/sessions.test.js`, `test/workflow.test.js` (append)

**Interfaces:**
- Consumes: `paths`, `available`, `hasUv` from Tasks 1–2; `graphify.mcpServers` stub slot already in workflow's default dep (Task 3).
- Produces:
  - `graphify.js`: `mcpServers(projectDir)` → `{ graphify: { type: 'stdio', command, args } } | null`. Null when CLI unavailable or `graph.json` absent. Launch command: upstream documents only `python -m graphify.serve <graph.json> --transport stdio`; when uv exists use `uv run --with graphifyy python -m graphify.serve ...` so the module resolves inside an isolated tool env, else plain `python`.
  - `sessions.js`: `startSession({ ..., mcpServers })` — spread into SDK `options` only when truthy.
  - `workflow.js`: `runSession` receives `mcpServers: <value or null>`.

- [ ] **Step 1: Write the failing tests**

Append to `test/graphify.test.js`:

```js
test('mcpServers: stdio config pointing at graph.json (uv launcher when uv exists)', async () => {
  const { g, ready } = installed(); // fakeExec ok-list includes 'uv'
  await ready;
  const dir = tmpProject();
  fs.mkdirSync(g.paths(dir).dir, { recursive: true });
  fs.writeFileSync(g.paths(dir).json, '{}');
  const cfg = g.mcpServers(dir);
  assert.strictEqual(cfg.graphify.type, 'stdio');
  assert.strictEqual(cfg.graphify.command, 'uv');
  assert.deepStrictEqual(cfg.graphify.args,
    ['run', '--with', 'graphifyy', 'python', '-m', 'graphify.serve', g.paths(dir).json, '--transport', 'stdio']);
});

test('mcpServers: null when graph.json missing or CLI unavailable', async () => {
  const { g, ready } = installed();
  await ready;
  assert.strictEqual(g.mcpServers(tmpProject()), null);

  const off = createGraphify({ execFileFn: fakeExec([]).execFileFn, log: () => {} });
  await off.ensureInstalled();
  const dir = tmpProject();
  const offPaths = pathMod.join(dir, 'graphify-out');
  fs.mkdirSync(offPaths, { recursive: true });
  fs.writeFileSync(pathMod.join(offPaths, 'graph.json'), '{}');
  assert.strictEqual(off.mcpServers(dir), null);
});
```

Append to `test/sessions.test.js` (mirror the existing `startSession` queryFn-capture pattern used by the model/effort tests; if none exists, this is the pattern):

```js
test('startSession forwards mcpServers into SDK options; omits when absent', async () => {
  let captured;
  const queryFn = async (args) => { captured = args; return (async function* () {})(); };
  const mcp = { graphify: { type: 'stdio', command: 'python', args: [] } };
  const s1 = startSession({ initialPrompt: 'hi', cwd: '.', onEvent: () => {}, queryFn, mcpServers: mcp });
  await s1.done;
  assert.deepStrictEqual(captured.options.mcpServers, mcp);

  const s2 = startSession({ initialPrompt: 'hi', cwd: '.', onEvent: () => {}, queryFn });
  await s2.done;
  assert.ok(!('mcpServers' in captured.options));
});
```

(Requires `startSession` in the require line at the top of `test/sessions.test.js`.)

Append to `test/workflow.test.js`:

```js
test('startStep passes graphify mcpServers through to runSession', () => {
  const mcp = { graphify: { type: 'stdio', command: 'python', args: [] } };
  const wf = makeWorkflow({
    graphify: { ensureGraphFresh: () => {}, sessionContext: () => '', mcpServers: () => mcp },
  });
  wf.start('feat-a');
  assert.deepStrictEqual(lastSession().args.mcpServers, mcp);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test`
Expected: FAIL — `g.mcpServers is not a function`, missing `mcpServers` in captured options / session args.

- [ ] **Step 3: Implement**

`graphify.js` — inside `createGraphify`, add and export on the returned object:

```js
  // Stdio MCP server config for the Agent SDK, giving sessions live graph
  // query tools (query_graph, get_node, get_neighbors, shortest_path, ...).
  // ponytail: upstream only documents `python -m graphify.serve`; with uv we
  // launch through `uv run --with graphifyy` so the module resolves in an
  // isolated env. Revisit if graphify ships a first-class serve entry point.
  function mcpServers(projectDir) {
    const p = paths(projectDir);
    if (!available || !fs.existsSync(p.json)) return null;
    const serve = ['-m', 'graphify.serve', p.json, '--transport', 'stdio'];
    return {
      graphify: hasUv
        ? { type: 'stdio', command: 'uv', args: ['run', '--with', 'graphifyy', 'python', ...serve] }
        : { type: 'stdio', command: 'python', args: serve },
    };
  }
```

`sessions.js` — change the `startSession` signature to include `mcpServers`:

```js
function startSession({ initialPrompt, cwd, resume, model, effort, mcpServers, onEvent, queryFn = defaultQueryFn }) {
```

and inside `options`, after the `effort` spread:

```js
          ...(mcpServers ? { mcpServers } : {}),
```

`workflow.js` — in `startStep`, compute and pass through:

```js
    let mcp = null;
    try { mcp = graphify.mcpServers(projectDir); } catch { /* degrade */ }
```

and add `mcpServers: mcp,` to the `runSession({ ... })` call.

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add graphify.js sessions.js workflow.js test/graphify.test.js test/sessions.test.js test/workflow.test.js
git commit -m "feat: graphify-mcp-attach — Graphify stdio MCP server on every workflow session, omitted when unavailable"
```

---

### Task 5: HTTP API — `/api/graphify/status`, `/api/graphify/graph.html`, `/api/graphify/regenerate`

**Files:**
- Modify: `server.js` (request handler, insert the three routes right after the `/api/priority` block ~line 453)

**Interfaces:**
- Consumes: the `graphify` instance created in `main()` (Task 3), `originAllowed`, `sendJson`, `projectDir`.
- Produces (consumed by Task 6's GraphView):
  - `GET /api/graphify/status` → 200 `{ state: 'fresh'|'stale-regenerating'|'missing'|'unavailable', generatedAt: string|null, hint?: string }`
  - `GET /api/graphify/graph.html` → 200 text/html (the generated graph) or 404 `{ error }`
  - `POST /api/graphify/regenerate` → 200 `{ state }` (forced `ensureGraphFresh`), 403 cross-origin, 503 when graphify unavailable

- [ ] **Step 1: Add the routes**

In the request handler in `server.js`, after the `/api/priority` block:

```js
    if (url.pathname === '/api/graphify/status') {
      return sendJson(res, 200, graphify.status(projectDir));
    }

    if (url.pathname === '/api/graphify/graph.html') {
      return fs.readFile(graphify.paths(projectDir).html, (err, data) => {
        if (err) return sendJson(res, 404, { error: 'No graph generated yet' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data);
      });
    }

    if (url.pathname === '/api/graphify/regenerate' && req.method === 'POST') {
      if (!originAllowed(req, args.port)) return sendJson(res, 403, { error: 'Cross-origin request rejected' });
      if (!graphify.available) return sendJson(res, 503, { error: 'graphify is not installed' });
      return sendJson(res, 200, graphify.ensureGraphFresh(projectDir, { force: true }));
    }
```

No new unit tests: the route bodies are one-line delegations to the Task 2 functions, which are already covered; this codebase does not unit-test the inline `http` handler. Verified live in Task 6.

- [ ] **Step 2: Regression + smoke check**

Run: `node --test`
Expected: PASS.

Run (background): `node server.js --no-open --port 4499` then:

```bash
curl -s http://localhost:4499/api/graphify/status
```

Expected: JSON with a valid `state` (on this machine, `{"state":"unavailable",...}` since uv/pipx are absent — that IS the graceful-degradation path working). Then:

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:4499/api/graphify/graph.html
```

Expected: `404`. Stop the server.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: graphify API — status, graph.html, and manual regenerate endpoints"
```

---

### Task 6: Graph tab — iframe + status chip + Regenerate button

**Files:**
- Create: `web/src/GraphView.jsx`
- Modify: `web/src/App.jsx` (import; add `<Tab value="graph" .../>` in the TabList ~line 79; add the view render ~line 99)

**Interfaces:**
- Consumes: `GET /api/graphify/status`, `GET /api/graphify/graph.html`, `POST /api/graphify/regenerate` (Task 5). Wireframe: `design/wireframes/graphify-graph-tab.html`.
- Produces: `export default function GraphView()` — no props.

- [ ] **Step 1: Create `web/src/GraphView.jsx`**

Before writing, glance at `web/src/chips.jsx` and one existing view (e.g. `TestsView.jsx`) and reuse their chip/button/layout classes instead of the inline styles below wherever an equivalent exists — match the app, don't invent a parallel style system. Functional skeleton:

```jsx
// GraphView — embeds Graphify's interactive graph.html with a freshness chip
// and a manual Regenerate button. Polls status while a regen is in flight.
import { useEffect, useState } from 'react';

const CHIP_COLORS = {
  fresh: { background: '#e6f4ec', color: '#2fa864', border: '1px solid #bfe4cf' },
  'stale-regenerating': { background: '#fdf3e2', color: '#b07a1e', border: '1px solid #f0dcb2' },
  missing: { background: '#fdf3e2', color: '#b07a1e', border: '1px solid #f0dcb2' },
  unavailable: { background: '#fbe9e9', color: '#c0392b', border: '1px solid #efc4c4' },
};

const LABEL = {
  fresh: 'fresh',
  'stale-regenerating': 'regenerating…',
  missing: 'generating…',
  unavailable: 'unavailable',
};

export default function GraphView() {
  const [status, setStatus] = useState(null);

  const refresh = () =>
    fetch('/api/graphify/status').then((r) => r.json()).then(setStatus).catch(() => {});

  useEffect(() => { refresh(); }, []);

  // While a regen is (or should be) running, poll until the graph lands.
  useEffect(() => {
    if (!status || status.state === 'fresh' || status.state === 'unavailable') return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [status && status.state]);

  const regenerate = () =>
    fetch('/api/graphify/regenerate', { method: 'POST' }).then(refresh).catch(() => {});

  const state = status ? status.state : 'missing';
  const hasGraph = status && (state === 'fresh' || state === 'stale-regenerating');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px' }}>
        <h2 style={{ fontSize: 15, margin: 0, flex: 1 }}>Graph — codebase knowledge graph</h2>
        <span style={{ fontSize: 12, padding: '3px 10px', borderRadius: 999, ...CHIP_COLORS[state] }}>
          {LABEL[state]}{status?.generatedAt ? ` · ${new Date(status.generatedAt).toLocaleTimeString()}` : ''}
        </span>
        <button onClick={regenerate} disabled={state === 'unavailable'}>Regenerate</button>
      </div>
      {hasGraph ? (
        <iframe
          key={status.generatedAt || 'graph'} /* reload the iframe when a regen lands */
          src="/api/graphify/graph.html"
          title="Graphify graph"
          style={{ flex: 1, border: 0, width: '100%' }}
        />
      ) : (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: '#7c8595', fontSize: 14, textAlign: 'center' }}>
          {state === 'unavailable'
            ? (status?.hint || 'Graphify is not installed. Install uv or pipx, then: uv tool install graphifyy')
            : 'No graph yet — it is being generated in the background.'}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire the tab in `web/src/App.jsx`**

Add the import next to the other views:

```jsx
import GraphView from './GraphView.jsx';
```

Add to the TabList (after the Workflow tab):

```jsx
          <Tab value="graph" label="Graph" />
```

Add to the view renders (after the workflow line):

```jsx
        {view === 'graph' && <GraphView />}
```

- [ ] **Step 3: Build and regression-test**

Run: `npm run build`
Expected: Vite build succeeds.
Run: `node --test`
Expected: PASS (wireframes.test.js in particular still passes).

- [ ] **Step 4: Manual verification (/verify skill)**

Per the memory note, rebuild `web/dist` (done in Step 3) and restart the server on the root `project.yaml` (port 4400). Check:
- Graph tab appears and renders; on this machine (no uv/pipx) the chip shows **unavailable** with the install hint — the degradation path.
- If graphify is installable: chip transitions missing → generating → fresh; iframe shows the interactive graph; Regenerate flips the chip to regenerating and back.
- `/api/graphify/status` and a workflow session's opening prompt (visible in the Workflow transcript) show/omit the graph paragraph consistently with graph presence.

- [ ] **Step 5: Commit**

```bash
git add web/src/GraphView.jsx web/src/App.jsx
git commit -m "feat: graphify-graph-tab — Graph tab embedding graph.html with status chip and Regenerate"
```

---

## Out of scope (deliberate)

- **project.yaml `tests:` bookkeeping** — the execute-step prompt already instructs the session to record tests per AGENTS.md as they land; no plan task needed.
- **HTTP-transport MCP / shared team server** — stdio per session is what the spec asks for.
- **Watching the repo to regenerate on file change** — the spec's freshness model is check-at-session-start + manual Regenerate; add a watcher only if that proves too stale in practice.
- **A dedicated "one-time UI hint" toast** — the unavailable chip + hint text in the Graph tab is the hint; add a toast only if users miss it.
