// workflow.js — the single active workflow: an item moving through the
// six-step superpowers pipeline (or a project-planning chat), one bounded
// session per step, artifacts on disk as ground truth, auto-advance between
// steps, and a transcript buffer so browser reloads can re-hydrate.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const STEPS = ['brainstorm', 'worktree', 'plan', 'execute', 'review', 'finish'];
const PROJECT_PIPELINE = ['plan-project'];
const ANALYZE_PIPELINE = ['analyze-project'];

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
As the design takes shape, record it in project.yaml immediately, not at the end (see AGENTS.md for the schema): every component, sub-feature, API, or integration we identify becomes its own item (id: kebab-case, name, type, status: planned, depends: what it uses, notes), with contracts: and flows: declared as interfaces are decided, and wireframes for new screens. I am watching the architecture diagram live while we talk — it renders from project.yaml.
When the design is approved: save the spec to specs/${item.id}.md, set this item's spec field in project.yaml to specs/${item.id}.md, and commit both.${item.notes ? `\nExisting notes: ${item.notes}` : ''}`;
}

function planProjectPrompt() {
  return `You are planning this project. Its project.yaml (see AGENTS.md for the schema) is the master plan: every screen, feature, API, and integration should become an item.
Use the superpowers:brainstorming skill mindset: interview me about what I want to build, one question at a time — I am answering from a chat UI, so keep each question self-contained.
As decisions land, add or update items in project.yaml immediately (id: kebab-case, name, type: frontend|backend|integration, status: planned, depends, notes). Keep depends accurate — it drives the architecture diagram I am watching live.

Wireframes: for every frontend item, also create/update a wireframe at design/wireframes/<item-id>.html as soon as the screen's purpose is clear, and keep it in sync as decisions change. Rules:
- One self-contained file: inline CSS only, no <script>, no external assets, body designed at 800px wide.
- Every interactive element that leads somewhere gets a unique id and data-flow-to="<item-id>" plus data-flow-kind: "nav" (navigates to another screen), "api" (triggers a backend item), or "data" (displays data from a backend/integration item). Example: <button id="checkout-btn" data-flow-to="checkout" data-flow-kind="nav">Check out</button>
- These attributes draw the element-anchored connectors on the live diagram, so add them as you go, not at the end.
My messages may start with a [Context: iterating on screen "<id>" — wireframe at <path>] prefix; that means apply the message to that wireframe file directly.

Continue until I say we're done; then make sure project.yaml and the wireframes reflect the complete plan and commit them.`;
}

function analyzeProjectPrompt() {
  return `You are reverse-engineering this existing codebase into project.yaml (see AGENTS.md for the schema). The code exists but the blueprint doesn't: deconstruct what is actually built into items so project.yaml describes the real system.

First survey the repo yourself: tech stack, entry points, top-level layout. Then use the superpowers:dispatching-parallel-agents skill to dispatch parallel Explore subagents, one per major area (frontend screens, backend routes/services, data layer, external integrations, tests). Each subagent returns condensed findings — features found, interfaces owned, dependencies between parts, key file paths — never raw file dumps.

Synthesize the findings into project.yaml INCREMENTALLY — update it as each area lands, not all at the end; I am watching the architecture diagram render live from it. Every user-facing screen, API/service, and external integration becomes an item:
- id: kebab-case, stable; name: human-readable; type: frontend|backend|integration
- status: shipped for code that exists and works; in-progress only if visibly half-built
- notes: one line naming the key source paths so future work can find the code
- depends: what it actually calls/uses — keep this accurate, it draws the diagram edges
- contracts: each interface the item owns (API endpoints, DB tables, events) with name, kind, schema
- flows: data movement the item initiates, with short labels
- tests: existing test files mapped to their owning item (name, file, status: unknown — do not run the suite)

Do not write specs or wireframes — those happen when an item is next worked on. Do not modify any source code.

When project.yaml reflects the whole codebase: commit it, then write a short summary report (areas covered, item count, anything you could not classify) to .superpowers/analyze-report.md. Writing that report file is the LAST thing you do.`;
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
As tests are written and run, record each one in project.yaml under this item's \`tests:\` (name, file, status: passing|failing) per AGENTS.md, and keep the statuses current on every run.
When — and only when — every task in the plan is implemented, reviewed, and committed, append a final line containing exactly DONE to .superpowers/sdd/progress.md.`,
    check: ({ cwd, freshSince }) => {
      const p = path.join(cwd, '.superpowers', 'sdd', 'progress.md');
      if (!fresh(p, freshSince)) return false;
      const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
      return lines.at(-1).trim() === 'DONE';
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
  'analyze-project': {
    prompt: () => analyzeProjectPrompt(),
    // Autonomous: done when the final report lands. Stopping early after
    // items were written still counts as a (partial) import.
    check: ({ projectDir, freshSince }) =>
      fresh(path.join(projectDir, '.superpowers', 'analyze-report.md'), freshSince),
    checkOnEnd: ({ projectDir, freshSince }) =>
      fresh(path.join(projectDir, 'project.yaml'), freshSince),
  },
};

function fresh(file, sinceIso) {
  try { return fs.statSync(file).mtimeMs > Date.parse(sinceIso); } catch { return false; }
}

// Which model/effort a step's session runs with, from project.yaml:
//   workflow:
//     defaults: { model: sonnet, effort: medium }
//     steps:
//       execute: { model: claude-fable-5, effort: high }
// plus an optional per-item `workflow: { model, effort }` on the item itself,
// which wins over the step config. Unset fields inherit the CLI default.
function resolveStepConfig(wfConfig, stepId, item) {
  const cfg = {
    ...(wfConfig && wfConfig.defaults),
    ...(wfConfig && wfConfig.steps && wfConfig.steps[stepId]),
    ...(item && item.workflow),
  };
  return { model: cfg.model, effort: cfg.effort };
}

let runCounter = 0;

function createWorkflow({
  projectDir, loadItems, runSession, broadcast, updateItem = () => {},
  loadWorkflowConfig = () => null,
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
    ev = { seq: seq++, at: new Date().toISOString(), ...ev };
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
    // Gate between steps: never auto-advance. The human reviews the step's
    // output and presses Continue (advance()) to start the next one.
    setState({ steps, stepStatus: next ? 'gated' : 'done' });
  }

  function advance() {
    if (!state || state.stepStatus !== 'gated') return { error: 'No step is waiting at a gate', code: 409 };
    const next = state.pipeline[state.pipeline.indexOf(state.step) + 1];
    if (!next) { setState({ stepStatus: 'done' }); return { state }; }
    startStep(next);
    return { state };
  }

  function onEvent(run, stepId, ev) {
    if (run !== runCounter || state.step !== stepId) return; // stale run or stale step
    // Deltas are broadcast-only: the final assistant-text supersedes them, so
    // storing them would bloat the reload-rehydration buffer for nothing.
    if (ev.kind === 'assistant-delta') return broadcast(ev);
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
    // Any pipeline step on an item means work is underway — flip the status
    // here so it holds no matter which step a run starts, resumes, or retries
    // at. Shipped items flip too: iterating on a finished feature puts it
    // back in progress until the new branch merges.
    if (item && item.status !== 'in-progress') updateItem(item.id, { status: 'in-progress' });
    setState({ step: stepId, stepStatus: 'running', stepStartedAt: new Date().toISOString(), sessionId: null, error: null });
    if (def.onStart) def.onStart(checkCtx());
    record({ kind: 'step-start', step: stepId });
    const { model, effort } = resolveStepConfig(loadWorkflowConfig(), stepId, item);
    session = runSession({
      initialPrompt: def.prompt(item),
      cwd: stepCwd(stepId),
      model,
      effort,
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

  function analyzeProject() {
    return begin({ pipeline: ANALYZE_PIPELINE, startAt: 'analyze-project' });
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

  return { start, planProject, analyzeProject, advance, stop, input, getState: () => state, getTranscript: () => transcript };
}

module.exports = { createWorkflow, brainstormPrompt, planProjectPrompt, analyzeProjectPrompt, resolveStepConfig, STEPS };
