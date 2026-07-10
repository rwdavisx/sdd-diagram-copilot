import { useEffect, useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { TypeBadge, SpecFlag } from './chips.jsx';

export default function PriorityView({ items, selectedId, onSelect, onStartWorkflow }) {
  const [data, setData] = useState(null);

  // Refetch whenever project data changes (items is fresh on every reload).
  useEffect(() => {
    let stale = false;
    fetch('/api/priority')
      .then((r) => r.json())
      .then((d) => { if (!stale) setData(d); })
      .catch(() => { if (!stale) setData(null); });
    return () => { stale = true; };
  }, [items]);

  if (!data) return <div className="loading">Loading…</div>;

  return (
    <div className="priority">
      {data.warnings.map((w, i) => <Banner key={i} status="warning" title={w} />)}
      <ol className="priority-list">
        {data.items.map((item) => (
          <li key={item.id}>
            <button
              className={`card status-${item.status} ${item.id === selectedId ? 'selected' : ''}`}
              onClick={() => onSelect(item.id)}
            >
              <div className="card-name">{item.name}</div>
              <HStack gap={2} vAlign="center" wrap="wrap">
                <TypeBadge type={item.type} />
                <SpecFlag spec={item.spec} />
                {item.ready
                  ? <Badge variant="green" label={`ready${item.dependents > 0 ? ` · unblocks ${item.dependents}` : ''}`} />
                  : <Text type="supporting" size="xsm">blocked by: {item.blockedBy.join(', ')}</Text>}
                {item.cycle && <Badge variant="error" label="dependency cycle" />}
              </HStack>
            </button>
            {item.status !== 'shipped' && (
              <Button
                label="Start workflow"
                size="sm"
                icon={<span>▶</span>}
                isIconOnly
                tooltip="Start workflow"
                onClick={() => onStartWorkflow(item.id)}
              />
            )}
          </li>
        ))}
      </ol>
      {data.items.length === 0 && (
        <EmptyState title="Everything is shipped" description="Add new items to project.yaml to plan more work." />
      )}
    </div>
  );
}
