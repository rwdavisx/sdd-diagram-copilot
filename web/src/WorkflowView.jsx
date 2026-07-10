import { useEffect, useRef, useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import {
  ChatComposer,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatSystemMessage,
} from '@astryxdesign/core/Chat';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Markdown } from '@astryxdesign/core/Markdown';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

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
    <VStack gap={1}>
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
              </div>
            </div>
          );
        })}
      </div>
      <Text type="supporting" size="xsm">
        Only {STEPS.slice(0, AUTOMATED_STEPS).map((s) => s.label).join(', ')} is automated so far — later steps run from the terminal. Hover a step for details.
      </Text>
    </VStack>
  );
}

function StartPicker({ items, pickedId, setPickedId, prompt }) {
  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      {prompt && <Text type="body">{prompt}</Text>}
      <Selector
        label="Item"
        isLabelHidden
        placeholder="Choose an item..."
        size="sm"
        value={pickedId}
        onChange={setPickedId}
        options={items.map((i) => ({
          value: i.id,
          label: `${i.name} (${i.status}${i.spec ? ', has spec' : ', needs spec'})`,
        }))}
      />
      <Button
        label="Start workflow"
        variant="primary"
        size="sm"
        isDisabled={!pickedId}
        onClick={() => post('/api/workflow/start', { itemId: pickedId })}
      />
    </HStack>
  );
}

const STATUS_HINTS = {
  running: 'Claude is working — answer its questions below.',
  done: 'Step complete.',
  'needs-attention': 'The session ended without producing the expected artifact. Start again to retry.',
  interrupted: 'The server restarted while this step was running. Start the workflow again to retry.',
};
const STATUS_BADGE = { running: 'info', done: 'success', 'needs-attention': 'warning', interrupted: 'warning' };

function TranscriptEvent({ ev }) {
  if (ev.kind === 'assistant-text') {
    return (
      <ChatMessage sender="assistant">
        <ChatMessageBubble variant="ghost">
          <Markdown density="compact" headingLevelStart={3}>{ev.text}</Markdown>
        </ChatMessageBubble>
      </ChatMessage>
    );
  }
  if (ev.kind === 'user-text') {
    return (
      <ChatMessage sender="user">
        <ChatMessageBubble>{ev.text}</ChatMessageBubble>
      </ChatMessage>
    );
  }
  if (ev.kind === 'tool-use') {
    return <ChatSystemMessage>{ev.name}{ev.summary ? ` · ${ev.summary}` : ''}</ChatSystemMessage>;
  }
  if (ev.kind === 'session-start') {
    return <ChatSystemMessage variant="divider">session started ({ev.model})</ChatSystemMessage>;
  }
  return null;
}

export default function WorkflowView({ items }) {
  const [wf, setWf] = useState(null); // { state, transcript }
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
  const canRetry = ['interrupted', 'needs-attention'].includes(state?.stepStatus)
    && item && item.status !== 'shipped';
  // A shipped item makes retry hints misleading — the work is already done.
  const hint = item?.status === 'shipped' && state?.stepStatus !== 'running'
    ? 'This item has since shipped, so there is nothing left to retry.'
    : STATUS_HINTS[state?.stepStatus];

  const send = (value) => {
    const t = value.trim();
    if (!t || !running) return;
    post('/api/workflow/input', { text: t });
  };

  return (
    <div className="workflow">
      {!state && (
        <>
          <Stepper state={null} />
          <div className="wf-transcript">
            <EmptyState
              title="No workflow yet"
              description="A workflow takes one item through the pipeline above, starting with a brainstorm chat that produces its spec."
              actions={<StartPicker items={startable} pickedId={pickedId} setPickedId={setPickedId} />}
            />
          </div>
        </>
      )}

      {state && (
        <>
          <Stepper state={state} />
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Text weight="bold">{item ? item.name : state.itemId}</Text>
            <Badge variant={STATUS_BADGE[state.stepStatus] || 'neutral'} label={`${state.step}: ${state.stepStatus}`} />
            <Text type="supporting" size="xsm">{hint}</Text>
            {canRetry && (
              <Button
                label={`Retry ${state.step}`}
                variant="primary"
                size="sm"
                onClick={() => post('/api/workflow/start', { itemId: state.itemId })}
              />
            )}
            {state.error && <Text type="supporting" size="xsm">{state.error}</Text>}
          </HStack>
          {!running && (
            <StartPicker items={startable} pickedId={pickedId} setPickedId={setPickedId} prompt="Or start a different workflow:" />
          )}
          <div className="wf-transcript">
            {transcript.length === 0 && state.stepStatus !== 'done' ? (
              <EmptyState
                title="No conversation to show"
                description={`${hint} The transcript lives with the session, so it doesn't survive a server restart.`}
              />
            ) : (
              <ChatMessageList density="compact">
                {transcript.map((ev) => <TranscriptEvent key={ev.seq} ev={ev} />)}
                {state.stepStatus === 'done' && (
                  <ChatSystemMessage>
                    brainstorm complete — spec saved to specs/{state.itemId}.md and recorded in project.yaml.
                    Next steps (worktree → plan → execute → review → finish) aren't automated yet; run them from the terminal.
                  </ChatSystemMessage>
                )}
              </ChatMessageList>
            )}
            <div ref={endRef} />
          </div>
          {running && <ChatComposer onSubmit={send} placeholder="Answer Claude…" density="compact" />}
        </>
      )}
    </div>
  );
}
