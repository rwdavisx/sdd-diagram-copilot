import { memo, useEffect, useMemo, useRef } from 'react';
import { ReactFlow, Background, Controls, Handle, Panel, Position, MarkerType, useReactFlow } from '@xyflow/react';
import dagre from 'dagre';
import { HStack } from '@astryxdesign/core/HStack';
import { TypeBadge, StatusChip, SpecFlag } from './chips.jsx';
import '@xyflow/react/dist/style.css';

// Uniform node sizes — layered layouts read best when nodes in a rank align
// and edges route predictably (see yFiles/Tom Sawyer layout guidance).
const NODE_W = 240;
const NODE_H = 72;
const THUMB_H = 140;
const SCREEN_H = NODE_H + THUMB_H;
const LANES = ['frontend', 'backend', 'integration'];
const LANE_GAP = 60;
const WF_W = 800; // wireframes are authored at 800px

const ItemNode = memo(function ItemNode({ data }) {
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
});

// A screen card: same chrome as ItemNode plus a live thumbnail of the top of
// its wireframe. The full wireframe is viewed in the detail panel — keeping
// nodes uniform keeps the diagram layout clean and the canvas fast.
const ScreenNode = memo(function ScreenNode({ data }) {
  const scale = NODE_W / WF_W;
  return (
    <div className={`flow-node screen-node status-${data.item.status} ${data.selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="flow-node-name">{data.item.name}</div>
      <HStack gap={1.5} vAlign="center" wrap="nowrap">
        <TypeBadge type={data.item.type} />
        <StatusChip status={data.item.status} />
      </HStack>
      <div className="wf-thumb" style={{ height: THUMB_H }}>
        <iframe
          key={data.item.wfrev}
          src={'/' + data.item.wireframe}
          sandbox="allow-same-origin"
          loading="lazy"
          title={data.item.name}
          style={{ width: WF_W, height: THUMB_H / scale, transform: `scale(${scale})`, transformOrigin: 'top left', border: 0, pointerEvents: 'none' }}
        />
        <div className="wf-thumb-hint">click to view full wireframe</div>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const LaneNode = memo(function LaneNode({ data }) {
  return <div className="lane-label">{data.label}</div>;
});

const nodeTypes = { item: ItemNode, screen: ScreenNode, lane: LaneNode };

// Refit once when the set of items changes (planning adds nodes live) — but
// never after the user has panned or zoomed; their viewport wins.
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
    const t = setTimeout(() => { if (!userMoved.current) fitView({ padding: 0.1 }); }, 100);
    return () => clearTimeout(t);
  }, [signature, fitView]);
  return null;
}

// dagre (left→right) decides horizontal position from the dependency graph;
// vertical position is forced into one lane per type so the three layers of
// the architecture stay visually separated.
function layout(items) {
  const dim = (i) => ({ w: NODE_W, h: i.wireframe ? SCREEN_H : NODE_H });
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
    let y = laneTop + 40;
    for (const r of rows) { rowY.push(y); y += r.maxH + 30; }
    for (const p of placed) positions[p.id] = { x: p.x, y: rowY[p.row] };
    const laneHeight = y - laneTop + 20;
    laneRects.push({ lane, top: laneTop, height: laneHeight });
    laneTop += laneHeight + LANE_GAP;
  }
  return { positions, laneRects, maxX };
}

// Bundle parallel flows between the same pair+kind into one edge — many thin
// parallel lines between two nodes carry no extra information, just clutter.
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
      : g.count > 1 ? `×${g.count}` : undefined,
  }));
}

export default function DiagramView({ items, flows = [], selectedId, onSelect }) {
  const { nodes, edges } = useMemo(() => {
    const { positions, laneRects, maxX } = layout(items);

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
    const itemNodes = items.map((item) => ({
      id: item.id,
      type: item.wireframe ? 'screen' : 'item',
      position: positions[item.id] || { x: 0, y: 0 },
      data: { item, selected: item.id === selectedId },
    }));

    const bundled = bundleFlows(flows, ids);
    // A flow edge between the same pair supersedes the plain depends edge.
    const flowPairs = new Set(bundled.map((f) => `${f.from}->${f.to}`));
    const dependEdges = items.flatMap((item) =>
      (item.depends || [])
        .filter((d) => ids.has(d) && !flowPairs.has(`${item.id}->${d}`))
        .map((dep) => ({
          id: `${item.id}->${dep}`,
          source: item.id,
          target: dep,
          type: 'smoothstep',
          pathOptions: { borderRadius: 12 },
          markerEnd: { type: MarkerType.ArrowClosed },
          className: 'flow-edge',
        })),
    );
    const flowEdges = bundled.map((f) => ({
      id: `flow:${f.key}`,
      source: f.from,
      target: f.to,
      type: 'smoothstep',
      pathOptions: { borderRadius: 12 },
      label: f.label,
      markerEnd: { type: MarkerType.ArrowClosed },
      className: `flow-edge flow-${f.kind}`,
    }));

    return { nodes: [...laneNodes, ...itemNodes], edges: [...dependEdges, ...flowEdges] };
  }, [items, flows, selectedId]);

  return (
    <div className="diagram">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => { if (!node.id.startsWith('lane-')) onSelect(node.id); }}
        onPaneClick={() => onSelect(null)}
        fitView
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
      >
        <Background gap={24} />
        <Controls showInteractive={false} />
        <FitOnChange signature={items.map((i) => i.id).join(',')} />
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
