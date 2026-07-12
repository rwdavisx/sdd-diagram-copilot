import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { ServiceDot } from './chips.jsx';
import { post } from './useWorkflowFeed.jsx';
import { svcPost } from './useServices.jsx';

export default function RunView({ services, onSelect }) {
  if (!services.length) {
    return (
      <div className="run-view">
        <EmptyState
          title="No services declared"
          description="Give items in project.yaml a run: block (cmd, optional cwd/port/env) and they become controllable here."
        />
      </div>
    );
  }
  const anyLive = services.some((s) => s.status === 'running' || s.status === 'starting');
  return (
    <div className="run-view">
      <HStack gap={2} vAlign="center">
        <Text type="large" weight="bold">Services</Text>
        <div style={{ marginLeft: 'auto' }}>
          <HStack gap={1}>
            <Button label="Start all" variant="primary" size="sm" onClick={() => post('/api/services/start-all')} />
            <Button label="Stop all" variant="secondary" size="sm" isDisabled={!anyLive} onClick={() => post('/api/services/stop-all')} />
          </HStack>
        </div>
      </HStack>
      <table className="run-table">
        <thead>
          <tr><th>Service</th><th>Status</th><th>Port</th><th>PID</th><th>Since</th><th /></tr>
        </thead>
        <tbody>
          {services.map((s) => {
            const live = s.status === 'running' || s.status === 'starting';
            return (
              <tr key={s.id}>
                <td><Button label={s.name} variant="ghost" size="sm" onClick={() => onSelect(s.id)} /></td>
                <td>
                  <HStack gap={1} vAlign="center">
                    <ServiceDot service={s} withLabel />
                    {s.stale && <Badge variant="warning" label="config changed" />}
                    {s.invalid && <Badge variant="error" label="invalid run config" />}
                  </HStack>
                </td>
                <td>{s.port ? <Text type="code">:{s.port}</Text> : null}</td>
                <td>{s.pid ? <Text type="code">{s.pid}</Text> : null}</td>
                <td>{s.startedAt ? <Timestamp value={s.startedAt} format="time" /> : null}</td>
                <td>
                  <HStack gap={1}>
                    <Button label="Start" size="sm" variant="secondary" isDisabled={live || s.status === 'external' || !!s.invalid} onClick={() => svcPost(s.id, 'start')} />
                    <Button label="Stop" size="sm" variant="secondary" isDisabled={!live} onClick={() => svcPost(s.id, 'stop')} />
                    <Button label="Restart" size="sm" variant="secondary" isDisabled={s.status === 'external' || !!s.invalid} onClick={() => svcPost(s.id, 'restart')} />
                  </HStack>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
