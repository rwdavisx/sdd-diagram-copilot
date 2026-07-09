// workflow.js — the single active workflow: which item, which step, its
// session, and a transcript buffer so browser reloads can re-hydrate.
// Phase 1 implements only the brainstorm step; later steps extend `step`.
const fs = require('fs');
const path = require('path');

function brainstormPrompt(item) {
  return `You are working on the item "${item.id}" ("${item.name}") from this project's project.yaml.
Use the superpowers:brainstorming skill to refine this idea into an approved design. Ask me questions one at a time; I am answering from a chat UI, so keep each question self-contained.
When the design is approved: save the spec to specs/${item.id}.md, set this item's spec field in project.yaml to specs/${item.id}.md, and commit both.${item.notes ? `\nExisting notes: ${item.notes}` : ''}`;
}

function createWorkflow({ projectDir, loadItems, runSession, broadcast }) {
  const stateFile = path.join(projectDir, '.superpowers', 'workflow.json');
  const transcript = [];
  let state = null;
  let session = null;

  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    // Its session died with the previous server process.
    if (state && state.stepStatus === 'running') state.stepStatus = 'interrupted';
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
    transcript.push(ev);
    broadcast(ev);
  }

  function onEvent(ev) {
    if (ev.kind === 'session-start') { state = { ...state, sessionId: ev.sessionId }; persist(); }
    record(ev);
    // Artifact-based completion: the brainstorm step is done when the skill
    // has saved the spec file, regardless of what the transcript says.
    if (ev.kind === 'turn-end' && fs.existsSync(path.join(projectDir, 'specs', `${state.itemId}.md`))) {
      setStatus('done');
      session.close();
    }
  }

  function start(itemId) {
    if (state && state.stepStatus === 'running') return { error: 'A workflow is already running', code: 409 };
    const item = loadItems().find((i) => i && i.id === itemId);
    if (!item) return { error: `Unknown item "${itemId}"`, code: 400 };
    if (item.status === 'shipped') return { error: `"${itemId}" is already shipped`, code: 400 };

    transcript.length = 0;
    state = { itemId, step: 'brainstorm', stepStatus: 'running', sessionId: null, startedAt: new Date().toISOString() };
    persist();
    broadcast({ kind: 'workflow', state });

    session = runSession({ initialPrompt: brainstormPrompt(item), cwd: projectDir, onEvent });
    session.done.then(({ ok, error }) => {
      if (state.stepStatus === 'running') {
        setStatus('needs-attention', { error: error || (ok ? 'Session ended before the spec was saved' : 'Session failed') });
      }
    });
    return { state };
  }

  function input(text) {
    if (!session || !state || state.stepStatus !== 'running') return false;
    record({ kind: 'user-text', text });
    session.send(text);
    return true;
  }

  return { start, input, getState: () => state, getTranscript: () => transcript };
}

module.exports = { createWorkflow, brainstormPrompt };
