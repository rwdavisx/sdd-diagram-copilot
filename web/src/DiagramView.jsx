import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, MarkerType, useUpdateNodeInternals } from '@xyflow/react';
import dagre from 'dagre';
import { HStack } from '@astryxdesign/core/HStack';
import { TypeBadge, StatusChip, SpecFlag } from './chips.jsx';
import '@xyflow/react/dist/style.css';

const NODE_W = 240;
const NODE_H = 72;
const LANES = ['frontend', 'backend', 'integration'];
const LANE_GAP = 60;

// Wireframes are authored at 800px and rendered scaled down inside the node.
const WF_W = 800;
const WF_SCALE = 0.35;
const WF_HEADER_H = 34;
const WF_MIN_H = 120;
const WF_MAX_H = 1400;

function ItemNode({ data }) {
  return (
    <div className={`flow-node status-${data.item.status} ${data.selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="flow-node-name">{data.item.name}</div>
      <HStack gap={1.5} vAlign="center" wrap="nowrap">
        <TypeBadge type={data.item.type} />
        <StatusChip status={data.item.status} />
        <SpecFlag spec={data.item.spec} />
      </HStack>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

// A screen node rendering its HTML wireframe in a scaled same-origin iframe.
// After load it measures content height plus the position of every flow-anchor
// element so edges can attach to the actual button/form inside the wireframe.
function WireframeNode({ id, data }) {
  const ref = useRef(null);
  const updateNodeInternals = useUpdateNodeInternals();
  const [contentH, setContentH] = useState(400);
  const [anchors, setAnchors] = useState({});

  const measure = useCallback(() => {
    const doc = ref.current?.contentDocument;
    if (!doc?.body) return;
    requestAnimationFrame(() => {
      const rawH = Math.min(Math.max(Math.ceil(doc.body.getBoundingClientRect().height) + 16, WF_MIN_H), WF_MAX_H);
      const found = {};
      for (const anchorId of data.anchorIds) {
        const el = doc.getElementById(anchorId);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        found[anchorId] = { x: r.right * WF_SCALE, y: WF_HEADER_H + (r.top + r.height / 2) * WF_SCALE };
      }
      setContentH(rawH);
      setAnchors(found);
      data.onMeasure(id, { w: WF_W * WF_SCALE, h: WF_HEADER_H + rawH * WF_SCALE });
      updateNodeInternals(id);
    });
  }, [id, data, updateNodeInternals]);

  // Re-measure when flows change or the wireframe file was reloaded (rev bump
  // re-keys the iframe, but anchors can also change without a content reload).
  useEffect(() => { measure(); }, [data.anchorIds.join(','), data.rev]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={`flow-node wf-node status-${data.item.status} ${data.selected ? 'selected' : ''}`}
      style={{ width: WF_W * WF_SCALE }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="wf-node-header">
        <span className="flow-node-name">{data.item.name}</span>
        <TypeBadge type={data.item.type} />
        <StatusChip status={data.item.status} />
      </div>
      <div className="wf-node-frame" style={{ height: contentH * WF_SCALE }}>
        <iframe
          key={data.rev}
          ref={ref}
          src={'/' + data.item.wireframe}
          sandbox="allow-same-origin"
          title={data.item.name}
          onLoad={measure}
          style={{ width: WF_W, height: contentH, transform: `scale(${WF_SCALE})`, transformOrigin: 'top left', border: 0, pointerEvents: 'none' }}
        />
      </div>
      {data.anchorIds.map((a) => (
        <Handle
          key={a}
          id={a}
          type="source"
          position={Position.Right}
          style={anchors[a] ? { left: anchors[a].x, top: anchors[a].y, right: 'auto', transform: 'none' } : undefined}
        />
      ))}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function LaneNode({ data }) {
  return <div className="lane-label">{data.label}</div>;
}

const nodeTypes = { item: ItemNode, wireframe: WireframeNode, lane: LaneNode };

// dagre (left→right) decides horizontal position from the dependency graph;
// vertical position is forced into one lane per type so the three layers of
// the architecture stay visually separated. Wireframe nodes report their real
// size via `sizes`; everything else uses the fixed card size.
function layout(items, sizes) {
  const dim = (i) => sizes[i.id] || { w: NODE_W, h: NODE_H };
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 30, ranksep: 90 });
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
      let row = rows.findIndex((r) => x > r.endX + 20);
      if (row === -1) { row = rows.length; rows.push({ endX: 0, maxH: 0 }); }
      rows[row].endX = x + w;
      rows[row].maxH = Math.max(rows[row].maxH, h);
      placed.push({ id: item.id, row, x });
      maxX = Math.max(maxX, x + w);
    }
    const rowY = [];
    let y = laneTop + 40;
    for (const r of rows) { rowY.push(y); y += r.maxH + 20; }
    for (const p of placed) positions[p.id] = { x: p.x, y: rowY[p.row] };
    const laneHeight = y - laneTop + 20;
    laneRects.push({ lane, top: laneTop, height: laneHeight });
    laneTop += laneHeight + LANE_GAP;
  }
  return { positions, laneRects, maxX };
}

export default function DiagramView({ items, flows = [], rev = 0, selectedId, onSelect }) {
  const [sizes, setSizes] = useState({});
  const onMeasure = useCallback((id, size) => {
    setSizes((cur) => {
      const p = cur[id];
      if (p && Math.abs(p.w - size.w) < 1 && Math.abs(p.h - size.h) < 1) return cur;
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
    const anchorsByItem = {};
    for (const f of flows) {
      if (f.anchor) (anchorsByItem[f.from] = anchorsByItem[f.from] || []).push(f.anchor);
    }

    const itemNodes = items.map((item) => ({
      id: item.id,
      type: item.wireframe ? 'wireframe' : 'item',
      position: positions[item.id] || { x: 0, y: 0 },
      data: {
        item,
        selected: item.id === selectedId,
        ...(item.wireframe ? { anchorIds: [...new Set(anchorsByItem[item.id] || [])], rev, onMeasure } : {}),
      },
    }));

    // A flow edge between the same pair supersedes the plain depends edge.
    const flowPairs = new Set(flows.map((f) => `${f.from}->${f.to}`));
    const dependEdges = items.flatMap((item) =>
      (item.depends || [])
        .filter((d) => ids.has(d) && !flowPairs.has(`${item.id}->${d}`))
        .map((dep) => ({
          id: `${item.id}->${dep}`,
          source: item.id,
          target: dep,
          markerEnd: { type: MarkerType.ArrowClosed },
          className: 'flow-edge',
        })),
    );
    const flowEdges = flows
      .filter((f) => ids.has(f.from) && ids.has(f.to))
      .map((f, i) => ({
        id: `flow:${f.from}:${f.anchor || 'node'}->${f.to}:${i}`,
        source: f.from,
        sourceHandle: f.anchor || undefined,
        target: f.to,
        markerEnd: { type: MarkerType.ArrowClosed },
        className: `flow-edge flow-${f.kind}`,
      }));

    return { nodes: [...laneNodes, ...itemNodes], edges: [...dependEdges, ...flowEdges] };
  }, [items, flows, sizes, rev, selectedId, onMeasure]);

  return (
    <div className="diagram">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => { if (!node.id.startsWith('lane-')) onSelect(node.id); }}
        onPaneClick={() => onSelect(null)}
        fitView
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
      >
        <Background gap={24} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
