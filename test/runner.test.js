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
