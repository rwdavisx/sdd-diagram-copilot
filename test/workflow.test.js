const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkflow, STEPS } = require('../workflow');

const ITEMS = [
  { id: 'feat-a', name: 'Feature A', status: 'planned', notes: 'some notes' },
  { id: 'feat-b', name: 'Feature B', status: 'shipped' },
  { id: 'feat-c', name: 'Feature C', status: 'planned', spec: 'specs/feat-c.md' },
];

let dir, sessions, broadcasts, updates, worktrees, merged;

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

function makeWorkflow(extra = {}) {
  return createWorkflow({
    projectDir: dir,
    loadItems: () => ITEMS,
    runSession: fakeRunSession,
    broadcast: (ev) => broadcasts.push(ev),
    updateItem: (id, fields) => updates.push([id, fields]),
    listWorktrees: () => worktrees,
    isBranchMerged: (_dir, branch) => merged.includes(branch),
    ...extra,
  });
}

// Write an artifact with an mtime safely after the running step started.
function writeArtifact(rel, content = 'x') {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(p, future, future);
}

const lastSession = () => sessions.at(-1);
const turnEnd = () => lastSession().args.onEvent({ kind: 'turn-end', ok: true, costUsd: 0 });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  sessions = [];
  broadcasts = [];
  updates = [];
  worktrees = [];
  merged = [];
});

test('assistant-delta is broadcast live but never stored in the transcript', () => {
  const wf = makeWorkflow();
  wf.start('feat-a');
  lastSession().args.onEvent({ kind: 'assistant-delta', text: 'He' });
  assert.ok(broadcasts.some((b) => b.kind === 'assistant-delta' && b.text === 'He'));
  assert.ok(!wf.getTranscript().some((ev) => ev.kind === 'assistant-delta'));
});

test('transcript events carry an ISO timestamp', () => {
  const wf = makeWorkflow();
  wf.start('feat-a');
  const ev = wf.getTranscript()[0];
  assert.ok(ev.at && !Number.isNaN(Date.parse(ev.at)));
});

test('start rejects unknown and specless late-start items', () => {
  const wf = makeWorkflow();
  assert.strictEqual(wf.start('nope').code, 400);
  assert.strictEqual(wf.start('feat-a', 'worktree').code, 400); // no spec
  assert.strictEqual(wf.start('feat-a', 'bogus').code, 400);
  assert.strictEqual(sessions.length, 0);
});

test('shipped items can start a new workflow (iterate) and flip back to in-progress', () => {
  const wf = makeWorkflow();
  const { state } = wf.start('feat-b'); // feat-b is shipped
  assert.strictEqual(state.step, 'brainstorm');
  assert.strictEqual(state.stepStatus, 'running');
  assert.deepStrictEqual(updates[0], ['feat-b', { status: 'in-progress' }]);
});

test('start spawns a brainstorm session and persists running state', () => {
  const wf = makeWorkflow();
  const { state } = wf.start('feat-a');
  assert.strictEqual(state.step, 'brainstorm');
  assert.strictEqual(state.stepStatus, 'running');
  assert.deepStrictEqual(state.pipeline, STEPS);
  assert.match(lastSession().args.initialPrompt, /superpowers:brainstorming/);
  assert.match(lastSession().args.initialPrompt, /some notes/);
  assert.strictEqual(lastSession().args.cwd, dir);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, '.superpowers', 'workflow.json'), 'utf8'));
  assert.strictEqual(saved.itemId, 'feat-a');
});

test('start returns 409 while a workflow is running', () => {
  const wf = makeWorkflow();
  wf.start('feat-a');
  assert.strictEqual(wf.start('feat-a').code, 409);
});

test('brainstorm completion records the spec and gates before worktree', () => {
  const wf = makeWorkflow();
  wf.start('feat-a');
  writeArtifact('specs/feat-a.md', '# spec');
  turnEnd();
  // starting brainstorm flips the status, then completion records the spec
  assert.deepStrictEqual(updates, [
    ['feat-a', { status: 'in-progress' }],
    ['feat-a', { spec: 'specs/feat-a.md' }],
  ]);
  assert.strictEqual(wf.getState().steps.brainstorm, 'done');
  assert.strictEqual(wf.getState().step, 'brainstorm'); // parked at the gate
  assert.strictEqual(wf.getState().stepStatus, 'gated');
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].closed, true);

  wf.advance();
  assert.strictEqual(wf.getState().step, 'worktree');
  assert.strictEqual(wf.getState().stepStatus, 'running');
  assert.strictEqual(sessions.length, 2);
  assert.match(lastSession().args.initialPrompt, /using-git-worktrees/);
});

test('advance is rejected unless a step is waiting at a gate', () => {
  const wf = makeWorkflow();
  assert.strictEqual(wf.advance().code, 409); // no workflow at all
  wf.start('feat-a');
  assert.strictEqual(wf.advance().code, 409); // still running
});

test('a gated workflow survives a restart and can be advanced', () => {
  const wf = makeWorkflow();
  wf.start('feat-a');
  writeArtifact('specs/feat-a.md', '# spec');
  turnEnd();
  const wf2 = makeWorkflow(); // fresh server process
  assert.strictEqual(wf2.getState().stepStatus, 'gated');
  wf2.advance();
  assert.strictEqual(wf2.getState().step, 'worktree');
  assert.strictEqual(wf2.getState().stepStatus, 'running');
});

test('a stale spec file does not complete a fresh brainstorm', () => {
  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'specs', 'feat-a.md'), '# old');
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(dir, 'specs', 'feat-a.md'), past, past);
  const wf = makeWorkflow();
  wf.start('feat-a');
  turnEnd();
  assert.strictEqual(wf.getState().step, 'brainstorm');
  assert.strictEqual(wf.getState().stepStatus, 'running');
});

test('worktree completion captures the path and later steps run inside it', () => {
  const wf = makeWorkflow();
  wf.start('feat-c', 'worktree'); // has a spec, so brainstorm is skippable
  assert.strictEqual(wf.getState().steps.brainstorm, 'skipped');
  worktrees = [{ path: path.join(dir, '.wt', 'feat-c'), branch: 'feat-c' }];
  turnEnd();
  wf.advance();
  assert.strictEqual(wf.getState().worktreePath, worktrees[0].path);
  assert.strictEqual(wf.getState().step, 'plan');
  assert.strictEqual(lastSession().args.cwd, worktrees[0].path);
});

function advanceToExecute(wf) {
  wf.start('feat-c', 'worktree');
  worktrees = [{ path: dir, branch: 'feat-c' }]; // reuse tmp dir as "worktree"
  turnEnd(); wf.advance(); // worktree -> plan
  writeArtifact('docs/superpowers/plans/feat-c.md', '# plan');
  turnEnd(); wf.advance(); // plan -> execute
}

test('starting any step marks a planned item in-progress', () => {
  const wf = makeWorkflow();
  wf.start('feat-a'); // starts at brainstorm — not just execute
  assert.deepStrictEqual(updates[0], ['feat-a', { status: 'in-progress' }]);
});

test('execute completes only on a DONE progress file', () => {
  const wf = makeWorkflow();
  advanceToExecute(wf);
  assert.strictEqual(wf.getState().step, 'execute');
  assert.ok(updates.some(([id, f]) => id === 'feat-c' && f.status === 'in-progress'));

  writeArtifact('.superpowers/sdd/progress.md', 'Task 1: complete\n'); // no DONE yet
  turnEnd();
  assert.strictEqual(wf.getState().step, 'execute');

  writeArtifact('.superpowers/sdd/progress.md', 'Task 1: complete\nDONE\n');
  turnEnd();
  assert.strictEqual(wf.getState().stepStatus, 'gated');
  wf.advance();
  assert.strictEqual(wf.getState().step, 'review');
});

test('finish completes when the worktree is gone; merged branches ship the item', () => {
  const wf = makeWorkflow();
  advanceToExecute(wf);
  writeArtifact('.superpowers/sdd/progress.md', 'DONE');
  turnEnd(); wf.advance(); // -> review
  writeArtifact('.superpowers/review-feat-c.md', 'clean');
  turnEnd(); wf.advance(); // -> finish
  assert.strictEqual(wf.getState().step, 'finish');

  turnEnd(); // worktree still listed -> not complete
  assert.strictEqual(wf.getState().stepStatus, 'running');

  worktrees = [];
  merged = ['feat-c'];
  turnEnd();
  assert.strictEqual(wf.getState().stepStatus, 'done');
  assert.deepStrictEqual(updates.at(-1), ['feat-c', { status: 'shipped' }]);
});

test('finish on a discarded (unmerged) branch does not ship the item', () => {
  const wf = makeWorkflow();
  advanceToExecute(wf);
  writeArtifact('.superpowers/sdd/progress.md', 'DONE');
  turnEnd(); wf.advance();
  writeArtifact('.superpowers/review-feat-c.md', 'clean');
  turnEnd(); wf.advance();
  worktrees = [];
  turnEnd(); // not merged
  assert.strictEqual(wf.getState().stepStatus, 'done');
  assert.ok(!updates.some(([, f]) => f.status === 'shipped'));
});

test('restarting at a post-worktree step re-discovers the worktree or errors', () => {
  const wf = makeWorkflow();
  assert.match(wf.start('feat-c', 'plan').error, /No worktree/);
  worktrees = [{ path: '/wt/feat-c', branch: 'feat-c' }];
  const { state } = wf.start('feat-c', 'plan');
  assert.strictEqual(state.worktreePath, '/wt/feat-c');
  assert.strictEqual(lastSession().args.cwd, '/wt/feat-c');
});

test('session ending mid-step marks needs-attention', async () => {
  const wf = makeWorkflow();
  wf.start('feat-a');
  lastSession().finish({ ok: true, sessionId: 's1' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(wf.getState().stepStatus, 'needs-attention');
});

test('stop() ends a running step as stopped, not needs-attention', async () => {
  const wf = makeWorkflow();
  wf.start('feat-a');
  assert.strictEqual(wf.stop(), true);
  assert.strictEqual(wf.getState().stepStatus, 'stopped');
  lastSession().finish({ ok: true, sessionId: 's1' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(wf.getState().stepStatus, 'stopped');
});

test('plan-project completes on stop when project.yaml was modified', () => {
  const wf = makeWorkflow();
  const { state } = wf.planProject();
  assert.deepStrictEqual(state.pipeline, ['plan-project']);
  assert.match(lastSession().args.initialPrompt, /project\.yaml/);
  writeArtifact('project.yaml', 'project: x\nitems: []\n');
  wf.stop();
  assert.strictEqual(wf.getState().stepStatus, 'done');
});

test('plan-project stop without yaml changes just stops', () => {
  const wf = makeWorkflow();
  wf.planProject();
  wf.stop();
  assert.strictEqual(wf.getState().stepStatus, 'stopped');
});

test('analyze-project completes at turn-end once the report artifact appears', () => {
  const wf = makeWorkflow();
  const { state } = wf.analyzeProject();
  assert.deepStrictEqual(state.pipeline, ['analyze-project']);
  assert.match(lastSession().args.initialPrompt, /reverse-engineer/i);
  turnEnd();
  assert.strictEqual(wf.getState().stepStatus, 'running'); // no report yet
  writeArtifact('.superpowers/analyze-report.md', 'report');
  turnEnd();
  assert.strictEqual(wf.getState().stepStatus, 'done');
});

test('analyze-project completes on stop when project.yaml was modified', () => {
  const wf = makeWorkflow();
  wf.analyzeProject();
  writeArtifact('project.yaml', 'project: x\nitems: []\n');
  wf.stop();
  assert.strictEqual(wf.getState().stepStatus, 'done');
});

test('analyze-project stop without yaml changes just stops', () => {
  const wf = makeWorkflow();
  wf.analyzeProject();
  wf.stop();
  assert.strictEqual(wf.getState().stepStatus, 'stopped');
});

test('analyze-project rejects a second concurrent workflow', () => {
  const wf = makeWorkflow();
  wf.analyzeProject();
  assert.strictEqual(wf.analyzeProject().code, 409);
  assert.strictEqual(wf.start('feat-a').code, 409);
});

test('input echoes user-text and forwards to the session', () => {
  const wf = makeWorkflow();
  wf.start('feat-a');
  assert.strictEqual(wf.input('my answer'), true);
  assert.deepStrictEqual(lastSession().sent, ['my answer']);
  assert.ok(wf.getTranscript().some((e) => e.kind === 'user-text'));
  wf.stop();
  assert.strictEqual(wf.input('too late'), false);
});

test('a persisted running workflow loads as interrupted after restart', () => {
  const wf = makeWorkflow();
  wf.start('feat-a');
  const wf2 = makeWorkflow(); // fresh server process
  assert.strictEqual(wf2.getState().stepStatus, 'interrupted');
});

test('late events from a superseded run or step are ignored', async () => {
  const wf = makeWorkflow();
  wf.start('feat-a');
  const oldSession = lastSession();
  writeArtifact('specs/feat-a.md', '# spec');
  turnEnd(); wf.advance(); // brainstorm done -> worktree running (new session)
  const before = JSON.stringify(wf.getState());

  oldSession.args.onEvent({ kind: 'turn-end', ok: true, costUsd: 0 }); // stale step event
  oldSession.finish({ ok: true, sessionId: 's1' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(JSON.stringify(wf.getState()), before);
});

// ---------- per-step model/effort config ----------

const { resolveStepConfig } = require('../workflow');

test('resolveStepConfig merges defaults < step < item override', () => {
  const cfg = {
    defaults: { model: 'sonnet', effort: 'medium' },
    steps: { execute: { model: 'claude-fable-5', effort: 'high' }, review: { effort: 'low' } },
  };
  assert.deepStrictEqual(resolveStepConfig(cfg, 'brainstorm', {}), { model: 'sonnet', effort: 'medium' });
  assert.deepStrictEqual(resolveStepConfig(cfg, 'execute', {}), { model: 'claude-fable-5', effort: 'high' });
  assert.deepStrictEqual(resolveStepConfig(cfg, 'review', {}), { model: 'sonnet', effort: 'low' });
  assert.deepStrictEqual(
    resolveStepConfig(cfg, 'execute', { workflow: { model: 'haiku' } }),
    { model: 'haiku', effort: 'high' },
  );
  assert.deepStrictEqual(resolveStepConfig(null, 'execute', null), { model: undefined, effort: undefined });
});

test('startStep passes resolved model/effort to runSession', () => {
  const wf = createWorkflow({
    projectDir: dir,
    loadItems: () => ITEMS,
    loadWorkflowConfig: () => ({ defaults: { model: 'sonnet' }, steps: { brainstorm: { effort: 'high' } } }),
    runSession: fakeRunSession,
    broadcast: () => {},
  });
  wf.start('feat-a');
  assert.strictEqual(lastSession().args.model, 'sonnet');
  assert.strictEqual(lastSession().args.effort, 'high');
});

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
