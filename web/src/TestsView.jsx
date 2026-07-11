import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { TypeBadge, TestChip, TEST_STATUS_VARIANT } from './chips.jsx';

// Every recorded test across the project, grouped by owning item. Tests live
// in project.yaml (`tests:` per item) — the execute step records them as they
// are written and keeps statuses current.
export default function TestsView({ items, onSelect }) {
  const withTests = items.filter((i) => Array.isArray(i.tests) && i.tests.length > 0);

  if (withTests.length === 0) {
    return (
      <div className="schemas">
        <EmptyState
          title="No tests recorded yet"
          description="As the workflow's execute step writes and runs tests, it records each one under the item's tests: in project.yaml — pass/fail status shows up here and on the diagram nodes."
        />
      </div>
    );
  }

  const all = withTests.flatMap((i) => i.tests);
  const count = (s) => all.filter((t) => t.status === s).length;

  return (
    <div className="schemas">
      <div className="schema-group">
        <HStack gap={2} vAlign="center">
          <Text weight="bold">{all.length} tests</Text>
          <Badge variant="success" label={`${count('passing')} passing`} />
          {count('failing') > 0 && <Badge variant="error" label={`${count('failing')} failing`} />}
          {count('unknown') > 0 && <Badge variant="neutral" label={`${count('unknown')} not run`} />}
        </HStack>
      </div>
      {withTests.map((item) => (
        <section key={item.id} className="schema-group">
          <HStack gap={2} vAlign="center">
            <Button label={item.name} variant="ghost" size="sm" onClick={() => onSelect(item.id)} />
            <TypeBadge type={item.type} />
            <TestChip tests={item.tests} />
          </HStack>
          <div className="test-rows">
            {item.tests.map((t, i) => (
              <div key={i} className="schema-card">
                <HStack gap={2} vAlign="center" wrap="wrap">
                  <Badge variant={TEST_STATUS_VARIANT[t.status] || 'neutral'} label={t.status || 'unknown'} />
                  <Text weight="bold">{t.name}</Text>
                  {t.file && <Text type="code">{t.file}</Text>}
                </HStack>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
