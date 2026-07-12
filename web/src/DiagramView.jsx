import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, Panel, Position, MarkerType, getSmoothStepPath, useReactFlow, useUpdateNodeInternals } from '@xyflow/react';
import dagre from 'dagre';
import { Badge } from '@astryxdesign/core/Badge';
import { HStack } from '@astryxdesign/core/HStack';
import { Spinner } from '@astryxdesign/core/Spinner';
import { TypeBadge, StatusChip, SpecFlag, TestChip, PlanChip, ServiceDot } from './chips.jsx';
import { STEP_INFO } from './useWorkflowFeed.jsx';
import '@xyflow/react/dist/style.css';

const NODE_W = 240;
const NODE_H = 72;
const SCREEN_W = 320;
const LANES = ['frontend', 'backend', 'integration'];
const LANE_GAP = 16;
const WF_W = 800; // wireframes are authored at 800px
const WF_SCALE = SCREEN_W / WF_W;
const WF_MIN_H = 120;
const WF_MAX_H = 1400;
// Estimated screen-node height until the iframe reports its real one.
const SCREEN_FALLBACK_H = 330;

// var() strings are fine here: xyflow applies marker/label colors via inline
// style, where CSS variables resolve — keeps edges in sync with the theme.
const EDGE_COLOR = { nav: 'var(--frontend)', api: 'var(--backend)', data: 'var(--integration)' };
const EDGE_GRAY = 'var(--muted)';

// Invisible anchor points on all four sides so edges can enter/leave a node
// on the side that faces its counterpart (stacked nodes connect vertically
// instead of wrapping a horizontal edge around the card).
function Anchors() {
  return (
    <>
      <Handle id="t-left" type="target" position={Position.Left} />
      <Handle id="t-top" type="target" position={Position.Top} />
      <Handle id="t-right" type="target" position={Position.Right} />
      <Handle id="t-bottom" type="target" position={Position.Bottom} />
      <Handle id="s-left" type="source" position={Position.Left} />
      <Handle id="s-top" type="source" position={Position.Top} />
      <Handle id="s-right" type="source" position={Position.Right} />
      <Handle id="s-bottom" type="source" position={Position.Bottom} />
    </>
  );
}

// Live pipeline badge for the item the workflow is currently working on.
function ActiveBadge({ active }) {
  const label = STEP_INFO[active.step]?.label || active.step;
  return (
    <HStack gap={1} vAlign="center">
      {active.stepStatus === 'running' && <Spinner size="sm" />}
      <Badge
        variant={active.stepStatus === 'running' ? 'info' : 'success'}
        label={active.stepStatus === 'gated' ? `${label} done — awaiting continue` : `in pipeline: ${label}`}
      />
    </HStack>
  );
}

const CONTRACTS_SHOWN = 3;

const ItemNode = memo(function ItemNode({ id, data }) {
  const ref = useRef(null);
  // Rich nodes vary in height — report the real size so dagre can lay out
  // without overlaps (same mechanism screen nodes use).
  useEffect(() => {
    if (ref.current) data.onMeasure?.(id, { w: ref.current.offsetWidth, h: ref.current.offsetHeight });
  });
  const contracts = data.item.contracts || [];
  return (
    <div ref={ref} className={`flow-node status-${data.item.status} ${data.selected ? 'selected' : ''}`}>
      <Anchors />
      <div className="flow-node-name">{data.item.name}</div>
      <HStack gap={1.5} vAlign="center" wrap="wrap">
        <TypeBadge type={data.item.type} />
        <StatusChip status={data.item.status} />
        <SpecFlag spec={data.item.spec} />
        <PlanChip plan={data.item.plan} status={data.item.status} />
        <TestChip tests={data.item.tests} />
        <ServiceDot service={data.service} />
      </HStack>
      {data.active && <ActiveBadge active={data.active} />}
      {data.item.notes && <div className="flow-node-notes">{data.item.notes}</div>}
      {contracts.length > 0 && (
        <div className="flow-node-contracts">
          {contracts.slice(0, CONTRACTS_SHOWN).map((c, i) => (
            <div key={i} className="flow-node-contract">{c.name}</div>
          ))}
          {contracts.length > CONTRACTS_SHOWN && (
            <div className="flow-node-contract flow-node-contract-more">+{contracts.length - CONTRACTS_SHOWN} more</div>
          )}
        </div>
      )}
    </div>
  );
});

// A screen card showing its complete wireframe, scaled to the card width and
// sized to the wireframe's real height — never cropped, never scrollable.
// Flow edges attach to the actual element inside the wireframe (the button,
// list, or grid that triggers them): after load we measure each anchor
// element and pin a source handle on the card's right edge at its height.
const ScreenNode = memo(function ScreenNode({ id, data }) {
  const iframeRef = useRef(null);
  const frameRef = useRef(null);
  const updateNodeInternals = useUpdateNodeInternals();
  // Wireframes render at a fixed scale and the card takes the wireframe's
  // measured size — wider wireframes get wider cards, all at the same zoom.
  const [dim, setDim] = useState({ w: WF_W, h: 800 });
  const [anchors, setAnchors] = useState({});

  const dataRef = useRef(data);
  dataRef.current = data;

  const measure = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc?.body) return;
    requestAnimationFrame(() => {
      if (!iframeRef.current?.contentDocument?.body) return;
      // Freeze the body at the 800px design width so layout matches how the
      // wireframe was authored and can't reflow when we widen the iframe
      // (100%-width rows would chase the viewport forever). Pin heights to
      // content-driven sizing so measuring can't feed back into the iframe
      // height we set below. Scrollbars are suppressed by scrolling="no".
      doc.documentElement.style.height = 'auto';
      doc.documentElement.style.minHeight = '0';
      doc.body.style.height = 'auto';
      doc.body.style.minHeight = '0';
      doc.body.style.width = `${WF_W}px`;
      doc.body.style.margin = '0'; // a centered body would slide right as the iframe widens
      // scrollWidth misses overflow inside clipping ancestors; bounding rects
      // don't — scan for the true extent (wireframes are small documents).
      let maxR = WF_W;
      let maxB = 0;
      for (const el of doc.body.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.right > maxR) maxR = r.right;
        if (r.bottom > maxB) maxB = r.bottom;
      }
      const rawH = Math.min(Math.max(
        Math.ceil(Math.max(maxB, doc.body.getBoundingClientRect().height)) + 16,
        WF_MIN_H,
      ), WF_MAX_H);
      const rawW = Math.min(Math.ceil(maxR) + 8, 1600);
      const scale = WF_SCALE;
      const frameTop = frameRef.current?.offsetTop || 0;
      const found = [];
      for (const anchorId of dataRef.current.anchorIds) {
        const el = doc.getElementById(anchorId);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        // Pin to the card's right edge at the element's height — a handle at
        // r.right would land mid-card for narrow elements.
        found.push([anchorId, frameTop + Math.min(Math.max(r.top + r.height / 2, 0), rawH) * scale]);
      }
      // Elements can sit on the same row (a task's toggle/edit/delete); fan
      // their stubs out so each edge and label stays individually visible.
      found.sort((a, b) => a[1] - b[1]);
      for (let i = 1; i < found.length; i++) found[i][1] = Math.max(found[i][1], found[i - 1][1] + 16);
      setDim({ w: rawW, h: rawH });
      setAnchors(Object.fromEntries(found));
      // 30 = card padding + borders around the wireframe frame. anchorY lets
      // the edge builder order trunk lanes by stub height.
      dataRef.current.onMeasure(id, {
        w: Math.max(NODE_W, rawW * scale + 30),
        h: frameTop + rawH * scale + 10,
        anchorY: Object.fromEntries(found),
      });
      updateNodeInternals(id);
    });
  }, [id, updateNodeInternals]);

  // Re-measure when the anchor set changes without a file reload (wfrev
  // re-keys the iframe and re-fires onLoad for content changes).
  const anchorKey = data.anchorIds.join(',');
  useEffect(() => { measure(); }, [anchorKey, measure]);

  return (
    <div className={`flow-node screen-node status-${data.item.status} ${data.selected ? 'selected' : ''}`} style={{ width: Math.max(NODE_W, dim.w * WF_SCALE + 30) }}>
      <Anchors />
      <div className="flow-node-name">{data.item.name}</div>
      <HStack gap={1.5} vAlign="center" wrap="nowrap">
        <TypeBadge type={data.item.type} />
        <StatusChip status={data.item.status} />
        <PlanChip plan={data.item.plan} status={data.item.status} />
        <TestChip tests={data.item.tests} />
        <ServiceDot service={data.service} />
      </HStack>
      {data.active && <ActiveBadge active={data.active} />}
      <div ref={frameRef} className="wf-thumb" style={{ width: dim.w * WF_SCALE, height: dim.h * WF_SCALE }}>
        <iframe
          key={data.item.wfrev}
          ref={iframeRef}
          src={'/' + data.item.wireframe}
          sandbox="allow-same-origin"
          scrolling="no"
          title={data.item.name}
          onLoad={measure}
          style={{ width: dim.w, height: dim.h, transform: `scale(${WF_SCALE})`, transformOrigin: 'top left', border: 0, pointerEvents: 'none' }}
        />
      </div>
      {data.anchorIds.map((a) => (
        <Handle
          key={a}
          id={`a-${a}`}
          type="source"
          position={Position.Right}
          className="anchor-handle"
          style={anchors[a] != null ? { top: anchors[a] } : undefined}
        />
      ))}
    </div>
  );
});

const LaneNode = memo(function LaneNode({ data }) {
  return <div className="lane-label">{data.label}</div>;
});

const nodeTypes = { item: ItemNode, screen: ScreenNode, lane: LaneNode };

// Smoothstep edge that pins its label right where it leaves the source
// element instead of at the path midpoint — anchored flows share a corridor,
// so midpoint labels from parallel edges would pile up into an unreadable
// clump. At the stub, labels read as annotations of the element they leave.
function AnchoredEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, label, data, ...rest }) {
  const left = sourcePosition === Position.Left;
  // Turn the path downward in this edge's assigned lane (see the lane
  // assignment in DiagramView) — evenly spaced, past its own label.
  const clear = data?.clear || (label ? label.length * 5.2 + 18 : 24);
  let centerX;
  if (targetPosition === Position.Left && targetX > sourceX) centerX = Math.min(sourceX + clear, targetX - 12);
  else if (targetPosition === Position.Right && targetX < sourceX) centerX = Math.max(sourceX - clear, targetX + 12);
  const [path] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 12, centerX });
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={rest.style} />
      {label && (
        <EdgeLabelRenderer>
          <div
            className={`anchored-label al-${data?.kind || 'nav'}`}
            style={{ transform: `translate(${left ? '-100%' : '0'}, -50%) translate(${sourceX + (left ? -6 : 6)}px, ${sourceY}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { anchored: AnchoredEdge };

// The initial fitView runs before wireframes report their real size, so refit
// (debounced) as items appear and measurements land — but never after the
// user has panned or zoomed; their viewport wins.
function FitOnChange({ signature }) {
  const { fitView } = useReactFlow();
  const userMoved = useRef(false);
  useEffect(() => {
    const onMove = () => { userMoved.current = true; };
    window.addEventListener('pointerdown', onMove, true);
    window.addEventListener('wheel', onMove, true);
    return () => {
      window.removeEventListener('pointerdown', onMove, true);
      window.removeEventListener('wheel', onMove, true);
    };
  }, []);
  useEffect(() => {
    if (userMoved.current) return;
    const t = setTimeout(() => { if (!userMoved.current) fitView({ padding: 0.1 }); }, 150);
    return () => clearTimeout(t);
  }, [signature, fitView]);
  return null;
}

// dagre (left→right) decides horizontal position from the dependency graph;
// vertical position is forced into one lane per type so the three layers of
// the architecture stay visually separated. Screen nodes report their real
// size via `sizes`; everything else uses the fixed card size.
function layout(items, sizes) {
  const dim = (i) => sizes[i.id]
    || (i.wireframe ? { w: SCREEN_W, h: SCREEN_FALLBACK_H } : { w: NODE_W, h: NODE_H });
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 120 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(items.map((i) => i.id));
  items.forEach((i) => g.setNode(i.id, { width: dim(i).w, height: dim(i).h }));
  items.forEach((i) => (i.depends || []).forEach((d) => { if (ids.has(d)) g.setEdge(i.id, d); }));
  dagre.layout(g);

  const positions = {};
  let laneTop = 0;
  let maxX = 0;
  const laneRects = [];
  for (const lane of LANES) {
    const laneItems = items
      .filter((i) => i.type === lane)
      .sort((a, b) => g.node(a.id).x - g.node(b.id).x);
    if (!laneItems.length) continue;
    // Stack items that dagre placed at overlapping x into rows within the
    // lane; each row is as tall as its tallest node.
    const rows = []; // { endX, maxH }
    const placed = []; // { id, row, x }
    for (const item of laneItems) {
      const { w, h } = dim(item);
      const x = g.node(item.id).x - w / 2;
      let row = rows.findIndex((r) => x > r.endX + 30);
      if (row === -1) { row = rows.length; rows.push({ endX: 0, maxH: 0 }); }
      rows[row].endX = x + w;
      rows[row].maxH = Math.max(rows[row].maxH, h);
      placed.push({ id: item.id, row, x });
      maxX = Math.max(maxX, x + w);
    }
    const rowY = [];
    let y = laneTop + 32;
    for (const r of rows) { rowY.push(y); y += r.maxH + 24; }
    for (const p of placed) positions[p.id] = { x: p.x, y: rowY[p.row] };
    const laneHeight = y - laneTop - 24 + 14;
    laneRects.push({ lane, top: laneTop, height: laneHeight });
    laneTop += laneHeight + LANE_GAP;
  }
  return { positions, laneRects, maxX };
}

// Bundle parallel node-level flows between the same pair+kind into one edge.
// Element-anchored flows are NOT bundled — each starts at its own element,
// which is the whole point of anchoring.
function bundleFlows(flows, ids) {
  const groups = new Map();
  for (const f of flows) {
    if (!ids.has(f.from) || !ids.has(f.to)) continue;
    const key = `${f.from}->${f.to}:${f.kind}`;
    const cur = groups.get(key) || { ...f, count: 0, labels: [] };
    cur.count += 1;
    if (f.label && !cur.labels.includes(f.label)) cur.labels.push(f.label);
    groups.set(key, cur);
  }
  return [...groups.entries()].map(([key, g]) => ({
    key,
    ...g,
    label: g.labels[0]
      ? g.labels[0] + (g.count > 1 ? ` +${g.count - 1}` : '')
      : g.count > 1 ? `${g.kind} ×${g.count}` : undefined,
  }));
}

// Route an edge out of the side of each node that faces the other one.
// Same-lane nodes are stacked, so mostly-vertical pairs connect top/bottom;
// cross-lane edges stay horizontal so they don't cut through lane-mates.
function pickHandles(src, tgt, centers) {
  const s = centers[src.id];
  const t = centers[tgt.id];
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  if (src.type === tgt.type && Math.abs(dy) > Math.abs(dx)) {
    return dy > 0
      ? { sourceHandle: 's-bottom', targetHandle: 't-top' }
      : { sourceHandle: 's-top', targetHandle: 't-bottom' };
  }
  return dx >= 0
    ? { sourceHandle: 's-right', targetHandle: 't-left' }
    : { sourceHandle: 's-left', targetHandle: 't-right' };
}

function edgeChrome(kind) {
  const color = EDGE_COLOR[kind] || EDGE_GRAY;
  return {
    type: 'smoothstep',
    pathOptions: { borderRadius: 12 },
    animated: kind === 'api' || kind === 'data',
    markerEnd: { type: MarkerType.ArrowClosed, color },
    labelStyle: { fill: color, fontWeight: 600 },
    labelBgPadding: [4, 2],
    labelBgBorderRadius: 3,
    labelBgStyle: { fill: 'var(--panel)', fillOpacity: 0.85 },
    className: `flow-edge flow-${kind}`,
  };
}

export default function DiagramView({ items, flows = [], selectedId, onSelect, active = null, servicesById = {} }) {
  const [sizes, setSizes] = useState({});
  const onMeasure = useCallback((id, size) => {
    const sig = (s) => `${Math.round(s.w)}x${Math.round(s.h)}|${Object.entries(s.anchorY || {}).map(([k, v]) => `${k}:${Math.round(v)}`).join(',')}`;
    setSizes((cur) => {
      const p = cur[id];
      if (p && sig(p) === sig(size)) return cur;
      return { ...cur, [id]: size };
    });
  }, []);

  const { nodes, edges } = useMemo(() => {
    const { positions, laneRects, maxX } = layout(items, sizes);

    const laneNodes = laneRects.map(({ lane, top, height }) => ({
      id: `lane-${lane}`,
      position: { x: -60, y: top },
      data: { label: lane },
      className: `lane lane-${lane}`,
      style: { width: maxX + 120, height },
      selectable: false,
      draggable: false,
      focusable: false,
      type: 'lane',
      zIndex: -1,
    }));

    const ids = new Set(items.map((i) => i.id));
    const byId = new Map(items.map((i) => [i.id, i]));
    const dims = (i) => sizes[i.id] || (i.wireframe ? { w: SCREEN_W, h: SCREEN_FALLBACK_H } : { w: NODE_W, h: NODE_H });
    const centers = {};
    for (const item of items) {
      const p = positions[item.id] || { x: 0, y: 0 };
      const d = dims(item);
      centers[item.id] = { x: p.x + d.w / 2, y: p.y + d.h / 2 };
    }

    const anchorsByItem = {};
    for (const f of flows) {
      if (f.anchor && ids.has(f.from)) (anchorsByItem[f.from] = anchorsByItem[f.from] || []).push(f.anchor);
    }

    const itemNodes = items.map((item) => ({
      id: item.id,
      type: item.wireframe ? 'screen' : 'item',
      position: positions[item.id] || { x: 0, y: 0 },
      data: {
        item,
        selected: item.id === selectedId,
        active: active && active.itemId === item.id ? active : null,
        onMeasure,
        service: servicesById[item.id] || null,
        ...(item.wireframe ? { anchorIds: [...new Set(anchorsByItem[item.id] || [])] } : {}),
      },
    }));

    const valid = flows.filter((f) => ids.has(f.from) && ids.has(f.to));
    const anchored = valid.filter((f) => f.anchor);
    const bundled = bundleFlows(valid.filter((f) => !f.anchor), ids);

    // Any flow between a pair supersedes the plain depends edge.
    const flowPairs = new Set(valid.map((f) => `${f.from}->${f.to}`));
    const dependEdges = items.flatMap((item) =>
      (item.depends || [])
        .filter((d) => ids.has(d) && !flowPairs.has(`${item.id}->${d}`))
        .map((dep) => ({
          id: `${item.id}->${dep}`,
          source: item.id,
          target: dep,
          ...pickHandles(item, byId.get(dep), centers),
          type: 'smoothstep',
          pathOptions: { borderRadius: 12 },
          markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_GRAY },
          className: 'flow-edge',
        })),
    );

    // One edge per anchored flow, leaving the card's right edge at the height
    // of the element that owns it; enter the target from whichever side faces
    // the source. Labels fall back to the anchor id, which is descriptive by
    // convention (add-task-btn, calendar-grid, …).
    // Assign each source's trunks to evenly spaced vertical lanes. Ordering
    // bottom stub → innermost lane nests the L-shaped runs without crossings;
    // a lane never starts before its own label ends.
    const LANE_GAP_X = 14;
    const bySource = new Map();
    anchored.forEach((f, i) => {
      if (!bySource.has(f.from)) bySource.set(f.from, []);
      bySource.get(f.from).push({ f, i, label: f.label || f.anchor.replace(/-/g, ' ') });
    });
    const anchoredEdges = [];
    for (const [from, list] of bySource) {
      const anchorY = sizes[from]?.anchorY || {};
      list.sort((a, b) => (anchorY[b.f.anchor] ?? 0) - (anchorY[a.f.anchor] ?? 0));
      let lane = 0;
      for (const { f, i, label } of list) {
        lane = Math.max(label.length * 5.2 + 16, lane + LANE_GAP_X);
        anchoredEdges.push({
          id: `flow:${f.from}:${f.anchor}->${f.to}:${i}`,
          source: f.from,
          sourceHandle: `a-${f.anchor}`,
          target: f.to,
          targetHandle: centers[f.to].x - centers[f.from].x > 60 ? 't-left' : 't-right',
          label,
          data: { kind: f.kind, clear: lane },
          ...edgeChrome(f.kind),
          type: 'anchored',
        });
      }
    }

    const flowEdges = bundled.map((f) => ({
      id: `flow:${f.key}`,
      source: f.from,
      target: f.to,
      ...pickHandles(byId.get(f.from), byId.get(f.to), centers),
      label: f.label,
      ...edgeChrome(f.kind),
    }));

    return { nodes: [...laneNodes, ...itemNodes], edges: [...dependEdges, ...anchoredEdges, ...flowEdges] };
  }, [items, flows, sizes, selectedId, onMeasure, active, servicesById]);

  return (
    <div className="diagram">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_, node) => { if (!node.id.startsWith('lane-')) onSelect(node.id); }}
        onPaneClick={() => onSelect(null)}
        fitView
        minZoom={0.2}
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
      >
        <Background gap={24} />
        <Controls showInteractive={false} />
        <FitOnChange signature={`${items.map((i) => i.id).join(',')}|${Object.values(sizes).map((s) => Math.round(s.h)).join(',')}`} />
        <Panel position="top-right" className="diagram-legend">
          <span><i className="lg lg-depends" /> depends</span>
          <span><i className="lg lg-nav" /> nav</span>
          <span><i className="lg lg-api" /> api</span>
          <span><i className="lg lg-data" /> data</span>
        </Panel>
      </ReactFlow>
    </div>
  );
}
