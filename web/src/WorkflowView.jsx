import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';

const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export default function WorkflowView({ items }) {
  const [wf, setWf] = useState(null); // { state, transcript }
  const [text, setText] = useState('');
  const [pickedId, setPickedId] = useState('');
  const endRef = useRef(null);

  useEffect(() => {
    let stale = false;
    fetch('/api/workflow')
      .then((r) => r.json())
      .then((d) => { if (!stale) setWf(d); })
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
        return { ...base, transcript: [...base.transcript, ev] };
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
        <div className="wf-empty">
          <p>No workflow yet. Pick an item to brainstorm:</p>
          <select value={pickedId} onChange={(e) => setPickedId(e.target.value)}>
            <option value="">— choose an item —</option>
            {startable.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <button disabled={!pickedId} onClick={() => post('/api/workflow/start', { itemId: pickedId })}>
            Start workflow
          </button>
        </div>
      )}

      {state && (
        <>
          <div className="wf-header">
            <strong>{item ? item.name : state.itemId}</strong>
            <span className="badge">{state.step}</span>
            <span className={`badge wf-${state.stepStatus}`}>{state.stepStatus}</span>
            {state.error && <span className="wf-error">{state.error}</span>}
          </div>
          <div className="wf-transcript">
            {transcript.map((ev, i) => {
              if (ev.kind === 'assistant-text') return <div key={i} className="msg assistant"><Markdown>{ev.text}</Markdown></div>;
              if (ev.kind === 'user-text') return <div key={i} className="msg user">{ev.text}</div>;
              if (ev.kind === 'tool-use') return <div key={i} className="msg tool"><code>{ev.name}</code> {ev.summary}</div>;
              if (ev.kind === 'session-start') return <div key={i} className="msg meta">session started ({ev.model})</div>;
              return null;
            })}
            {state.stepStatus === 'done' && <div className="msg meta">brainstorm complete — spec saved to specs/{state.itemId}.md</div>}
            <div ref={endRef} />
          </div>
          <div className="wf-input">
            <textarea
              rows={2}
              value={text}
              placeholder={running ? 'Answer Claude…' : 'Session is not running'}
              disabled={!running}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            />
            <button disabled={!running || !text.trim()} onClick={send}>Send</button>
          </div>
        </>
      )}
    </div>
  );
}
