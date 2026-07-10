// workflow.js — the single active workflow: which item, which step, its
// session, and a transcript buffer so browser reloads can re-hydrate.
// Phase 1 implements only the brainstorm step; later steps extend `step`.
const fs = require('fs');
const path = require('path');

// The full superpowers pipeline, in order. Only `brainstorm` is automated so
// far; the list is served with workflow state so the UI can show where the
// current step sits in the overall process.
const STEPS = ['brainstorm', 'worktree', 'plan', 'execute', 'review', 'finish'];

function brainstormPrompt(item) {
  return `You are working on the item "${item.id}" ("${item.name}") from this project's project.yaml.
Use the superpowers:brainstorming skill to refine this idea into an approved design. Ask me questions one at a time; I am answering from a chat UI, so keep each question self-contained.
When the design is approved: save the spec to specs/${item.id}.md, set this item's spec field in project.yaml to specs/${item.id}.md, and commit both.${item.notes ? `\nExisting notes: ${item.notes}` : ''}`;
}

let runCounter = 0;

function createWorkflow({ projectDir, loadItems, runSession, broadcast, updateItem = () => {} }) {
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

  function setStatus(stepStatus, extra = {}) {
    state = { ...state, stepStatus, ...extra };
    persist();
    broadcast({ kind: 'workflow', state });
  }

  function record(ev) {
    ev = { seq: seq++, ...ev };
    transcript.push(ev);
    broadcast(ev);
  }

  // Artifact-based completion, but only for artifacts produced by THIS run:
  // a spec file left over from earlier work must not instantly mark a fresh
  // run as done. "Fresh" = created after the run started, or modified since.
  function specSavedThisRun() {
    const specPath = path.join(projectDir, 'specs', `${state.itemId}.md`);
    try {
      const { mtimeMs } = fs.statSync(specPath);
      return !state.specExistedAtStart || mtimeMs > Date.parse(state.startedAt);
    } catch { return false; }
  }

  function onEvent(run, ev) {
    if (run !== runCounter) return; // stale run; a newer run is active
    if (ev.kind === 'session-start') { state = { ...state, sessionId: ev.sessionId }; persist(); }
    record(ev);
    if (ev.kind === 'turn-end' && specSavedThisRun()) {
      // The server, not the session, keeps project.yaml truthful: record the
      // spec path programmatically so it can't be forgotten.
      updateItem(state.itemId, { spec: `specs/${state.itemId}.md` });
      setStatus('done');
      session.close();
    }
  }

  function start(itemId) {
    if (state && state.stepStatus === 'running') return { error: 'A workflow is already running', code: 409 };
    const item = loadItems().find((i) => i && i.id === itemId);
    if (!item) return { error: `Unknown item "${itemId}"`, code: 400 };
    if (item.status === 'shipped') return { error: `"${itemId}" is already shipped`, code: 400 };

    const run = ++runCounter;
    transcript.length = 0;
    seq = 0;
    state = {
      itemId,
      step: 'brainstorm',
      stepStatus: 'running',
      sessionId: null,
      startedAt: new Date().toISOString(),
      specExistedAtStart: fs.existsSync(path.join(projectDir, 'specs', `${itemId}.md`)),
    };
    persist();
    broadcast({ kind: 'workflow', state });

    session = runSession({ initialPrompt: brainstormPrompt(item), cwd: projectDir, onEvent: (ev) => onEvent(run, ev) });
    session.done.then(({ ok, error }) => {
      if (run !== runCounter) return; // stale run; a newer run is active
      if (state.stepStatus === 'running') {
        setStatus('needs-attention', { error: error || (ok ? 'Session ended before the spec was saved' : 'Session failed') });
      }
    });
    return { state };
  }

  function input(text) {
    if (!session || !state || state.stepStatus !== 'running') return false;
    if (!session.send(text)) return false;
    record({ kind: 'user-text', text });
    return true;
  }

  return { start, input, getState: () => state, getTranscript: () => transcript };
}

module.exports = { createWorkflow, brainstormPrompt, STEPS };
