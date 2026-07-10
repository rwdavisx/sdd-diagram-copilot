// workflow.js — the single active workflow: an item moving through the
// six-step superpowers pipeline (or a project-planning chat), one bounded
// session per step, artifacts on disk as ground truth, auto-advance between
// steps, and a transcript buffer so browser reloads can re-hydrate.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const STEPS = ['brainstorm', 'worktree', 'plan', 'execute', 'review', 'finish'];
const PROJECT_PIPELINE = ['plan-project'];

// ---------- default git helpers (injectable for tests) ----------

function defaultListWorktrees(projectDir) {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: projectDir, encoding: 'utf8' });
    const trees = [];
    let cur = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) { cur = { path: line.slice(9).trim(), branch: null }; trees.push(cur); }
      else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    }
    return trees;
  } catch { return []; }
}

function defaultIsBranchMerged(projectDir, branch) {
  try {
    const out = execFileSync('git', ['branch', '--merged'], { cwd: projectDir, encoding: 'utf8' });
    return out.split('\n').some((l) => l.replace('*', '').trim() === branch);
  } catch { return false; }
}

// ---------- step definitions ----------

function specPath(item) {
  return item.spec || `specs/${item.id}.md`;
}

function brainstormPrompt(item) {
  return `You are working on the item "${item.id}" ("${item.name}") from this project's project.yaml.
Use the superpowers:brainstorming skill to refine this idea into an approved design. Ask me questions one at a time; I am answering from a chat UI, so keep each question self-contained.
When the design is approved: save the spec to specs/${item.id}.md, set this item's spec field in project.yaml to specs/${item.id}.md, and commit both.${item.notes ? `\nExisting notes: ${item.notes}` : ''}`;
}

function planProjectPrompt() {
  return `You are planning this project. Its project.yaml (see AGENTS.md for the schema) is the master plan: every screen, feature, API, and integration should become an item.
Use the superpowers:brainstorming skill mindset: interview me about what I want to build, one question at a time — I am answering from a chat UI, so keep each question self-contained.
As decisions land, add or update items in project.yaml immediately (id: kebab-case, name, type: frontend|backend|integration, status: planned, depends, notes). Keep depends accurate — it drives the architecture diagram I am watching live.
Continue until I say we're done; then make sure project.yaml reflects the complete plan and commit it.`;
}

// Each step: prompt, whether it runs in the worktree, and an artifact check
// run at every turn-end. check() returns false, or truthy (optionally an
// object with state fields to merge, e.g. the discovered worktreePath).
const STEP_DEFS = {
  brainstorm: {
    prompt: (item) => brainstormPrompt(item),
    check: ({ projectDir, item, freshSince }) =>
      fresh(path.join(projectDir, 'specs', `${item.id}.md`), freshSince),
    onDone: ({ item, updateItem }) => updateItem(item.id, { spec: `specs/${item.id}.md` }),
  },
  worktree: {
    prompt: (item) => `Use the superpowers:using-git-worktrees skill to create an isolated git worktree on a new branch named exactly "${item.id}" for implementing the spec at ${specPath(item)}.
Do not start implementing. Stop once the worktree and branch exist.`,
    check: ({ item, worktrees }) => {
      const wt = worktrees().find((w) => w.branch === item.id);
      return wt ? { worktreePath: wt.path } : false;
    },
  },
  plan: {
    inWorktree: true,
    prompt: (item) => `You are in the worktree for the item "${item.id}". Use the superpowers:writing-plans skill to write an implementation plan for the spec at ${specPath(item)}.
Save the plan to exactly docs/superpowers/plans/${item.id}.md and commit it. Stop after saving the plan; do not start implementing.`,
    check: ({ cwd, item, freshSince }) =>
      fresh(path.join(cwd, 'docs', 'superpowers', 'plans', `${item.id}.md`), freshSince),
  },
  execute: {
    inWorktree: true,
    prompt: (item) => `Use the superpowers:subagent-driven-development skill to execute the plan at docs/superpowers/plans/${item.id}.md, tracking progress in .superpowers/sdd/progress.md as the skill directs.
When — and only when — every task in the plan is implemented, reviewed, and committed, append a final line containing exactly DONE to .superpowers/sdd/progress.md.`,
    check: ({ cwd, freshSince }) => {
      const p = path.join(cwd, '.superpowers', 'sdd', 'progress.md');
      if (!fresh(p, freshSince)) return false;
      const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
      return lines.at(-1).trim() === 'DONE';
    },
    onStart: ({ item, updateItem }) => {
      if (item.status === 'planned') updateItem(item.id, { status: 'in-progress' });
    },
  },
  review: {
    inWorktree: true,
    prompt: (item) => `Use the superpowers:requesting-code-review skill to review this branch's changes for the item "${item.id}" against its spec (${specPath(item)}) and plan (docs/superpowers/plans/${item.id}.md).
Fix any critical findings. Then write the final review report (including "no findings" if clean) to exactly .superpowers/review-${item.id}.md. Writing that file is the last thing you do.`,
    check: ({ cwd, item, freshSince }) =>
      fresh(path.join(cwd, '.superpowers', `review-${item.id}.md`), freshSince),
  },
  finish: {
    inWorktree: true,
    prompt: (item) => `Use the superpowers:finishing-a-development-branch skill to finish the branch "${item.id}".
Ask me via chat whether to merge, open a PR, keep the branch, or discard it — wait for my answer before acting. Afterwards remove the worktree, and update this item's status in project.yaml per AGENTS.md.`,
    check: ({ item, worktrees }) => !worktrees().some((w) => w.branch === item.id),
    onDone: ({ projectDir, item, updateItem, isMerged }) => {
      // Only a merged branch means shipped — keep/discard/PR must not flip it.
      if (isMerged(projectDir, item.id)) updateItem(item.id, { status: 'shipped' });
    },
  },
  'plan-project': {
    prompt: () => planProjectPrompt(),
    // Open-ended: no turn-end artifact. Completion is judged when the
    // session ends (user pressed Stop): did project.yaml change?
    check: () => false,
    checkOnEnd: ({ projectDir, freshSince }) =>
      fresh(path.join(projectDir, 'project.yaml'), freshSince),
  },
};

function fresh(file, sinceIso) {
  try { return fs.statSync(file).mtimeMs > Date.parse(sinceIso); } catch { return false; }
}

let runCounter = 0;

function createWorkflow({
  projectDir, loadItems, runSession, broadcast, updateItem = () => {},
  listWorktrees = () => defaultListWorktrees(projectDir),
  isBranchMerged = defaultIsBranchMerged,
}) {
  const stateFile = path.join(projectDir, '.superpowers', 'workflow.json');
  const transcript = [];
  let state = null;
  let session = null;
  let seq = 0;

  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    // Its session died with the previous server process.
    if (state && state.stepStatus === 'running') { state.stepStatus = 'interrupted'; persist(); }
  } catch { state = null; }

  function persist() {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }

  function setState(patch) {
    state = { ...state, ...patch };
    persist();
    broadcast({ kind: 'workflow', state });
  }

  function record(ev) {
    ev = { seq: seq++, ...ev };
    transcript.push(ev);
    broadcast(ev);
  }

  function currentItem() {
    return state.itemId ? loadItems().find((i) => i && i.id === state.itemId) : null;
  }

  function stepCwd(stepId) {
    return STEP_DEFS[stepId].inWorktree && state.worktreePath ? state.worktreePath : projectDir;
  }

  function checkCtx() {
    return {
      projectDir,
      cwd: stepCwd(state.step),
      item: currentItem(),
      freshSince: state.stepStartedAt,
      worktrees: listWorktrees,
      updateItem,
      isMerged: isBranchMerged,
    };
  }

  function completeStep(result) {
    const def = STEP_DEFS[state.step];
    if (result && typeof result === 'object') setState(result); // e.g. worktreePath
    if (def.onDone) def.onDone(checkCtx());
    const steps = { ...state.steps, [state.step]: 'done' };
    const idx = state.pipeline.indexOf(state.step);
    const next = state.pipeline[idx + 1];
    session.close();
    if (next) {
      setState({ steps });
      startStep(next);
    } else {
      setState({ steps, stepStatus: 'done' });
    }
  }

  function onEvent(run, stepId, ev) {
    if (run !== runCounter || state.step !== stepId) return; // stale run or stale step
    if (ev.kind === 'session-start') setState({ sessionId: ev.sessionId });
    record(ev);
    if (ev.kind === 'turn-end' && state.stepStatus === 'running') {
      const result = STEP_DEFS[state.step].check(checkCtx());
      if (result) completeStep(result);
    }
  }

  function startStep(stepId) {
    const run = runCounter; // same workflow run
    const def = STEP_DEFS[stepId];
    const item = currentItem();
    setState({ step: stepId, stepStatus: 'running', stepStartedAt: new Date().toISOString(), sessionId: null, error: null });
    if (def.onStart) def.onStart(checkCtx());
    record({ kind: 'step-start', step: stepId });
    session = runSession({
      initialPrompt: def.prompt(item),
      cwd: stepCwd(stepId),
      onEvent: (ev) => onEvent(run, stepId, ev),
    });
    session.done.then(({ ok, error }) => {
      if (run !== runCounter || state.step !== stepId) return;
      if (state.stepStatus !== 'running') return; // completed or stopped already
      // plan-project has no turn artifact; judge it when the session ends.
      if (def.checkOnEnd && def.checkOnEnd(checkCtx())) return completeStep(true);
      setState({ stepStatus: 'needs-attention', error: error || (ok ? 'Session ended before this step\'s artifact appeared' : 'Session failed') });
    });
  }

  function begin({ itemId = null, pipeline, startAt, worktreePath = null }) {
    if (state && state.stepStatus === 'running') return { error: 'A workflow is already running', code: 409 };
    runCounter++;
    transcript.length = 0;
    seq = 0;
    const skipped = {};
    for (const s of pipeline.slice(0, pipeline.indexOf(startAt))) skipped[s] = 'skipped';
    state = {
      itemId, pipeline, steps: skipped,
      step: startAt, stepStatus: 'running',
      sessionId: null, startedAt: new Date().toISOString(), stepStartedAt: null,
      worktreePath, error: null,
    };
    startStep(startAt);
    return { state };
  }

  function start(itemId, startAt = 'brainstorm') {
    const item = loadItems().find((i) => i && i.id === itemId);
    if (!item) return { error: `Unknown item "${itemId}"`, code: 400 };
    if (item.status === 'shipped') return { error: `"${itemId}" is already shipped`, code: 400 };
    if (!STEPS.includes(startAt)) return { error: `Unknown step "${startAt}"`, code: 400 };
    if (startAt !== 'brainstorm' && !item.spec) {
      return { error: `"${itemId}" has no spec yet — start from brainstorm`, code: 400 };
    }
    // Steps after worktree run inside it — re-discover it for restarts.
    let worktreePath = null;
    if (STEPS.indexOf(startAt) > STEPS.indexOf('worktree')) {
      const wt = listWorktrees().find((w) => w.branch === itemId);
      if (!wt) return { error: `No worktree for "${itemId}" — start from the worktree step`, code: 400 };
      worktreePath = wt.path;
    }
    return begin({ itemId, pipeline: STEPS, startAt, worktreePath });
  }

  function planProject() {
    return begin({ pipeline: PROJECT_PIPELINE, startAt: 'plan-project' });
  }

  function stop() {
    if (!state || state.stepStatus !== 'running' || !session) return false;
    const def = STEP_DEFS[state.step];
    if (def.checkOnEnd && def.checkOnEnd(checkCtx())) {
      completeStep(true);
    } else {
      setState({ stepStatus: 'stopped' });
      session.close();
    }
    return true;
  }

  function input(text) {
    if (!session || !state || state.stepStatus !== 'running') return false;
    if (!session.send(text)) return false;
    record({ kind: 'user-text', text });
    return true;
  }

  return { start, planProject, stop, input, getState: () => state, getTranscript: () => transcript };
}

module.exports = { createWorkflow, brainstormPrompt, planProjectPrompt, STEPS };
