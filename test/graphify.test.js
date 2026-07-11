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
