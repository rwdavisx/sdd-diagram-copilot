// GraphView — embeds Graphify's interactive graph.html with a freshness chip
// and a manual Regenerate button. Polls status while a regen is in flight.
import { useEffect, useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';

const CHIP_VARIANT = {
  fresh: 'success',
  'stale-regenerating': 'warning',
  missing: 'warning',
  unavailable: 'error',
};

const LABEL = {
  fresh: 'fresh',
  'stale-regenerating': 'regenerating…',
  missing: 'generating…',
  unavailable: 'unavailable',
};

export default function GraphView() {
  const [status, setStatus] = useState(null);

  const refresh = () =>
    fetch('/api/graphify/status').then((r) => r.json()).then(setStatus).catch(() => {});

  useEffect(() => { refresh(); }, []);

  // While a regen is (or should be) running, poll until the graph lands.
  useEffect(() => {
    if (!status || status.state === 'fresh' || status.state === 'unavailable') return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [status && status.state]);

  const regenerate = () =>
    fetch('/api/graphify/regenerate', { method: 'POST' }).then(refresh).catch(() => {});

  const state = status ? status.state : 'missing';
  const hasGraph = status && (state === 'fresh' || state === 'stale-regenerating');
  const label = LABEL[state] + (status?.generatedAt ? ` · ${new Date(status.generatedAt).toLocaleTimeString()}` : '');

  return (
    <div className="graph-view">
      <HStack gap={3} vAlign="center" padding={2} className="graph-view-header">
        <Text weight="bold" style={{ flex: 1 }}>Graph — codebase knowledge graph</Text>
        <Badge variant={CHIP_VARIANT[state]} label={label} />
        <Button label="Regenerate" size="sm" onClick={regenerate} isDisabled={state === 'unavailable'} />
      </HStack>
      {hasGraph ? (
        <iframe
          key={status.generatedAt || 'graph'} /* reload the iframe when a regen lands */
          src="/api/graphify/graph.html"
          title="Graphify graph"
          className="graph-view-frame"
        />
      ) : (
        <EmptyState
          title={state === 'unavailable' ? 'Graphify is unavailable' : 'No graph yet'}
          description={state === 'unavailable'
            ? (status?.hint || 'Graphify is not installed. Install uv or pipx, then: uv tool install graphifyy')
            : 'It is being generated in the background.'}
        />
      )}
    </div>
  );
}
