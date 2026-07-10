import { useEffect, useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Divider } from '@astryxdesign/core/Divider';
import { HStack } from '@astryxdesign/core/HStack';
import { Markdown } from '@astryxdesign/core/Markdown';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { TypeBadge, STATUS_VARIANT } from './chips.jsx';

export default function DetailPanel({ item, items, width, onSelect, onClose, onStartWorkflow }) {
  const [spec, setSpec] = useState(null); // { text } | { error } | null while loading

  useEffect(() => {
    if (!item.spec) { setSpec(null); return; }
    let cancelled = false;
    setSpec(null);
    fetch(`/api/spec?path=${encodeURIComponent(item.spec)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => { if (!cancelled) setSpec({ text }); })
      .catch((e) => { if (!cancelled) setSpec({ error: e.message }); });
    return () => { cancelled = true; };
  }, [item.id, item.spec]);

  const dependents = items.filter((i) => (i.depends || []).includes(item.id));

  return (
    <aside className="detail" style={width ? { width } : undefined}>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center">
          <Text type="large" weight="bold">{item.name}</Text>
          <div style={{ marginLeft: 'auto' }}>
            <Button label="Close" icon={<span>×</span>} isIconOnly variant="ghost" size="sm" onClick={onClose} />
          </div>
        </HStack>
        <HStack gap={2} vAlign="center">
          <TypeBadge type={item.type} />
          <Badge variant={STATUS_VARIANT[item.status]} label={item.status} />
        </HStack>
        {item.status !== 'shipped' && (
          <HStack>
            <Button label="Start workflow" variant="primary" size="sm" onClick={() => onStartWorkflow(item.id)} />
          </HStack>
        )}

        {item.notes && <Text type="supporting" as="p">{item.notes}</Text>}

        {(item.depends || []).length > 0 && (
          <VStack gap={1}>
            <Text type="label">Depends on</Text>
            <HStack gap={1} wrap="wrap">
              {item.depends.map((d) => {
                const target = items.find((i) => i.id === d);
                return target
                  ? <Button key={d} label={target.name} variant="secondary" size="sm" onClick={() => onSelect(d)} />
                  : <Badge key={d} variant="error" label={d} />;
              })}
            </HStack>
          </VStack>
        )}
        {dependents.length > 0 && (
          <VStack gap={1}>
            <Text type="label">Used by</Text>
            <HStack gap={1} wrap="wrap">
              {dependents.map((i) => (
                <Button key={i.id} label={i.name} variant="secondary" size="sm" onClick={() => onSelect(i.id)} />
              ))}
            </HStack>
          </VStack>
        )}

        {Array.isArray(item.contracts) && item.contracts.length > 0 && (
          <VStack gap={1}>
            <Text type="label">Contracts</Text>
            {item.contracts.map((c, i) => (
              <div key={i} className="schema-card">
                <HStack gap={2} vAlign="center">
                  <Text weight="bold">{c.name}</Text>
                  {c.kind && <Badge variant="neutral" label={c.kind} />}
                </HStack>
                {c.schema && <pre className="schema-body">{String(c.schema).trimEnd()}</pre>}
              </div>
            ))}
          </VStack>
        )}

        <Divider />
        <VStack gap={1}>
          <HStack gap={2} vAlign="center">
            <Text type="label">Spec</Text>
            {item.spec && <Text type="code">{item.spec}</Text>}
          </HStack>
          {!item.spec && <Text type="supporting" as="p">No spec yet — this item still needs planning.</Text>}
          {item.spec && spec === null && <Text type="supporting" as="p">Loading spec…</Text>}
          {item.spec && spec?.error && <Text type="supporting" as="p">Could not load spec: {spec.error}</Text>}
          {item.spec && spec?.text != null && (
            <div className="spec-body"><Markdown density="compact" headingLevelStart={3}>{spec.text}</Markdown></div>
          )}
        </VStack>
      </VStack>
    </aside>
  );
}
