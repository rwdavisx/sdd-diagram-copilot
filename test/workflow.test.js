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
  assert.deepStrictEqual(wf.getTranscript().at(-1), { seq: 0, kind: 'user-text', text: 'my answer' });
  assert.ok(broadcasts.some((e) => e.kind === 'user-text'));
});

test('transcript events carry increasing seq that resets on a new start()', () => {
  const wf = makeWorkflow();
  wf.start('feat-a');
  wf.input('one');
  wf.input('two');
  const seqs = wf.getTranscript().map((e) => e.seq);
  assert.deepStrictEqual(seqs, [0, 1]);

  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'specs', 'feat-a.md'), '# spec');
  sessions[0].args.onEvent({ kind: 'turn-end', ok: true, costUsd: 0 });

  wf.start('feat-a'); // new run on the same workflow instance resets seq
  wf.input('fresh');
  assert.deepStrictEqual(wf.getTranscript().map((e) => e.seq), [0]);
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

test('a stale run\'s late onEvent/done do not touch the new run\'s state or transcript', async () => {
  const wf = makeWorkflow();
  wf.start('feat-a'); // run A
  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'specs', 'feat-a.md'), '# spec');
  sessions[0].args.onEvent({ kind: 'turn-end', ok: true, costUsd: 0 }); // completes run A
  assert.strictEqual(wf.getState().stepStatus, 'done');

  wf.start('feat-a'); // run B
  const runAOnEvent = sessions[0].args.onEvent;
  const runAFinish = sessions[0].finish;
  const stateBefore = wf.getState();
  const transcriptBefore = wf.getTranscript().slice();

  runAFinish({ ok: true, sessionId: 's1' }); // run A's done resolves late
  await new Promise((r) => setImmediate(r));
  runAOnEvent({ kind: 'turn-end', ok: true, costUsd: 0 }); // run A's onEvent fires late

  assert.deepStrictEqual(wf.getState(), stateBefore);
  assert.deepStrictEqual(wf.getTranscript(), transcriptBefore);
});

test('input returns false and records nothing when session.send fails', () => {
  const wf = makeWorkflow();
  wf.start('feat-a');
  sessions[0].send = () => false;
  assert.strictEqual(wf.input('lost message'), false);
  assert.strictEqual(wf.getTranscript().length, 0);
});
