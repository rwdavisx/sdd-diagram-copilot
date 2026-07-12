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
  const { calls, execFileFn } = fakeExec([]);
  const logged = [];
  const g = createGraphify({ execFileFn, existsFn: () => false, log: (m) => logged.push(m) });
  assert.strictEqual(await g.ensureInstalled(), false);
  assert.strictEqual(g.available, false);
  assert.match(g.installHint, /uv|pipx/);
  assert.strictEqual(logged.length, 1);
  // The uv bootstrap installer was at least attempted before giving up.
  const installer = process.platform === 'win32' ? 'powershell' : 'sh';
  assert.ok(calls.some((c) => c[0] === installer));
});

const UV_INSTALLER = process.platform === 'win32' ? 'powershell' : 'sh';

test('ensureInstalled: no uv at all -> bootstraps uv via installer, then uv tool install', async () => {
  const ok = []; // installer success makes 'uv' start working
  const calls = [];
  const execFileFn = (cmd, args, opts, cb) => {
    calls.push([cmd, ...args]);
    if (cmd === UV_INSTALLER) { ok.push('uv'); return setImmediate(() => cb(null)); }
    setImmediate(() => cb(ok.includes(cmd) ? null : new Error(`spawn ${cmd} ENOENT`)));
  };
  const g = createGraphify({ execFileFn, existsFn: () => false, log: () => {} });
  assert.strictEqual(await g.ensureInstalled(), true);
  assert.ok(calls.some((c) => c[0] === UV_INSTALLER));
  assert.deepStrictEqual(calls.find((c) => c[0] === 'uv' && c[2] === 'install'),
    ['uv', 'tool', 'install', 'graphifyy']);
});

test('ensureInstalled: fresh installs land in ~/.local/bin -> resolved by absolute path', async () => {
  const os = require('node:os');
  const pathMod = require('node:path');
  const { EventEmitter } = require('node:events');
  const ext = process.platform === 'win32' ? '.exe' : '';
  const uvPath = pathMod.join(os.homedir(), '.local', 'bin', `uv${ext}`);
  const gPath = pathMod.join(os.homedir(), '.local', 'bin', `graphify${ext}`);
  const exists = new Set(); // what "installed on disk" looks like over time
  const execFileFn = (cmd, args, opts, cb) => {
    if (cmd === UV_INSTALLER) { exists.add(uvPath); return setImmediate(() => cb(null)); }
    if (cmd === uvPath && args[1] === 'install') { exists.add(gPath); return setImmediate(() => cb(null)); }
    // PATH lookups always fail; absolute paths work once the file exists.
    setImmediate(() => cb(exists.has(cmd) ? null : new Error(`spawn ${cmd} ENOENT`)));
  };
  const spawned = [];
  const g = createGraphify({
    execFileFn,
    existsFn: (p) => exists.has(p),
    log: () => {},
    execFileSyncFn: () => { throw new Error('not a git repo'); },
    spawnFn: (cmd) => { spawned.push(cmd); return new EventEmitter(); },
  });
  assert.strictEqual(await g.ensureInstalled(), true);
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'gfy-'));
  g.ensureGraphFresh(dir);
  assert.strictEqual(spawned[0], gPath); // regen uses the resolved absolute path
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
function installed({ gitState = { head: 'aaa', porcelain: '' }, env = { ANTHROPIC_API_KEY: 'x' } } = {}) {
  const spawned = [];
  const { execFileFn } = fakeExec(['graphify', 'uv']);
  const g = createGraphify({
    execFileFn,
    log: () => {},
    env,
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
  assert.strictEqual(spawned[0].args[0], '.');
  assert.strictEqual(spawned[0].opts.cwd, dir);
});

test('regen with an LLM key: single full pass', async () => {
  const { g, spawned, ready } = installed({ env: { ANTHROPIC_API_KEY: 'x' } });
  await ready;
  const dir = tmpProject();
  g.ensureGraphFresh(dir);
  assert.deepStrictEqual(spawned[0].args, ['.']);
  spawned[0].child.emit('exit', 0);
  assert.strictEqual(spawned.length, 1); // no second stage
  assert.ok(fs.existsSync(g.paths(dir).marker));
});

test('regen keyless: --code-only then cluster-only --no-label, marker only after both', async () => {
  const { g, spawned, ready } = installed({ env: {} });
  await ready;
  const dir = tmpProject();
  g.ensureGraphFresh(dir);
  assert.deepStrictEqual(spawned[0].args, ['.', '--code-only']);
  spawned[0].child.emit('exit', 0);
  assert.strictEqual(fs.existsSync(g.paths(dir).marker), false); // not done yet
  assert.deepStrictEqual(spawned[1].args, ['cluster-only', '.', '--no-label']);
  spawned[1].child.emit('exit', 0);
  assert.ok(fs.existsSync(g.paths(dir).marker));
});

test('regen keyless: failed second stage writes no marker and clears in-flight', async () => {
  const { g, spawned, ready } = installed({ env: {} });
  await ready;
  const dir = tmpProject();
  g.ensureGraphFresh(dir);
  spawned[0].child.emit('exit', 0);
  spawned[1].child.emit('exit', 1);
  assert.strictEqual(fs.existsSync(g.paths(dir).marker), false);
  g.ensureGraphFresh(dir); // retries: not stuck in the regenerating set
  assert.strictEqual(spawned.length, 3);
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
