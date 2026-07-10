import { useEffect, useRef, useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { ChatComposer, ChatMessageList } from '@astryxdesign/core/Chat';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { post, useWorkflowFeed, TranscriptEvent } from './useWorkflowFeed.jsx';
import DiagramView from './DiagramView.jsx';

const STATUS_BADGE = { running: 'info', done: 'success', stopped: 'neutral', 'needs-attention': 'warning', interrupted: 'warning' };

export default function PlanningView({ items, flows, rev, selectedId, onSelect }) {
  const wf = useWorkflowFeed();
  const endRef = useRef(null);
  const [startError, setStartError] = useState(null);
  const [iterateOn, setIterateOn] = useState(null); // item id the chat is focused on

  // Selecting a frontend screen on the canvas focuses the chat on it.
  useEffect(() => {
    const sel = items.find((i) => i.id === selectedId);
    setIterateOn(sel && sel.type === 'frontend' ? sel.id : null);
  }, [selectedId, items]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [wf?.transcript.length]);

  const state = wf?.state;
  const isPlanning = state?.pipeline?.[0] === 'plan-project';
  const running = isPlanning && state.stepStatus === 'running';

  const start = () => {
    setStartError(null);
    post('/api/workflow/plan-project').then((r) => {
      if (!r.ok) setStartError('A workflow is already running — stop it in the Workflow tab first.');
    });
  };

  const focused = iterateOn ? items.find((i) => i.id === iterateOn) : null;

  const send = (value) => {
    const t = value.trim();
    if (!t || !running) return;
    const prefix = focused
      ? `[Context: iterating on screen "${focused.id}" — wireframe at ${focused.wireframe || `design/wireframes/${focused.id}.html`}]\n`
      : '';
    post('/api/workflow/input', { text: prefix + t });
  };

  return (
    <div className="planning">
      <div className="planning-chat">
        {!wf && <div className="loading">Loading…</div>}

        {wf && !isPlanning && (
          <EmptyState
            title="Plan your project"
            description="Claude interviews you about what you want to build — screens, features, and integrations land in project.yaml and appear on the diagram as you talk."
            actions={<Button label="Plan project" variant="primary" size="sm" onClick={start} />}
          >
            {startError && <Text type="supporting" size="xsm">{startError}</Text>}
          </EmptyState>
        )}

        {wf && isPlanning && (
          <>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Text weight="bold">Project planning</Text>
              <Badge variant={STATUS_BADGE[state.stepStatus] || 'neutral'} label={state.stepStatus} />
              {running
                ? <Button label="Stop" variant="ghost" size="sm" onClick={() => post('/api/workflow/stop')} />
                : <Button label="Plan again" size="sm" onClick={start} />}
            </HStack>
            <div className="wf-transcript">
              <ChatMessageList density="compact">
                {wf.transcript.map((ev) => <TranscriptEvent key={ev.seq} ev={ev} />)}
              </ChatMessageList>
              <div ref={endRef} />
            </div>
            {running && focused && (
              <HStack gap={1} vAlign="center">
                <Badge variant="info" label={`Iterating: ${focused.name}`} />
                <Button label="✕" variant="ghost" size="sm" tooltip="Stop focusing this screen" onClick={() => { setIterateOn(null); onSelect(null); }} />
              </HStack>
            )}
            {running && (
              <ChatComposer
                onSubmit={send}
                placeholder={focused ? `Describe changes to ${focused.name}…` : 'Describe what you want to build…'}
                density="compact"
              />
            )}
          </>
        )}
      </div>
      <div className="planning-canvas">
        <DiagramView items={items} flows={flows} rev={rev} selectedId={selectedId} onSelect={onSelect} />
      </div>
    </div>
  );
}
