import { useCallback, useEffect, useState } from 'react';
import { TabList, Tab } from '@astryxdesign/core/TabList';
import { Text } from '@astryxdesign/core/Text';
import { HStack } from '@astryxdesign/core/HStack';
import { Banner } from '@astryxdesign/core/Banner';
import { Spinner } from '@astryxdesign/core/Spinner';
import { StatusChip } from './chips.jsx';
import BoardView from './BoardView.jsx';
import PriorityView from './PriorityView.jsx';
import WorkflowView from './WorkflowView.jsx';
import DesignView from './DesignView.jsx';
import SchemaView from './SchemaView.jsx';
import TestsView from './TestsView.jsx';
import { Button } from '@astryxdesign/core/Button';
import { usePaneWidth, usePersistedOpen } from './resize.jsx';
import { onServerEvent } from './useWorkflowFeed.jsx';
import DetailPanel from './DetailPanel.jsx';
import './App.css';

const STATUSES = ['planned', 'in-progress', 'shipped'];

export default function App() {
  const [data, setData] = useState(null);
  const [view, setView] = useState('design');
  const [selectedId, setSelectedId] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [detailW, onDetailResize] = usePaneWidth('dc-detail-w', 380, { min: 300, max: 720, fromRight: true });
  const [detailOpen, toggleDetail] = usePersistedOpen('dc-detail-open');

  const refetch = useCallback(() => {
    fetch('/api/project')
      .then((r) => r.json())
      .then((d) => { setData(d); setLoadError(null); })
      .catch((e) => setLoadError(String(e)));
  }, []);

  const startWorkflow = useCallback((itemId) => {
    // Select what we start so the Workflow tab opens scoped to it.
    setSelectedId(itemId);
    fetch('/api/workflow/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId }),
    }).finally(() => setView('workflow'));
  }, []);

  useEffect(() => {
    refetch();
    return onServerEvent('reload', refetch);
  }, [refetch]);

  if (loadError) return <div className="fatal">Cannot reach server: {loadError}</div>;
  if (!data) return <div className="loading"><Spinner size="lg" /></div>;

  const items = data.items.filter((i) => i && i.id);
  const selected = items.find((i) => i.id === selectedId) || null;
  const counts = STATUSES.map((s) => [s, items.filter((i) => i.status === s).length]);

  return (
    <div className="app">
      <header>
        <HStack gap={4} vAlign="center" padding={2}>
          <Text type="large" weight="bold">{data.project || 'Untitled project'}</Text>
          <HStack gap={3} vAlign="center">
            {counts.map(([s, n]) => (
              <HStack key={s} gap={1} vAlign="center">
                <StatusChip status={s} />
                <Text type="supporting" size="xsm">{n}</Text>
              </HStack>
            ))}
          </HStack>
        </HStack>
        <TabList value={view} onChange={setView} size="sm">
          <Tab value="design" label="Design" />
          <Tab value="board" label="Board" />
          <Tab value="schemas" label="Schemas" />
          <Tab value="tests" label="Tests" />
          <Tab value="priority" label="Priority" />
          <Tab value="workflow" label="Workflow" />
        </TabList>
      </header>

      {data.errors.length > 0 && (
        <Banner
          status="error"
          title={`project.yaml has ${data.errors.length} problem${data.errors.length > 1 ? 's' : ''}`}
          defaultIsExpanded
        >
          <ul>{data.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </Banner>
      )}

      <main>
        {view === 'design' && <DesignView items={items} flows={data.flows || []} selectedId={selectedId} onSelect={setSelectedId} />}
        {view === 'board' && <BoardView items={items} selectedId={selectedId} onSelect={setSelectedId} />}
        {view === 'schemas' && <SchemaView items={items} onSelect={setSelectedId} />}
        {view === 'tests' && <TestsView items={items} onSelect={setSelectedId} />}
        {view === 'priority' && <PriorityView items={items} selectedId={selectedId} onSelect={setSelectedId} onStartWorkflow={startWorkflow} />}
        {view === 'workflow' && <WorkflowView items={items} selectedId={selectedId} onSelect={setSelectedId} />}
        {selected && detailOpen && (
          <>
            <div className="pane-resizer" onPointerDown={onDetailResize} />
            <DetailPanel item={selected} items={items} width={detailW} onSelect={setSelectedId} onClose={() => setSelectedId(null)} onCollapse={toggleDetail} onStartWorkflow={startWorkflow} />
          </>
        )}
        {selected && !detailOpen && (
          <div className="pane-rail pane-rail-right">
            <Button label="Open details" tooltip="Open details" isIconOnly variant="ghost" size="sm" icon={<span>«</span>} onClick={toggleDetail} />
          </div>
        )}
      </main>
    </div>
  );
}
