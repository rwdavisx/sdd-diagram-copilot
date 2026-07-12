import { useEffect, useRef, useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Divider } from '@astryxdesign/core/Divider';
import { HStack } from '@astryxdesign/core/HStack';
import { Markdown } from '@astryxdesign/core/Markdown';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { TypeBadge, TestChip, ServiceDot, STATUS_VARIANT, TEST_STATUS_VARIANT } from './chips.jsx';
import { svcPost } from './useServices.jsx';

const WF_W = 800; // wireframes are authored at 800px

// The full wireframe, scaled to the panel's width at its complete height —
// the diagram only shows a thumbnail, this is where you actually read it.
function WireframeViewer({ item, panelWidth }) {
  const ref = useRef(null);
  // Wireframes are authored at 800px by convention but sometimes overflow it;
  // render at the measured content width so nothing is cropped on the right.
  const [dim, setDim] = useState({ w: WF_W, h: 600 });
  const scale = Math.max(0.2, (panelWidth - 34) / dim.w);

  const measure = () => {
    const doc = ref.current?.contentDocument;
    if (!doc?.body) return;
    // Freeze the body at the 800px design width (100%-width rows would
    // otherwise reflow when the iframe widens) and pin heights to content-
    // driven sizing so measuring can't feed back into the iframe dimensions.
    // scrollWidth misses overflow inside clipping ancestors; bounding rects
    // don't — scan for the true extent. Scrollbars: scrolling="no".
    doc.documentElement.style.height = 'auto';
    doc.body.style.height = 'auto';
    doc.body.style.width = `${WF_W}px`;
    doc.body.style.margin = '0'; // a centered body would slide right as the iframe widens
    let maxR = WF_W;
    let maxB = 0;
    for (const el of doc.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.right > maxR) maxR = r.right;
      if (r.bottom > maxB) maxB = r.bottom;
    }
    setDim({
      w: Math.min(Math.ceil(maxR) + 8, 1600),
      h: Math.ceil(Math.max(maxB, doc.body.getBoundingClientRect().height)) + 16,
    });
  };

  return (
    <div className="wf-viewer" style={{ height: dim.h * scale }}>
      <iframe
        key={item.wfrev}
        ref={ref}
        src={'/' + item.wireframe}
        sandbox="allow-same-origin"
        scrolling="no"
        title={item.name}
        onLoad={measure}
        style={{ width: dim.w, height: dim.h, transform: `scale(${scale})`, transformOrigin: 'top left', border: 0, pointerEvents: 'none' }}
      />
    </div>
  );
}

// Controls + recent output for an item with a run: block. Output comes from
// GET /api/services/:id, refetched whenever the live status flips.
function ServiceSection({ item, service }) {
  const [output, setOutput] = useState([]);
  useEffect(() => {
    if (!service) return;
    let cancelled = false;
    fetch(`/api/services/${encodeURIComponent(item.id)}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setOutput(d.output || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [item.id, service?.status]);
  if (!service) return null;
  const live = service.status === 'running' || service.status === 'starting';
  return (
    <VStack gap={1}>
      <HStack gap={2} vAlign="center">
        <Text type="label">Service</Text>
        <ServiceDot service={service} withLabel />
        {service.port && <Text type="code">:{service.port}</Text>}
        {service.stale && <Badge variant="warning" label="config changed — restart" />}
      </HStack>
      <HStack gap={1}>
        <Button label="Start" size="sm" variant="secondary" isDisabled={live || service.status === 'external' || !!service.invalid} onClick={() => svcPost(item.id, 'start')} />
        <Button label="Stop" size="sm" variant="secondary" isDisabled={!live} onClick={() => svcPost(item.id, 'stop')} />
        <Button label="Restart" size="sm" variant="secondary" isDisabled={service.status === 'external' || !!service.invalid} onClick={() => svcPost(item.id, 'restart')} />
      </HStack>
      {service.invalid && <Text type="supporting" as="p">Invalid run config: {service.invalid}</Text>}
      {output.length > 0 && <pre className="schema-body">{output.slice(-40).join('\n')}</pre>}
    </VStack>
  );
}

export default function DetailPanel({ item, items, width, service, onSelect, onClose, onCollapse, onStartWorkflow }) {
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
            <HStack gap={1}>
              {onCollapse && <Button label="Collapse" tooltip="Collapse panel" icon={<span>»</span>} isIconOnly variant="ghost" size="sm" onClick={onCollapse} />}
              <Button label="Close" icon={<span>×</span>} isIconOnly variant="ghost" size="sm" onClick={onClose} />
            </HStack>
          </div>
        </HStack>
        <HStack gap={2} vAlign="center">
          <TypeBadge type={item.type} />
          <Badge variant={STATUS_VARIANT[item.status]} label={item.status} />
        </HStack>
        <HStack>
          <Button
            label={item.status === 'shipped' ? 'Iterate — run workflow again' : 'Start workflow'}
            variant="primary"
            size="sm"
            onClick={() => onStartWorkflow(item.id)}
          />
        </HStack>

        <ServiceSection item={item} service={service} />

        {item.notes && <Text type="supporting" as="p">{item.notes}</Text>}

        {item.wireframe && (
          <VStack gap={1}>
            <Text type="label">Wireframe</Text>
            <WireframeViewer item={item} panelWidth={width || 380} />
          </VStack>
        )}

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

        {Array.isArray(item.tests) && item.tests.length > 0 && (
          <VStack gap={1}>
            <HStack gap={2} vAlign="center">
              <Text type="label">Tests</Text>
              <TestChip tests={item.tests} />
            </HStack>
            {item.tests.map((t, i) => (
              <HStack key={i} gap={2} vAlign="center" wrap="wrap">
                <Badge variant={TEST_STATUS_VARIANT[t.status] || 'neutral'} label={t.status || 'unknown'} />
                <Text>{t.name}</Text>
                {t.file && <Text type="code">{t.file}</Text>}
              </HStack>
            ))}
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
