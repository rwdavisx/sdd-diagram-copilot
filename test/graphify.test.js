const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
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
