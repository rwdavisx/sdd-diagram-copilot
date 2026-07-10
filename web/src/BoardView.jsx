import { Badge } from '@astryxdesign/core/Badge';
import { Text } from '@astryxdesign/core/Text';
import { HStack } from '@astryxdesign/core/HStack';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { TypeBadge, SpecFlag } from './chips.jsx';

const COLUMNS = [
  { status: 'planned', title: 'Planned' },
  { status: 'in-progress', title: 'In progress' },
  { status: 'shipped', title: 'Shipped' },
];

export default function BoardView({ items, selectedId, onSelect }) {
  return (
    <div className="board">
      {COLUMNS.map(({ status, title }) => {
        const cards = items.filter((i) => i.status === status);
        return (
          <div key={status} className={`column column-${status}`}>
            <HStack gap={2} vAlign="center" as="h2">
              <Text type="label">{title}</Text>
              <Badge label={cards.length} />
            </HStack>
            {cards.map((item) => (
              <button
                key={item.id}
                className={`card status-${item.status} ${item.id === selectedId ? 'selected' : ''}`}
                onClick={() => onSelect(item.id)}
              >
                <div className="card-name">{item.name}</div>
                <HStack gap={2} vAlign="center">
                  <TypeBadge type={item.type} />
                  <SpecFlag spec={item.spec} />
                </HStack>
              </button>
            ))}
            {cards.length === 0 && <EmptyState isCompact title="Nothing here" />}
          </div>
        );
      })}
    </div>
  );
}
