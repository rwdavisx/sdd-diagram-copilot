import { useEffect, useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { ChatComposer, ChatLayout, ChatMessageList } from '@astryxdesign/core/Chat';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { post, useWorkflowFeed, Transcript } from './useWorkflowFeed.jsx';
import { usePaneWidth, usePersistedOpen } from './resize.jsx';
import DiagramView from './DiagramView.jsx';

const STATUS_BADGE = { running: 'info', done: 'success', stopped: 'neutral', 'needs-attention': 'warning', interrupted: 'warning' };

export default function DesignView({ items, flows, selectedId, onSelect, servicesById }) {
  const wf = useWorkflowFeed();
  const [startError, setStartError] = useState(null);
  const [iterateOn, setIterateOn] = useState(null); // item id the chat is focused on
  const [chatW, onResizeDown] = usePaneWidth('dc-design-chat-w', 400, { min: 300, max: 760 });
  const [chatOpen, toggleChat] = usePersistedOpen('dc-design-chat-open');

  // Selecting a frontend screen on the canvas focuses the chat on it.
  useEffect(() => {
    const sel = items.find((i) => i.id === selectedId);
    setIterateOn(sel && sel.type === 'frontend' ? sel.id : null);
  }, [selectedId, items]);

  const state = wf?.state;
  const pipeline = state?.pipeline?.[0];
  const isPlanning = pipeline === 'plan-project' || pipeline === 'analyze-project';
  const running = isPlanning && state.stepStatus === 'running';

  const start = (kind) => {
    setStartError(null);
    post(`/api/workflow/${kind}`).then((r) => {
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

  const composer = running && (
    <VStack gap={1}>
      {focused && (
        <HStack gap={1} vAlign="center">
          <Badge variant="info" label={`Iterating: ${focused.name}`} />
          <Button label="✕" variant="ghost" size="sm" tooltip="Stop focusing this screen" onClick={() => { setIterateOn(null); onSelect(null); }} />
        </HStack>
      )}
      <ChatComposer
        onSubmit={send}
        placeholder={focused ? `Describe changes to ${focused.name}…` : 'Describe what you want to build…'}
        density="compact"
      />
    </VStack>
  );

  const activeWorkflow = state && state.itemId && ['running', 'gated'].includes(state.stepStatus)
    ? { itemId: state.itemId, step: state.step, stepStatus: state.stepStatus }
    : null;

  if (!chatOpen) {
    return (
      <div className="design">
        <div className="pane-rail pane-rail-left">
          <Button label="Open chat" tooltip="Open chat" isIconOnly variant="ghost" size="sm" icon={<span>»</span>} onClick={toggleChat} />
        </div>
        <div className="design-canvas">
          <DiagramView items={items} flows={flows} selectedId={selectedId} onSelect={onSelect} active={activeWorkflow} servicesById={servicesById} />
        </div>
      </div>
    );
  }

  return (
    <div className="design">
      <div className="design-chat" style={{ width: chatW }}>
        <div className="pane-collapse">
          <Button label="Collapse chat" tooltip="Collapse chat" isIconOnly variant="ghost" size="sm" icon={<span>«</span>} onClick={toggleChat} />
        </div>
        {!wf && <div className="loading"><Spinner size="lg" /></div>}

        {wf && !isPlanning && (
          <EmptyState
            title="Design your project"
            description="Plan project: Claude interviews you about what you want to build. Analyze codebase: agents reverse-engineer an existing repo. Either way, items land in project.yaml and appear on the diagram live."
            actions={
              <HStack gap={1}>
                <Button label="Plan project" variant="primary" size="sm" onClick={() => start('plan-project')} />
                <Button label="Analyze codebase" size="sm" onClick={() => start('analyze-project')} />
              </HStack>
            }
          >
            {startError && <Text type="supporting" size="xsm">{startError}</Text>}
          </EmptyState>
        )}

        {wf && isPlanning && (
          <>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Text weight="bold">{pipeline === 'analyze-project' ? 'Codebase analysis' : 'Project planning'}</Text>
              <Badge variant={STATUS_BADGE[state.stepStatus] || 'neutral'} label={state.stepStatus} />
              {running
                ? <Button label="Stop" variant="ghost" size="sm" onClick={() => post('/api/workflow/stop')} />
                : <Button label={pipeline === 'analyze-project' ? 'Analyze again' : 'Plan again'} size="sm" onClick={() => start(pipeline)} />}
            </HStack>
            <ChatLayout density="compact" className="wf-chat" composer={composer}>
              <ChatMessageList density="compact">
                <Transcript transcript={wf.transcript} pending={wf.pending} running={running} />
              </ChatMessageList>
            </ChatLayout>
          </>
        )}
      </div>
      <div className="pane-resizer" onPointerDown={onResizeDown} />
      <div className="design-canvas">
        <DiagramView items={items} flows={flows} selectedId={selectedId} onSelect={onSelect} active={activeWorkflow} servicesById={servicesById} />
      </div>
    </div>
  );
}
