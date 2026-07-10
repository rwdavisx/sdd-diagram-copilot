import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';

const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const mergeTranscript = (a, b) => {
  const bySeq = new Map([...a, ...b].map((ev) => [ev.seq, ev]));
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
};

// The superpowers pipeline. Only brainstorm is automated so far; the rest are
// shown so it's clear where the current step sits in the overall process.
const STEPS = [
  { id: 'brainstorm', label: 'Brainstorm', desc: 'Refine the idea into an approved spec (specs/<id>.md)' },
  { id: 'worktree', label: 'Worktree', desc: 'Create an isolated branch + worktree' },
  { id: 'plan', label: 'Plan', desc: 'Write the step-by-step implementation plan' },
  { id: 'execute', label: 'Execute', desc: 'Subagents implement each task with TDD' },
  { id: 'review', label: 'Review', desc: 'Code review of the finished branch' },
  { id: 'finish', label: 'Finish', desc: 'Merge or PR; item marked shipped' },
];
const AUTOMATED_STEPS = 1; // steps beyond this index aren't wired up yet

function Stepper({ state }) {
  const currentIdx = state ? STEPS.findIndex((s) => s.id === state.step) : -1;
  return (
    <div className="wf-stepper">
      {STEPS.map((s, i) => {
        const phase = i < currentIdx ? 'done'
          : i === currentIdx ? state.stepStatus
          : 'upcoming';
        return (
          <div key={s.id} className="wf-step-wrap">
            {i > 0 && <span className="wf-arrow">→</span>}
            <div className={`wf-step wf-step-${phase}`} title={s.desc}>
              <span className="wf-step-num">{i < currentIdx || (i === currentIdx && state.stepStatus === 'done') ? '✓' : i + 1}</span>
              <span className="wf-step-label">{s.label}</span>
              {i >= AUTOMATED_STEPS && <span className="wf-step-manual" title="Not automated yet — run this step from the terminal">manual</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StartPicker({ items, pickedId, setPickedId, prompt }) {
  return (
    <div className="wf-empty">
      <p>{prompt}</p>
      <select value={pickedId} onChange={(e) => setPickedId(e.target.value)}>
        <option value="">— choose an item —</option>
        {items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name} ({i.status}{i.spec ? ', has spec' : ', needs spec'})
          </option>
        ))}
      </select>
      <button disabled={!pickedId} onClick={() => post('/api/workflow/start', { itemId: pickedId })}>
        Start workflow
      </button>
    </div>
  );
}

const STATUS_HINTS = {
  running: 'Claude is working — answer its questions below.',
  done: 'Step complete.',
  'needs-attention': 'The session ended without producing the expected artifact. Start again to retry.',
  interrupted: 'The server restarted while this step was running. Start the workflow again to retry.',
};

export default function WorkflowView({ items }) {
  const [wf, setWf] = useState(null); // { state, transcript }
  const [text, setText] = useState('');
  const [pickedId, setPickedId] = useState('');
  const endRef = useRef(null);

  useEffect(() => {
    let stale = false;
    fetch('/api/workflow')
      .then((r) => r.json())
      .then((d) => {
        if (stale) return;
        setWf((cur) => cur
          ? { state: cur.state ?? d.state, transcript: mergeTranscript(d.transcript, cur.transcript) }
          : d);
      })
      .catch(() => { if (!stale) setWf({ state: null, transcript: [] }); });
    const es = new EventSource('/api/events');
    es.addEventListener('workflow', (e) => {
      const ev = JSON.parse(e.data);
      setWf((cur) => {
        const base = cur || { state: null, transcript: [] };
        if (ev.kind === 'workflow') {
          const isNewRun = ev.state.stepStatus === 'running' && base.state?.startedAt !== ev.state.startedAt;
          return { state: ev.state, transcript: isNewRun ? [] : base.transcript };
        }
        return { ...base, transcript: mergeTranscript(base.transcript, [ev]) };
      });
    });
    return () => { stale = true; es.close(); };
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [wf?.transcript.length]);

  if (!wf) return <div className="loading">Loading…</div>;
  const { state, transcript } = wf;
  const running = state?.stepStatus === 'running';
  const item = state && items.find((i) => i.id === state.itemId);
  const startable = items.filter((i) => i.status !== 'shipped');

  const send = () => {
    const t = text.trim();
    if (!t || !running) return;
    post('/api/workflow/input', { text: t });
    setText('');
  };

  return (
    <div className="workflow">
      {!state && (
        <div className="wf-intro">
          <Stepper state={null} />
          <StartPicker
            items={startable}
            pickedId={pickedId}
            setPickedId={setPickedId}
            prompt="A workflow takes one item through the pipeline above, starting with a brainstorm chat that produces its spec. Pick an item:"
          />
        </div>
      )}

      {state && (
        <>
          <Stepper state={state} />
          <div className="wf-header">
            <strong>{item ? item.name : state.itemId}</strong>
            <span className={`badge wf-${state.stepStatus}`}>{state.step}: {state.stepStatus}</span>
            <span className="wf-hint">{STATUS_HINTS[state.stepStatus]}</span>
            {state.error && <span className="wf-error">{state.error}</span>}
          </div>
          <div className="wf-transcript">
            {transcript.map((ev) => {
              if (ev.kind === 'assistant-text') return <div key={ev.seq} className="msg assistant"><Markdown>{ev.text}</Markdown></div>;
              if (ev.kind === 'user-text') return <div key={ev.seq} className="msg user">{ev.text}</div>;
              if (ev.kind === 'tool-use') return <div key={ev.seq} className="msg tool"><code>{ev.name}</code> {ev.summary}</div>;
              if (ev.kind === 'session-start') return <div key={ev.seq} className="msg meta">session started ({ev.model})</div>;
              return null;
            })}
            {state.stepStatus === 'done' && (
              <div className="msg meta">
                brainstorm complete — spec saved to specs/{state.itemId}.md and recorded in project.yaml.
                Next steps (worktree → plan → execute → review → finish) aren't automated yet; run them from the terminal.
              </div>
            )}
            <div ref={endRef} />
          </div>
          {running ? (
            <div className="wf-input">
              <textarea
                rows={2}
                value={text}
                placeholder="Answer Claude…"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              />
              <button disabled={!text.trim()} onClick={send}>Send</button>
            </div>
          ) : (
            <StartPicker items={startable} pickedId={pickedId} setPickedId={setPickedId} prompt="Start another workflow:" />
          )}
        </>
      )}
    </div>
  );
}
