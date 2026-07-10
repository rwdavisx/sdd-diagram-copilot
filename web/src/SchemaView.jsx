import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { TypeBadge } from './chips.jsx';

const KIND_VARIANT = { api: 'info', db: 'success', event: 'warning' };

// Browse every declared contract (API endpoints, DB tables, event shapes)
// grouped by the item that owns it. Contracts live in project.yaml.
export default function SchemaView({ items, onSelect }) {
  const withContracts = items.filter((i) => Array.isArray(i.contracts) && i.contracts.length > 0);

  if (withContracts.length === 0) {
    return (
      <div className="schemas">
        <EmptyState
          title="No contracts declared yet"
          description="Items can declare contracts in project.yaml — API endpoints, database tables, and event shapes show up here as the project gets planned."
        />
      </div>
    );
  }

  return (
    <div className="schemas">
      {withContracts.map((item) => (
        <section key={item.id} className="schema-group">
          <HStack gap={2} vAlign="center">
            <Button label={item.name} variant="ghost" size="sm" onClick={() => onSelect(item.id)} />
            <TypeBadge type={item.type} />
            <Text type="supporting" size="xsm">{item.contracts.length} contract{item.contracts.length > 1 ? 's' : ''}</Text>
          </HStack>
          <div className="schema-cards">
            {item.contracts.map((c, i) => (
              <div key={i} className="schema-card">
                <HStack gap={2} vAlign="center">
                  <Text weight="bold">{c.name}</Text>
                  <Badge variant={KIND_VARIANT[c.kind] || 'neutral'} label={c.kind || 'contract'} />
                </HStack>
                {c.description && <Text type="supporting" size="xsm" as="p">{c.description}</Text>}
                {c.schema && <pre className="schema-body">{String(c.schema).trimEnd()}</pre>}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
