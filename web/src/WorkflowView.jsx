import { useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { ChatComposer, ChatLayout, ChatMessageList, ChatSystemMessage } from '@astryxdesign/core/Chat';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { post, useWorkflowFeed, TranscriptEvent, STEP_INFO } from './useWorkflowFeed.jsx';

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
// straight to implementation). Project planning lives in the Planning tab.
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

export default function WorkflowView({ items }) {
  const wf = useWorkflowFeed();

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
              description="Pick an item to take through the pipeline above. To plan the whole project first, use the Planning tab."
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
          <ChatLayout
            density="compact"
            className="wf-chat"
            composer={running && <ChatComposer onSubmit={send} placeholder="Answer Claude…" density="compact" />}
            emptyState={(
              <EmptyState
                title="No conversation to show"
                description={`${hint} The transcript lives with the session, so it doesn't survive a server restart.`}
              />
            )}
          >
            {transcript.length === 0 && state.stepStatus !== 'done' ? null : (
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
          </ChatLayout>
        </>
      )}
    </div>
  );
}
