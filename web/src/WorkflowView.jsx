import { useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { ChatComposer, ChatLayout, ChatMessageList, ChatSystemMessage } from '@astryxdesign/core/Chat';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Selector } from '@astryxdesign/core/Selector';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { post, useWorkflowFeed, Transcript, STEP_INFO } from './useWorkflowFeed.jsx';

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
              {phase === 'running'
                ? <Spinner size="sm" shade="inherit" />
                : <span className="wf-step-num">{done || (i === currentIdx && state.stepStatus === 'done') ? '✓' : i + 1}</span>}
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
// straight to implementation). Project planning lives in the Design tab.
// The picker IS the app-wide selection: picking here scopes the whole tab.
function StartControls({ items, prompt, selectedId, onSelect }) {
  const [startAt, setStartAt] = useState('brainstorm');
  const pickedId = selectedId || '';
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
        onChange={(v) => { onSelect(v); setStartAt('brainstorm'); }}
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

const TYPE_OPTIONS = ['frontend', 'backend', 'integration'].map((t) => ({ value: t, label: t }));

// The UI's single write affordance: seed a planned item in project.yaml —
// optionally starting a fresh brainstorm session on it right away. All other
// state transitions stay workflow/agent-owned.
function NewIdeaForm({ onSelect }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('frontend');
  const [idea, setIdea] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const create = async (brainstorm) => {
    setBusy(true);
    setError(null);
    try {
      const r = await post('/api/items', { name, type, notes: idea });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setError(data.error || 'Failed to add item'); return; }
      setName(''); setIdea('');
      if (!brainstorm) return;
      const s = await post('/api/workflow/start', { itemId: data.id, step: 'brainstorm' });
      if (!s.ok) {
        const err = await s.json().catch(() => ({}));
        // Stay on the form so the error stays visible; don't switch views.
        setError(`"${data.id}" is in the backlog, but brainstorm couldn't start: ${err.error || 'unknown error'}`);
        return;
      }
      onSelect(data.id);
    } catch {
      setError('Request failed — is the server running?');
    } finally {
      setBusy(false);
    }
  };

  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      <Text type="body">New idea:</Text>
      <TextInput label="Idea name" isLabelHidden size="sm" placeholder="Name (e.g. PNG export)" value={name} onChange={setName} />
      <Selector label="Type" isLabelHidden size="sm" value={type} onChange={setType} options={TYPE_OPTIONS} />
      <TextInput label="What is it?" isLabelHidden size="sm" placeholder="One-liner (optional)" value={idea} onChange={setIdea} />
      <Button label="Add to backlog" variant="ghost" size="sm" isDisabled={busy || !name.trim()} onClick={() => create(false)} />
      <Button label="Brainstorm now" variant="primary" size="sm" isDisabled={busy || !name.trim()} onClick={() => create(true)} />
      {error && <Text type="supporting" size="xsm">{error}</Text>}
    </HStack>
  );
}

const STATUS_HINTS = {
  done: 'Pipeline complete.',
  stopped: 'Stopped. Start again whenever you like.',
  'needs-attention': 'The session ended without producing the expected artifact. Retry, or start again.',
  interrupted: 'The server restarted while this step was running. Retry to pick it back up.',
  gated: 'Step complete. Review the output, then continue when ready.',
};
const RUNNING_HINTS = {
  brainstorm: 'Claude is refining the spec — answer its questions below.',
  worktree: 'Creating an isolated worktree + branch…',
  plan: 'Writing the implementation plan…',
  execute: 'Subagents are implementing the plan with TDD. You can watch, or interject below.',
  review: 'Reviewing the branch…',
  finish: 'Claude will ask you: merge, PR, keep, or discard. Answer below.',
  'plan-project': 'Describe what you want to build — items appear in the diagram as you talk. Press Stop when the plan feels complete.',
  'analyze-project': 'Agents are exploring the codebase — items appear on the diagram as areas are mapped. You can interject below.',
};
const STATUS_BADGE = { running: 'info', done: 'success', stopped: 'neutral', 'needs-attention': 'warning', interrupted: 'warning', gated: 'success' };

export default function WorkflowView({ items, selectedId, onSelect }) {
  const wf = useWorkflowFeed();

  if (!wf) return <div className="loading"><Spinner size="lg" /></div>;
  const { state, transcript } = wf;
  const running = state?.stepStatus === 'running';
  const gated = state?.stepStatus === 'gated';
  const nextStep = gated ? state.pipeline[state.pipeline.indexOf(state.step) + 1] : null;
  const item = state?.itemId ? items.find((i) => i.id === state.itemId) : null;
  // The tab is scoped to the selected item: the run's state/transcript only
  // shows when it belongs to the selection (or nothing is selected).
  const selected = selectedId ? items.find((i) => i.id === selectedId) : null;
  const showRun = !!state && (!selected || state.itemId === selected.id);
  // Shipped items stay startable — iterating on a finished feature just runs
  // the pipeline again (status flips back to in-progress while it's worked).
  const startable = items;
  const canRetry = ['interrupted', 'needs-attention'].includes(state?.stepStatus)
    && (!state.itemId || item);
  const hint = running ? RUNNING_HINTS[state.step] : STATUS_HINTS[state?.stepStatus];

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
      // Itemless pipelines (plan-project, analyze-project) restart whole.
      post(`/api/workflow/${state.pipeline[0]}`);
    }
  };

  return (
    <div className="workflow">
      {!showRun && (
        <>
          <Stepper state={null} />
          <div className="wf-transcript">
            <EmptyState
              title={selected ? `${selected.name} — no active session` : 'No workflow yet'}
              description={selected
                ? (selected.spec
                  ? 'Has a spec — run the full pipeline, or start at Worktree to implement it.'
                  : 'Needs a spec — take it through Brainstorm first.')
                : 'Pick an item to take through the pipeline, or type a new idea below. To plan the whole project first, use the Design tab.'}
              actions={(
                <VStack gap={3}>
                  <StartControls items={startable} selectedId={selectedId} onSelect={onSelect} />
                  <NewIdeaForm onSelect={onSelect} />
                </VStack>
              )}
            >
              {state && ['running', 'gated'].includes(state.stepStatus) && (
                <Button
                  label={`View the active session (${item ? item.name : 'project'})`}
                  variant="ghost"
                  size="sm"
                  onClick={() => onSelect(state.itemId || null)}
                />
              )}
            </EmptyState>
          </div>
        </>
      )}

      {showRun && (
        <>
          <Stepper state={state} />
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Text weight="bold">{item ? item.name : state.itemId || 'Project planning'}</Text>
            <Badge variant={STATUS_BADGE[state.stepStatus] || 'neutral'} label={`${STEP_INFO[state.step]?.label || state.step}: ${state.stepStatus}`} />
            <Text type="supporting" size="xsm">{hint}</Text>
            {running && <Button label="Stop" variant="ghost" size="sm" onClick={() => post('/api/workflow/stop')} />}
            {gated && nextStep && (
              <Button
                label={`Continue → ${STEP_INFO[nextStep]?.label || nextStep}`}
                variant="primary"
                size="sm"
                onClick={() => post('/api/workflow/continue')}
              />
            )}
            {canRetry && <Button label={`Retry ${STEP_INFO[state.step]?.label || state.step}`} variant="primary" size="sm" onClick={retry} />}
            {state.error && <Text type="supporting" size="xsm">{state.error}</Text>}
          </HStack>
          {!running && !gated && (
            <>
              <StartControls items={startable} selectedId={selectedId} onSelect={onSelect} prompt="Start something else:" />
              <NewIdeaForm onSelect={onSelect} />
            </>
          )}
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
            {transcript.length === 0 && state.stepStatus !== 'done' && !running ? null : (
              <ChatMessageList density="compact">
                <Transcript transcript={transcript} pending={wf.pending} running={running}>
                  {state.stepStatus === 'done' && (
                    <ChatSystemMessage>
                      {state.itemId
                        ? `pipeline complete for ${state.itemId} — project.yaml has been updated`
                        : 'project planning saved to project.yaml — check the Design and Priority tabs'}
                    </ChatSystemMessage>
                  )}
                </Transcript>
              </ChatMessageList>
            )}
          </ChatLayout>
        </>
      )}
    </div>
  );
}
