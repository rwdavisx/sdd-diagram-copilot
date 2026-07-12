# Service Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start/stop/restart the processes declared in project.yaml `run:` blocks from the dashboard, with live status everywhere.

**Architecture:** A new `runner.js` module (modeled on `workflow.js`) spawns services as child processes of the copilot server, tracks state (`stopped | starting | running | crashed | external`), and broadcasts changes over the existing `/api/events` SSE stream as `event: service`. `server.js` validates `run:` blocks, exposes `/api/services*` endpoints, and kills all children on exit. The React viewer gains a `useServices` hook, a `ServiceDot` chip on diagram/board nodes, a Service section in the detail panel, and a Run tab.

**Tech Stack:** Node stdlib only (`child_process`, `net`), `node --test` for tests, React + @astryxdesign/core for UI. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-12-service-runner-design.md`

## Global Constraints

- No new npm dependencies.
- Services die with the copilot server — no detached survivors, no PID files.
- Windows is the primary platform: kill via `taskkill /pid <pid> /t /f`; POSIX spawns `detached: true` and kills the process group.
- Non-zero exit without a stop request → `crashed`. Zero exit → `stopped`.
- Ring buffer of last 200 output lines per service — not a streaming log viewer.
- Out of scope (do NOT build): docker, auto-restart, log streaming, health checks beyond TCP connect.
- Run tests with `npm test` (this is `node --test`) from the repo root.
- In test commands, always quote `process.execPath` (`"${process.execPath}"`) — the Windows node path contains spaces and services spawn with `shell: true`.

---

### Task 1: runner.js — core lifecycle (start / stop / restart)

**Files:**
- Create: `runner.js`
- Test: `test/runner.test.js`

**Interfaces:**
- Consumes: nothing new (Node stdlib).
- Produces: `createRunner({ projectDir, loadServices, broadcast, readyDelayMs = 2000, pollMs = 250 })`. In this task it returns `{ start(id), stop(id), restart(id), get(id), shutdownSync() }`, where `get(id)` is a minimal version resolving to `{ id, status, pid, startedAt, output }` or `null`; Task 2 replaces `get` and adds `list/startAll/stopAll`. Also exports `validateRun(run)` → error string or `null`.
- `loadServices()` returns items that have a `run` block: `[{ id, name, depends, run: { cmd, cwd?, port?, env? } }]`.
- `broadcast(ev)` is called with `{ id, status }` on every status change.
- Command results follow the workflow.js convention: `{ ok: true }` or `{ error, code }`.

- [ ] **Step 1: Write the failing tests**

Create `test/runner.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { createRunner, validateRun } = require('../runner');

// Poll until fn() is truthy or timeout. Runner state changes are async
// (child spawn, readiness timers), so every assertion on status polls.
const until = async (fn, ms = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

const node = (script) => `"${process.execPath}" -e "${script}"`;

function makeRunner(services, opts = {}) {
  const events = [];
  const runner = createRunner({
    projectDir: __dirname,
    loadServices: () => services,
    broadcast: (ev) => events.push(ev),
    readyDelayMs: 100,
    pollMs: 50,
    ...opts,
  });
  return { runner, events };
}

test('validateRun', () => {
  assert.equal(validateRun({ cmd: 'node x.js' }), null);
  assert.match(validateRun({}), /cmd/);
  assert.match(validateRun({ cmd: 'x', port: 'nope' }), /port/);
  assert.match(validateRun({ cmd: 'x', env: [] }), /env/);
});

test('start -> running (no port), stop -> stopped', async (t) => {
  const { runner } = makeRunner([
    { id: 'svc', name: 'Svc', run: { cmd: node('setInterval(()=>{},1000)') } },
  ]);
  t.after(() => runner.shutdownSync());
  assert.deepEqual(runner.start('svc'), { ok: true });
  assert.ok(await until(async () => (await runner.get('svc'))?.status === 'running'), 'should reach running');
  assert.deepEqual(runner.stop('svc'), { ok: true });
  assert.ok(await until(async () => (await runner.get('svc'))?.status === 'stopped'), 'should reach stopped');
});

test('non-zero exit without stop -> crashed, output captured', async (t) => {
  const { runner } = makeRunner([
    { id: 'boom', name: 'Boom', run: { cmd: node("console.log('kaput');process.exit(3)") } },
  ]);
  t.after(() => runner.shutdownSync());
  runner.start('boom');
  assert.ok(await until(async () => (await runner.get('boom'))?.status === 'crashed'), 'should crash');
  const d = await runner.get('boom');
  assert.ok(d.output.some((l) => l.includes('kaput')), `output should contain kaput: ${JSON.stringify(d.output)}`);
});

test('port readiness: starting until the port listens', async (t) => {
  const port = 41473;
  const { runner } = makeRunner([
    { id: 'api', name: 'Api', run: { cmd: node(`setTimeout(()=>require('net').createServer().listen(${port}),300);setInterval(()=>{},1000)`), port } },
  ]);
  t.after(() => runner.shutdownSync());
  runner.start('api');
  assert.equal((await runner.get('api')).status, 'starting');
  assert.ok(await until(async () => (await runner.get('api'))?.status === 'running'), 'should reach running once port listens');
});

test('start errors: unknown id 404, invalid config 400, double start 409', async (t) => {
  const { runner } = makeRunner([
    { id: 'ok', name: 'Ok', run: { cmd: node('setInterval(()=>{},1000)') } },
    { id: 'bad', name: 'Bad', run: {} },
  ]);
  t.after(() => runner.shutdownSync());
  assert.equal(runner.start('nope').code, 404);
  assert.equal(runner.start('bad').code, 400);
  assert.deepEqual(runner.start('ok'), { ok: true });
  assert.equal(runner.start('ok').code, 409);
});

test('restart: running -> stopped -> running again with a new pid', async (t) => {
  const { runner } = makeRunner([
    { id: 'svc', name: 'Svc', run: { cmd: node('setInterval(()=>{},1000)') } },
  ]);
  t.after(() => runner.shutdownSync());
  runner.start('svc');
  await until(async () => (await runner.get('svc'))?.status === 'running');
  const pid1 = (await runner.get('svc')).pid;
  const r = await runner.restart('svc');
  assert.deepEqual(r, { ok: true });
  assert.ok(await until(async () => {
    const d = await runner.get('svc');
    return d?.status === 'running' && d.pid !== pid1;
  }), 'should be running under a new pid');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/runner.test.js`
Expected: FAIL — `Cannot find module '../runner'`.

- [ ] **Step 3: Implement runner.js**

Create `runner.js`:

```js
// runner.js — service runner: spawns items' `run:` blocks as child processes
// of this server, tracks status, kills whole process trees on stop, and
// reports everything over the caller's broadcast. Children die with us —
// no detached processes, no PID files.
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const MAX_OUTPUT_LINES = 200;

function validateRun(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return 'run must be a mapping';
  if (!run.cmd || typeof run.cmd !== 'string') return 'run.cmd must be a non-empty string';
  if (run.port != null && !Number.isInteger(run.port)) return 'run.port must be an integer';
  if (run.env != null && (typeof run.env !== 'object' || Array.isArray(run.env))) return 'run.env must be a mapping';
  return null;
}

function portListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { s.destroy(); resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1000, () => done(false));
  });
}

// npm/vite wrap the real server in child processes — killing just the shell
// pid leaks the tree, so always kill the whole tree.
function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGTERM'); // works because we spawn detached (own group)
    }
  } catch { /* already dead */ }
}

function createRunner({ projectDir, loadServices, broadcast = () => {}, readyDelayMs = 2000, pollMs = 250 }) {
  // id -> { child, pid, status, startedAt, config, output, stopRequested, timer }
  const procs = new Map();

  const alive = (p) => p && (p.status === 'starting' || p.status === 'running');

  function push(p, text) {
    for (const line of String(text).split(/\r?\n/)) if (line) p.output.push(line);
    if (p.output.length > MAX_OUTPUT_LINES) p.output.splice(0, p.output.length - MAX_OUTPUT_LINES);
  }

  function setStatus(p, id, status) {
    p.status = status;
    broadcast({ id, status });
  }

  function start(id) {
    const svc = loadServices().find((s) => s.id === id);
    if (!svc) return { error: `Unknown service "${id}"`, code: 404 };
    const bad = validateRun(svc.run);
    if (bad) return { error: bad, code: 400 };
    if (alive(procs.get(id))) return { error: `"${id}" is already ${procs.get(id).status}`, code: 409 };

    const run = svc.run;
    const child = spawn(run.cmd, {
      shell: true,
      cwd: path.resolve(projectDir, run.cwd || '.'),
      env: { ...process.env, ...(run.env || {}) },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const p = {
      child, pid: child.pid, status: 'starting', startedAt: new Date().toISOString(),
      config: JSON.stringify(run), output: [], stopRequested: false, timer: null,
    };
    procs.set(id, p);
    broadcast({ id, status: 'starting' });

    child.stdout.on('data', (d) => push(p, d));
    child.stderr.on('data', (d) => push(p, d));
    child.on('error', (e) => {
      clearTimeout(p.timer);
      push(p, `spawn error: ${e.message}`);
      if (alive(p)) setStatus(p, id, 'crashed');
    });
    child.on('exit', (code) => {
      clearTimeout(p.timer);
      if (!alive(p)) return;
      setStatus(p, id, p.stopRequested || code === 0 ? 'stopped' : 'crashed');
    });

    // Readiness: declared port answers -> running; no port -> assume running
    // after a grace delay (crash-on-boot flips it to crashed via 'exit').
    if (run.port) {
      p.timer = setInterval(async () => {
        if (p.status !== 'starting') return clearTimeout(p.timer);
        if (await portListening(run.port) && p.status === 'starting') {
          clearTimeout(p.timer);
          setStatus(p, id, 'running');
        }
      }, pollMs);
    } else {
      p.timer = setTimeout(() => { if (p.status === 'starting') setStatus(p, id, 'running'); }, readyDelayMs);
    }
    return { ok: true };
  }

  function stop(id) {
    const p = procs.get(id);
    if (!alive(p)) return { error: `"${id}" is not running`, code: 409 };
    p.stopRequested = true;
    killTree(p.pid);
    return { ok: true };
  }

  function waitWhile(id, pred, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const st = procs.get(id) && procs.get(id).status;
        if (!pred(st) || Date.now() - t0 > timeoutMs) { clearInterval(iv); resolve(st); }
      }, 50);
    });
  }

  async function restart(id) {
    if (alive(procs.get(id))) {
      const r = stop(id);
      if (r.error) return r;
      await waitWhile(id, (s) => s === 'starting' || s === 'running');
    }
    return start(id);
  }

  async function get(id) {
    const p = procs.get(id);
    if (!p) return null;
    return { id, status: p.status, pid: p.pid, startedAt: p.startedAt, output: p.output };
  }

  function shutdownSync() {
    for (const p of procs.values()) {
      if (alive(p)) { p.stopRequested = true; killTree(p.pid); }
    }
  }

  return { start, stop, restart, get, shutdownSync };
}

module.exports = { createRunner, validateRun };
```

Note: `get`/`shutdownSync` grow in Task 2 — this shape is enough for Task 1's tests. `clearTimeout` clears both timeouts and intervals in Node, so one `timer` slot suffices.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/runner.test.js`
Expected: 6 tests PASS. Port test uses a fixed port (41473); if it flakes locally, something else owns the port — change the number, don't loosen the test.

- [ ] **Step 5: Commit**

```bash
git add runner.js test/runner.test.js
git commit -m "feat: runner.js — service start/stop/restart with tree kill and readiness"
```

---

### Task 2: runner.js — list/get with external + stale detection, start-all/stop-all

**Files:**
- Modify: `runner.js`
- Test: `test/runner.test.js` (append)

**Interfaces:**
- Consumes: Task 1's `createRunner` internals (`procs`, `alive`, `portListening`, `waitWhile`).
- Produces (final runner API used by server.js in Task 3):
  - `list()` → Promise of `[{ id, name, status, pid, port, startedAt, stale, invalid }]` — one entry per service, `status` including `'external'` when a declared port is occupied by a process we didn't start; `invalid` is the `validateRun` error string or `null`; `stale` is true when a live service's `run` block changed since spawn.
  - `get(id)` → Promise of the same entry `+ { output: string[] }`, or `null` for unknown ids (replaces Task 1's minimal `get`).
  - `startAll()` / `stopAll()` → Promise of `{ ok: true }`; start in dependency order waiting for each to leave `starting`, stop in reverse order waiting for exit. Invalid/external/already-running services are skipped, not errors.

- [ ] **Step 1: Write the failing tests**

Append to `test/runner.test.js`:

```js
test('list: stopped by default, external when the port is occupied by someone else', async (t) => {
  const netMod = require('net');
  const port = 41573;
  const ext = netMod.createServer().listen(port, '127.0.0.1');
  t.after(() => ext.close());
  await new Promise((r) => ext.once('listening', r));
  const { runner } = makeRunner([
    { id: 'a', name: 'A', run: { cmd: node('setInterval(()=>{},1000)') } },
    { id: 'b', name: 'B', run: { cmd: node('setInterval(()=>{},1000)'), port } },
  ]);
  t.after(() => runner.shutdownSync());
  const entries = Object.fromEntries((await runner.list()).map((e) => [e.id, e]));
  assert.equal(entries.a.status, 'stopped');
  assert.equal(entries.b.status, 'external');
  assert.equal(runner.stop('b').code, 409, 'cannot stop an external process');
});

test('list: stale flag when a live service config changes', async (t) => {
  const services = [{ id: 'svc', name: 'Svc', run: { cmd: node('setInterval(()=>{},1000)') } }];
  const { runner } = makeRunner(services);
  t.after(() => runner.shutdownSync());
  runner.start('svc');
  await until(async () => (await runner.get('svc'))?.status === 'running');
  assert.equal((await runner.list())[0].stale, false);
  services[0] = { ...services[0], run: { ...services[0].run, cmd: services[0].run.cmd + ' ' } };
  assert.equal((await runner.list())[0].stale, true);
});

test('startAll starts in dependency order; stopAll stops everything', async (t) => {
  const services = [
    { id: 'web', name: 'Web', depends: ['api'], run: { cmd: node('setInterval(()=>{},1000)') } },
    { id: 'api', name: 'Api', run: { cmd: node('setInterval(()=>{},1000)') } },
  ];
  const { runner, events } = makeRunner(services);
  t.after(() => runner.shutdownSync());
  await runner.startAll();
  const starting = events.filter((e) => e.status === 'starting').map((e) => e.id);
  assert.deepEqual(starting, ['api', 'web'], 'api (dependency) must start before web');
  const listed = await runner.list();
  assert.ok(listed.every((e) => e.status === 'running'), JSON.stringify(listed));
  await runner.stopAll();
  assert.ok((await runner.list()).every((e) => e.status === 'stopped'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/runner.test.js`
Expected: the three new tests FAIL (`runner.list is not a function`); Task 1 tests still pass.

- [ ] **Step 3: Implement list/get/startAll/stopAll**

In `runner.js`, inside `createRunner` (replacing Task 1's `get`), add:

```js
  async function entry(svc) {
    const invalid = validateRun(svc.run);
    const p = procs.get(svc.id);
    const port = (svc.run && Number.isInteger(svc.run.port)) ? svc.run.port : null;
    if (alive(p)) {
      return {
        id: svc.id, name: svc.name, status: p.status, pid: p.pid, port,
        startedAt: p.startedAt, stale: p.config !== JSON.stringify(svc.run), invalid,
      };
    }
    // Not ours: a listener on the declared port is some external process.
    if (port && await portListening(port)) {
      return { id: svc.id, name: svc.name, status: 'external', pid: null, port, startedAt: null, stale: false, invalid };
    }
    return { id: svc.id, name: svc.name, status: p ? p.status : 'stopped', pid: null, port, startedAt: null, stale: false, invalid };
  }

  function list() {
    return Promise.all(loadServices().map(entry));
  }

  async function get(id) {
    const svc = loadServices().find((s) => s.id === id);
    if (!svc) return null;
    const p = procs.get(id);
    return { ...(await entry(svc)), output: p ? p.output : [] };
  }

  // Kahn-ish topological order over `depends`, restricted to services.
  // A cycle just appends the remainder — start order degrades, never blocks.
  function topoOrder(services) {
    const ids = new Set(services.map((s) => s.id));
    const order = [];
    const done = new Set();
    while (order.length < services.length) {
      const ready = services.filter((s) => !done.has(s.id) &&
        (Array.isArray(s.depends) ? s.depends : []).filter((d) => ids.has(d)).every((d) => done.has(d)));
      if (!ready.length) {
        for (const s of services) if (!done.has(s.id)) { order.push(s); done.add(s.id); }
        break;
      }
      for (const s of ready) { order.push(s); done.add(s.id); }
    }
    return order;
  }

  async function startAll() {
    for (const svc of topoOrder(loadServices())) {
      if (alive(procs.get(svc.id))) continue;
      if ((await entry(svc)).status === 'external') continue;
      if (start(svc.id).error) continue; // invalid config — skip, banner already reports it
      await waitWhile(svc.id, (s) => s === 'starting'); // dependents wait for running/crashed
    }
    return { ok: true };
  }

  async function stopAll() {
    for (const svc of topoOrder(loadServices()).reverse()) {
      if (!alive(procs.get(svc.id))) continue;
      stop(svc.id);
      await waitWhile(svc.id, (s) => s === 'starting' || s === 'running');
    }
    return { ok: true };
  }
```

Update the return to the full API:

```js
  return { start, stop, restart, get, list, startAll, stopAll, shutdownSync };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/runner.test.js`
Expected: all 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add runner.js test/runner.test.js
git commit -m "feat: runner list/get with external+stale detection, dependency-ordered start-all"
```

---

### Task 3: server.js — validation, endpoints, SSE, exit cleanup

**Files:**
- Modify: `server.js`
- Test: `test/runner.test.js` (the `loadProject` validation case lives here too, keeping this feature's tests in one file)

**Interfaces:**
- Consumes: `createRunner`, `validateRun` from `runner.js` (Task 2 API).
- Produces (HTTP API used by the frontend in Tasks 4–5):
  - `GET  /api/services` → `{ services: [entry] }` (entry shape from Task 2)
  - `GET  /api/services/:id` → entry + `output: string[]`, 404 `{ error }` if unknown
  - `POST /api/services/:id/start|stop|restart` → `{ ok: true }` or `{ error }` with the runner's code
  - `POST /api/services/start-all` / `stop-all` → `{ ok: true }`
  - SSE frames `event: service` / `data: { id, status }` on the existing `/api/events` stream
  - `loadProject` gains `run:` validation errors in its `errors` array

- [ ] **Step 1: Write the failing validation test**

Append to `test/runner.test.js`:

```js
test('loadProject validates run blocks', () => {
  const fs = require('fs');
  const os = require('os');
  const pathMod = require('path');
  const { loadProject } = require('../server');
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'dc-run-'));
  const yamlPath = pathMod.join(dir, 'project.yaml');
  fs.writeFileSync(yamlPath, [
    'project: t',
    'items:',
    '  - { id: good, name: G, type: backend, status: planned, run: { cmd: node x.js, port: 3000 } }',
    '  - { id: nocmd, name: N, type: backend, status: planned, run: { port: 3000 } }',
    '  - { id: badport, name: B, type: backend, status: planned, run: { cmd: x, port: yes } }',
  ].join('\n'));
  const { errors } = loadProject(yamlPath);
  assert.ok(errors.some((e) => e.includes('"nocmd"') && e.includes('cmd')), JSON.stringify(errors));
  assert.ok(errors.some((e) => e.includes('"badport"') && e.includes('port')), JSON.stringify(errors));
  assert.ok(!errors.some((e) => e.includes('"good"')), JSON.stringify(errors));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/runner.test.js`
Expected: the new test FAILS (no run-block errors produced).

- [ ] **Step 3: Wire validation and the runner into server.js**

In `server.js`:

1. Top of file, extend the runner import next to the existing requires:

```js
const { createRunner, validateRun } = require('./runner');
```

2. In `loadProject`, inside the per-item validation loop (right after the `tests` validation block, ~line 104), add:

```js
    if (item.run != null) {
      const bad = validateRun(item.run);
      if (bad) errors.push(`Item ${label}: ${bad}`);
    }
```

3. In `main()`, after the `workflow` creation (~line 421), create the runner and hook process exit:

```js
  const runner = createRunner({
    projectDir,
    loadServices: () => loadProject(args.yamlPath).items.filter((i) => i && i.id && i.run != null),
    broadcast: (ev) => {
      const frame = `event: service\ndata: ${JSON.stringify(ev)}\n\n`;
      for (const client of sseClients) client.write(frame);
    },
  });
  // Children die with us: Ctrl+C, kill, or normal exit all sweep the tree.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { runner.shutdownSync(); process.exit(0); });
  }
  process.on('exit', () => runner.shutdownSync());
```

4. In the request handler, after the `/api/graphify/regenerate` route (~line 483), add the service routes. Order matters: exact paths (`start-all`/`stop-all`) before the `:id` patterns.

```js
    if (url.pathname === '/api/services' && req.method === 'GET') {
      return runner.list().then((services) => sendJson(res, 200, { services }));
    }

    if ((url.pathname === '/api/services/start-all' || url.pathname === '/api/services/stop-all') && req.method === 'POST') {
      if (!originAllowed(req, args.port)) return sendJson(res, 403, { error: 'Cross-origin request rejected' });
      const op = url.pathname.endsWith('start-all') ? runner.startAll() : runner.stopAll();
      return op.then((r) => sendJson(res, 200, r));
    }

    const svcAction = url.pathname.match(/^\/api\/services\/([^/]+)\/(start|stop|restart)$/);
    if (svcAction && req.method === 'POST') {
      if (!originAllowed(req, args.port)) return sendJson(res, 403, { error: 'Cross-origin request rejected' });
      return Promise.resolve(runner[svcAction[2]](svcAction[1])).then((r) =>
        r.error ? sendJson(res, r.code || 400, { error: r.error }) : sendJson(res, 200, r));
    }

    const svcGet = url.pathname.match(/^\/api\/services\/([^/]+)$/);
    if (svcGet && req.method === 'GET') {
      return runner.get(svcGet[1]).then((s) =>
        s ? sendJson(res, 200, s) : sendJson(res, 404, { error: `Unknown service "${svcGet[1]}"` }));
    }
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: everything PASSES (runner tests, validation test, and all pre-existing tests).

- [ ] **Step 5: Smoke-test the endpoints against the real server**

Add a `run:` block to this repo's own `example/project.yaml` is NOT wanted (the example stays minimal). Instead smoke against a scratch yaml:

```bash
cd "$(mktemp -d)" && cat > project.yaml <<'EOF'
project: smoke
items:
  - id: ticker
    name: Ticker
    type: backend
    status: shipped
    run: { cmd: node -e "setInterval(()=>console.log('tick'),500)" }
EOF
node C:/Users/rwdav/dev/diagram-copilot/server.js project.yaml --port 4499 --no-open &
sleep 2
curl -s http://localhost:4499/api/services
curl -s -X POST http://localhost:4499/api/services/ticker/start
sleep 1
curl -s http://localhost:4499/api/services/ticker
curl -s -X POST http://localhost:4499/api/services/ticker/stop
kill %1
```

Expected: list shows `ticker` stopped → start `{"ok":true}` → get shows `running` (after the 2s grace) or `starting`, with `tick` lines in `output` → stop ok.

- [ ] **Step 6: Commit**

```bash
git add server.js test/runner.test.js
git commit -m "feat: /api/services endpoints, run-block validation, SSE service events, exit cleanup"
```

---

### Task 4: Frontend — useServices hook, ServiceDot chip, Run tab

**Files:**
- Create: `web/src/useServices.jsx`
- Create: `web/src/RunView.jsx`
- Modify: `web/src/chips.jsx`
- Modify: `web/src/App.jsx`
- Modify: `web/src/App.css` (one small block)

**Interfaces:**
- Consumes: `GET /api/services`, `POST /api/services/...` (Task 3), `onServerEvent` + `post` from `useWorkflowFeed.jsx`.
- Produces:
  - `useServices()` → array of service entries (auto-refreshed on SSE `service` events); `svcPost(id, action)` helper.
  - `ServiceDot({ service })` chip in `chips.jsx` — renders nothing when `service` is null/undefined (items without run blocks stay clean, same pattern as `TestChip`).
  - `RunView({ services, onSelect })` component.
  - App renders a `Run` tab and holds the services array (Task 5 threads it into the other views).

There is no frontend test infra in this repo — verification is `npm run build` + the browser check in Task 6.

- [ ] **Step 1: Create the hook**

Create `web/src/useServices.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { onServerEvent } from './useWorkflowFeed.jsx';

export const svcPost = (id, action) =>
  fetch(`/api/services/${encodeURIComponent(id)}/${action}`, { method: 'POST' });

// All service state, kept live: full refetch on every SSE `service` event.
// ponytail: refetch-on-event over delta merging; revisit if service counts grow.
export function useServices() {
  const [services, setServices] = useState([]);
  useEffect(() => {
    let stale = false;
    const refetch = () =>
      fetch('/api/services')
        .then((r) => r.json())
        .then((d) => { if (!stale) setServices(d.services || []); })
        .catch(() => {});
    refetch();
    const off = onServerEvent('service', refetch);
    const offReload = onServerEvent('reload', refetch); // run: blocks live in project.yaml
    return () => { stale = true; off(); offReload(); };
  }, []);
  return services;
}
```

- [ ] **Step 2: Add ServiceDot to chips.jsx**

Append to `web/src/chips.jsx` (StatusDot and Text are already imported):

```jsx
const SERVICE_VARIANT = { stopped: 'neutral', starting: 'warning', running: 'success', crashed: 'error', external: 'info' };

// Live process status for items with a run: block; nothing otherwise.
export function ServiceDot({ service, withLabel = false }) {
  if (!service) return null;
  return (
    <>
      <StatusDot variant={SERVICE_VARIANT[service.status] || 'neutral'} label={`service ${service.status}`} />
      {withLabel && <Text type="supporting" size="xsm">{service.status}</Text>}
    </>
  );
}
```

If `StatusDot` rejects an `info` variant at build/runtime, fall back to `neutral` for `external` — check the other usages of `variant="info"` in this codebase (`DesignView.jsx` uses `Badge variant="info"`, so `info` likely exists on StatusDot too).

- [ ] **Step 3: Create RunView**

Create `web/src/RunView.jsx`:

```jsx
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { ServiceDot } from './chips.jsx';
import { post } from './useWorkflowFeed.jsx';
import { svcPost } from './useServices.jsx';

export default function RunView({ services, onSelect }) {
  if (!services.length) {
    return (
      <div className="run-view">
        <EmptyState
          title="No services declared"
          description="Give items in project.yaml a run: block (cmd, optional cwd/port/env) and they become controllable here."
        />
      </div>
    );
  }
  const anyLive = services.some((s) => s.status === 'running' || s.status === 'starting');
  return (
    <div className="run-view">
      <HStack gap={2} vAlign="center">
        <Text type="large" weight="bold">Services</Text>
        <div style={{ marginLeft: 'auto' }}>
          <HStack gap={1}>
            <Button label="Start all" variant="primary" size="sm" onClick={() => post('/api/services/start-all')} />
            <Button label="Stop all" variant="secondary" size="sm" isDisabled={!anyLive} onClick={() => post('/api/services/stop-all')} />
          </HStack>
        </div>
      </HStack>
      <table className="run-table">
        <thead>
          <tr><th>Service</th><th>Status</th><th>Port</th><th>PID</th><th>Since</th><th /></tr>
        </thead>
        <tbody>
          {services.map((s) => {
            const live = s.status === 'running' || s.status === 'starting';
            return (
              <tr key={s.id}>
                <td><Button label={s.name} variant="ghost" size="sm" onClick={() => onSelect(s.id)} /></td>
                <td>
                  <HStack gap={1} vAlign="center">
                    <ServiceDot service={s} withLabel />
                    {s.stale && <Badge variant="warning" label="config changed" />}
                    {s.invalid && <Badge variant="error" label="invalid run config" />}
                  </HStack>
                </td>
                <td>{s.port ? <Text type="code">:{s.port}</Text> : null}</td>
                <td>{s.pid ? <Text type="code">{s.pid}</Text> : null}</td>
                <td>{s.startedAt ? <Timestamp value={s.startedAt} format="time" /> : null}</td>
                <td>
                  <HStack gap={1}>
                    <Button label="Start" size="sm" variant="secondary" isDisabled={live || s.status === 'external' || !!s.invalid} onClick={() => svcPost(s.id, 'start')} />
                    <Button label="Stop" size="sm" variant="secondary" isDisabled={!live} onClick={() => svcPost(s.id, 'stop')} />
                    <Button label="Restart" size="sm" variant="secondary" isDisabled={s.status === 'external' || !!s.invalid} onClick={() => svcPost(s.id, 'restart')} />
                  </HStack>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Wire the tab into App.jsx**

In `web/src/App.jsx`:

1. Imports:

```jsx
import RunView from './RunView.jsx';
import { useServices } from './useServices.jsx';
```

2. Inside `App()`, after the `detailOpen` state line:

```jsx
  const services = useServices();
```

3. Add the tab after `<Tab value="graph" label="Graph" />`:

```jsx
          <Tab value="run" label="Run" />
```

4. Add the view after the graph line in `<main>`:

```jsx
        {view === 'run' && <RunView services={services} onSelect={setSelectedId} />}
```

- [ ] **Step 5: Style the table**

Append to `web/src/App.css`:

```css
.run-view { flex: 1; padding: 16px; overflow: auto; }
.run-table { margin-top: 12px; border-collapse: collapse; width: 100%; }
.run-table th { text-align: left; font-size: 12px; opacity: 0.7; padding: 6px 10px; }
.run-table td { padding: 6px 10px; border-top: 1px solid var(--border, #e3e3e6); }
```

Match the existing `App.css` variable conventions — if it defines a border-color variable with a different name, use that instead of `--border`.

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: vite build succeeds with no errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/useServices.jsx web/src/RunView.jsx web/src/chips.jsx web/src/App.jsx web/src/App.css
git commit -m "feat: Run tab — service table with start/stop/restart and live status"
```

---

### Task 5: Frontend — status dots on diagram/board, Service section in DetailPanel

**Files:**
- Modify: `web/src/App.jsx`
- Modify: `web/src/DesignView.jsx`
- Modify: `web/src/DiagramView.jsx`
- Modify: `web/src/BoardView.jsx`
- Modify: `web/src/DetailPanel.jsx`

**Interfaces:**
- Consumes: `useServices` array in App (Task 4), `ServiceDot` (Task 4), `svcPost` (Task 4), `GET /api/services/:id` (Task 3).
- Produces: `servicesById` prop threading: App → DesignView → DiagramView, App → BoardView, App → DetailPanel.

- [ ] **Step 1: Thread servicesById through App.jsx**

In `App()` after `const services = useServices();`:

```jsx
  const servicesById = Object.fromEntries(services.map((s) => [s.id, s]));
```

Update the view/panel renders to pass it:

```jsx
        {view === 'design' && <DesignView items={items} flows={data.flows || []} selectedId={selectedId} onSelect={setSelectedId} servicesById={servicesById} />}
        {view === 'board' && <BoardView items={items} selectedId={selectedId} onSelect={setSelectedId} servicesById={servicesById} />}
```

and on the DetailPanel:

```jsx
            <DetailPanel item={selected} items={items} width={detailW} service={servicesById[selected.id]} onSelect={setSelectedId} onClose={() => setSelectedId(null)} onCollapse={toggleDetail} onStartWorkflow={startWorkflow} />
```

- [ ] **Step 2: DesignView → DiagramView**

In `web/src/DesignView.jsx`, add `servicesById` to the component's props and pass it to both `<DiagramView …>` call sites (lines ~79 and ~127):

```jsx
<DiagramView items={items} flows={flows} selectedId={selectedId} onSelect={onSelect} active={activeWorkflow} servicesById={servicesById} />
```

- [ ] **Step 3: DiagramView node dots**

In `web/src/DiagramView.jsx`:

1. Import `ServiceDot` (extend the existing chips import on line 7):

```jsx
import { TypeBadge, StatusChip, SpecFlag, TestChip, PlanChip, ServiceDot } from './chips.jsx';
```

2. Add `servicesById = {}` to the `DiagramView` props (line ~379), add `service: servicesById[item.id] || null` to the item-node `data` object (~line 425–431), and add `servicesById` to the `useMemo` dependency array (~line 499).

3. In `ItemNode`'s chip row (after `<TestChip tests={data.item.tests} />`, line ~79) and in `ScreenNode`'s chip row (line ~185), add:

```jsx
        <ServiceDot service={data.service} />
```

- [ ] **Step 4: BoardView card dots**

In `web/src/BoardView.jsx`: add `servicesById = {}` to props, import `ServiceDot` from `./chips.jsx`, and in the card chip row (after `<SpecFlag spec={item.spec} />`, line ~33) add:

```jsx
                  <ServiceDot service={servicesById[item.id]} />
```

- [ ] **Step 5: DetailPanel Service section**

In `web/src/DetailPanel.jsx`:

1. Extend the chips import (line 9):

```jsx
import { TypeBadge, TestChip, ServiceDot, STATUS_VARIANT, TEST_STATUS_VARIANT } from './chips.jsx';
import { svcPost } from './useServices.jsx';
```

2. Add a `ServiceSection` component above `DetailPanel`:

```jsx
// Controls + recent output for an item with a run: block. Output comes from
// GET /api/services/:id, refetched whenever the live status flips.
function ServiceSection({ item, service }) {
  const [output, setOutput] = useState([]);
  useEffect(() => {
    if (!service) return;
    let cancelled = false;
    fetch(`/api/services/${encodeURIComponent(item.id)}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setOutput(d.output || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [item.id, service?.status]);
  if (!service) return null;
  const live = service.status === 'running' || service.status === 'starting';
  return (
    <VStack gap={1}>
      <HStack gap={2} vAlign="center">
        <Text type="label">Service</Text>
        <ServiceDot service={service} withLabel />
        {service.port && <Text type="code">:{service.port}</Text>}
        {service.stale && <Badge variant="warning" label="config changed — restart" />}
      </HStack>
      <HStack gap={1}>
        <Button label="Start" size="sm" variant="secondary" isDisabled={live || service.status === 'external' || !!service.invalid} onClick={() => svcPost(item.id, 'start')} />
        <Button label="Stop" size="sm" variant="secondary" isDisabled={!live} onClick={() => svcPost(item.id, 'stop')} />
        <Button label="Restart" size="sm" variant="secondary" isDisabled={service.status === 'external' || !!service.invalid} onClick={() => svcPost(item.id, 'restart')} />
      </HStack>
      {service.invalid && <Text type="supporting" as="p">Invalid run config: {service.invalid}</Text>}
      {output.length > 0 && <pre className="schema-body">{output.slice(-40).join('\n')}</pre>}
    </VStack>
  );
}
```

3. Add `service` to `DetailPanel`'s props and render the section right after the Start-workflow button `HStack` (line ~105):

```jsx
        <ServiceSection item={item} service={service} />
```

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: vite build succeeds.

- [ ] **Step 7: Commit**

```bash
git add web/src/App.jsx web/src/DesignView.jsx web/src/DiagramView.jsx web/src/BoardView.jsx web/src/DetailPanel.jsx
git commit -m "feat: service status dots on diagram/board and service controls in detail panel"
```

---

### Task 6: Docs, end-to-end verification, project.yaml bookkeeping

**Files:**
- Modify: `AGENTS.md` (schema section)
- Modify: `README.md`
- Modify: `project.yaml` (this repo's own — add the service-runner item as shipped with its tests)

**Interfaces:**
- Consumes: everything above.
- Produces: documented `run:` schema for agents; verified working feature.

- [ ] **Step 1: Document the run block in AGENTS.md**

Find the item-schema section in `AGENTS.md` (it documents `id/name/type/status/spec/depends/notes/contracts/flows/tests`) and add, matching its existing style:

```markdown
- `run:` (optional) — makes the item a controllable service in the Run tab:
  `run: { cmd: "npm run dev", cwd: web, port: 5173, env: { NODE_ENV: development } }`.
  `cmd` is required; `cwd` is relative to project.yaml; declaring `port` enables
  readiness detection (starting → running when the port answers) and
  external-process detection. Services are child processes of the dashboard
  server and die with it.
```

- [ ] **Step 2: Document the Run tab in README.md**

In the Views list of `README.md`, add:

```markdown
- **Run** — process control for items with a `run:` block: start / stop /
  restart per service (and Start All in dependency order), live status
  (stopped / starting / running / crashed / external), port and recent output.
  Status dots also appear on the diagram and board.
```

- [ ] **Step 3: Record the feature in this repo's project.yaml**

Add a shipped item (follow the existing style in `project.yaml`; use the `tests:` entries below):

```yaml
  - id: service-runner
    name: Service Runner
    type: backend
    status: shipped
    spec: docs/superpowers/specs/2026-07-12-service-runner-design.md
    notes: >-
      run: blocks on items become controllable services — start/stop/restart,
      live status over SSE, Run tab + dots on diagram/board + detail-panel
      controls. runner.js spawns children of the server; tree-kill on stop;
      everything dies with the server. v2: docker, log streaming, auto-restart.
    tests:
      - { name: "runner: lifecycle, readiness, crash, external, start-all", file: test/runner.test.js, status: passing }
```

- [ ] **Step 4: Full test run + build**

Run: `npm test` then `npm run build`
Expected: all tests pass; build succeeds.

- [ ] **Step 5: End-to-end browser verification**

Use the repo's `verify` skill if executing interactively; otherwise manually:

1. Add a `run:` block to `../todo-list-app/project.yaml`'s `tasks-api` item (e.g. `run: { cmd: node src/server.js, port: 3000 }`) — check `todo-list-app`'s actual server entry point and port in its package.json first.
2. Restart the main server (root project.yaml, port 4400) per the dogfood setup, and also run `node server.js ../todo-list-app/project.yaml --port 4401 --no-open`.
3. In the browser on :4401 — Run tab lists the service; Start flips it stopped → starting → running (dot goes green on the diagram too); Stop flips it back; killing the API process externally (`taskkill`) flips it to crashed; Ctrl+C on the dashboard server leaves no orphaned node processes (`tasklist | findstr node`).

Expected: all five behaviors observed.

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md README.md project.yaml
git commit -m "docs: run: block schema, Run tab docs; record service-runner as shipped"
```
