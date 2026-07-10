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

const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const mergeTranscript = (a, b) => {
  const bySeq = new Map([...a, ...b].map((ev) => [ev.seq, ev]));
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
};

const STEP_INFO = {
  brainstorm: { label: 'Brainstorm', desc: 'Chat to refine the idea into an approved spec (specs/<id>.md)' },
  worktree: { label: 'Worktree', desc: 'Create an isolated branch + worktree' },
  plan: { label: 'Plan', desc: 'Write the step-by-step implementation plan' },
  execute: { label: 'Execute', desc: 'Subagents implement each task with TDD' },
  review: { label: 'Review', desc: 'Code review of the finished branch' },
  finish: { label: 'Finish', desc: 'Merge / PR / keep / discard — you choose in chat' },
  'plan-project': { label: 'Plan project', desc: 'Chat to plan the whole app; items land in project.yaml live' },
};
const ITEM_PIPELINE = ['brainstorm', 'worktree', 'plan', 'execute', 'review', 'finish'];

function Stepper({ state }) {
  const pipeline = state?.pipeline || ITEM_PIPELINE;
  const currentIdx = state ? pipeline.indexOf(state.step) : -1;
  return (
    <div className="wf-stepper">
      {pipeline.map((id, i) => {
        const done = state?.steps?.[id] === 'done';
        const skipped = state?.steps?.[id] === 'skipped';
        const phase = done ? 'done'
          : skipped ? 'skipped'
          : i === currentIdx ? state.stepStatus
          : 'upcoming';
        return (
          <div key={id} className="wf-step-wrap">
            {i > 0 && <span className="wf-arrow">→</span>}
            <div className={`wf-step wf-step-${phase}`} title={STEP_INFO[id].desc}>
              <span className="wf-step-num">{done || (i === currentIdx && state.stepStatus === 'done') ? '✓' : i + 1}</span>
              <span className="wf-step-label">{STEP_INFO[id].label}</span>
              {skipped && <span className="wf-step-skip-tag">skipped</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Item picker + optional starting-step choice (items with a spec can skip
// straight to implementation) + the plan-project entry point.
function StartControls({ items, prompt }) {
  const [pickedId, setPickedId] = useState('');
  const [startAt, setStartAt] = useState('brainstorm');
  const picked = items.find((i) => i.id === pickedId);
  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      {prompt && <Text type="body">{prompt}</Text>}
      <Selector
        label="Item"
        isLabelHidden
        placeholder="Choose an item..."
        size="sm"
        value={pickedId}
        onChange={(v) => { setPickedId(v); setStartAt('brainstorm'); }}
        options={items.map((i) => ({
          value: i.id,
          label: `${i.name} (${i.status}${i.spec ? ', has spec' : ', needs spec'})`,
        }))}
      />
      {picked?.spec && (
        <Selector
          label="Start at"
          isLabelHidden
          size="sm"
          value={startAt}
          onChange={setStartAt}
          options={[
            { value: 'brainstorm', label: 'Start at: Brainstorm (revise the spec)' },
            { value: 'worktree', label: 'Start at: Worktree (spec is ready, implement it)' },
          ]}
        />
      )}
      <Button
        label="Start workflow"
        variant="primary"
        size="sm"
        isDisabled={!pickedId}
        onClick={() => post('/api/workflow/start', { itemId: pickedId, step: startAt })}
      />
      <Text type="supporting" size="xsm">or</Text>
      <Button
        label="Plan project"
        size="sm"
        tooltip="Chat with Claude to plan the whole app — items land in project.yaml as you talk"
        onClick={() => post('/api/workflow/plan-project')}
      />
    </HStack>
  );
}

const STATUS_HINTS = {
  done: 'Pipeline complete.',
  stopped: 'Stopped. Start again whenever you like.',
  'needs-attention': 'The session ended without producing the expected artifact. Retry, or start again.',
  interrupted: 'The server restarted while this step was running. Retry to pick it back up.',
};
const RUNNING_HINTS = {
  brainstorm: 'Claude is refining the spec — answer its questions below.',
  worktree: 'Creating an isolated worktree + branch…',
  plan: 'Writing the implementation plan…',
  execute: 'Subagents are implementing the plan with TDD. You can watch, or interject below.',
  review: 'Reviewing the branch…',
  finish: 'Claude will ask you: merge, PR, keep, or discard. Answer below.',
  'plan-project': 'Describe what you want to build — items appear in the diagram as you talk. Press Stop when the plan feels complete.',
};
const STATUS_BADGE = { running: 'info', done: 'success', stopped: 'neutral', 'needs-attention': 'warning', interrupted: 'warning' };

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
  if (ev.kind === 'step-start') {
    return <ChatSystemMessage variant="divider">{STEP_INFO[ev.step]?.label || ev.step}</ChatSystemMessage>;
  }
  if (ev.kind === 'session-start') {
    return <ChatSystemMessage>session started ({ev.model})</ChatSystemMessage>;
  }
  return null;
}

export default function WorkflowView({ items }) {
  const [wf, setWf] = useState(null); // { state, transcript }
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
  const item = state?.itemId ? items.find((i) => i.id === state.itemId) : null;
  const startable = items.filter((i) => i.status !== 'shipped');
  const canRetry = ['interrupted', 'needs-attention'].includes(state?.stepStatus)
    && (!state.itemId || (item && item.status !== 'shipped'));
  // A shipped item makes retry hints misleading — the work is already done.
  const hint = item?.status === 'shipped' && !running && state?.stepStatus !== 'done'
    ? 'This item has since shipped, so there is nothing left to retry.'
    : running ? RUNNING_HINTS[state.step] : STATUS_HINTS[state?.stepStatus];

  const send = (value) => {
    const t = value.trim();
    if (!t || !running) return;
    post('/api/workflow/input', { text: t });
  };

  const retry = () => {
    if (state.itemId) {
      // Resume at the step that broke; earlier steps' artifacts are on disk.
      post('/api/workflow/start', { itemId: state.itemId, step: state.step });
    } else {
      post('/api/workflow/plan-project');
    }
  };

  return (
    <div className="workflow">
      {!state && (
        <>
          <Stepper state={null} />
          <div className="wf-transcript">
            <EmptyState
              title="No workflow yet"
              description="Pick an item to take through the pipeline above, or plan the whole project first — Claude interviews you and fills project.yaml with every screen, feature, and integration."
              actions={<StartControls items={startable} />}
            />
          </div>
        </>
      )}

      {state && (
        <>
          <Stepper state={state} />
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Text weight="bold">{item ? item.name : state.itemId || 'Project planning'}</Text>
            <Badge variant={STATUS_BADGE[state.stepStatus] || 'neutral'} label={`${STEP_INFO[state.step]?.label || state.step}: ${state.stepStatus}`} />
            <Text type="supporting" size="xsm">{hint}</Text>
            {running && <Button label="Stop" variant="ghost" size="sm" onClick={() => post('/api/workflow/stop')} />}
            {canRetry && <Button label={`Retry ${STEP_INFO[state.step]?.label || state.step}`} variant="primary" size="sm" onClick={retry} />}
            {state.error && <Text type="supporting" size="xsm">{state.error}</Text>}
          </HStack>
          {!running && <StartControls items={startable} prompt="Start something else:" />}
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
                    {state.itemId
                      ? `pipeline complete for ${state.itemId} — project.yaml has been updated`
                      : 'project planning saved to project.yaml — check the Diagram and Priority tabs'}
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
