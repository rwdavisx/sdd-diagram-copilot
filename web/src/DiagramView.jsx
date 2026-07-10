import { useMemo } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, MarkerType } from '@xyflow/react';
import dagre from 'dagre';
import '@xyflow/react/dist/style.css';

const NODE_W = 200;
const NODE_H = 64;
const LANES = ['frontend', 'backend', 'integration'];
const LANE_GAP = 60;

function ItemNode({ data }) {
  return (
    <div className={`flow-node status-${data.item.status} ${data.selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="flow-node-name">{data.item.name}</div>
      <div className="flow-node-meta">
        <span className={`badge type-${data.item.type}`}>{data.item.type}</span>
        <span className={`dot status-${data.item.status}`} />
        <span className="status-text">{data.item.status}</span>
        {data.item.spec ? <span className="spec-flag" title={`spec: ${data.item.spec}`}>spec ✓</span>
          : <span className="spec-flag missing" title="no spec written yet">no spec</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function LaneNode({ data }) {
  return <div className="lane-label">{data.label}</div>;
}

const nodeTypes = { item: ItemNode, lane: LaneNode };

// dagre (left→right) decides horizontal position from the dependency graph;
// vertical position is forced into one lane per type so the three layers of
// the architecture stay visually separated.
function layout(items) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 30, ranksep: 90 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(items.map((i) => i.id));
  items.forEach((i) => g.setNode(i.id, { width: NODE_W, height: NODE_H }));
  items.forEach((i) => (i.depends || []).forEach((d) => { if (ids.has(d)) g.setEdge(i.id, d); }));
  dagre.layout(g);

  const positions = {};
  let laneTop = 0;
  const laneRects = [];
  for (const lane of LANES) {
    const laneItems = items
      .filter((i) => i.type === lane)
      .sort((a, b) => g.node(a.id).x - g.node(b.id).x);
    if (!laneItems.length) continue;
    // Stack items that dagre placed at overlapping x into rows within the lane.
    const rows = [];
    for (const item of laneItems) {
      const x = g.node(item.id).x - NODE_W / 2;
      let row = rows.findIndex((endX) => x > endX + 20);
      if (row === -1) { row = rows.length; rows.push(0); }
      rows[row] = x + NODE_W;
      positions[item.id] = { x, y: laneTop + 40 + row * (NODE_H + 20) };
    }
    const laneHeight = 40 + rows.length * (NODE_H + 20) + 20;
    laneRects.push({ lane, top: laneTop, height: laneHeight });
    laneTop += laneHeight + LANE_GAP;
  }
  return { positions, laneRects };
}

export default function DiagramView({ items, selectedId, onSelect }) {
  const { nodes, edges } = useMemo(() => {
    const { positions, laneRects } = layout(items);
    const maxX = Math.max(0, ...Object.values(positions).map((p) => p.x + NODE_W));

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

    const itemNodes = items.map((item) => ({
      id: item.id,
      type: 'item',
      position: positions[item.id] || { x: 0, y: 0 },
      data: { item, selected: item.id === selectedId },
    }));

    const ids = new Set(items.map((i) => i.id));
    const itemEdges = items.flatMap((item) =>
      (item.depends || []).filter((d) => ids.has(d)).map((dep) => ({
        id: `${item.id}->${dep}`,
        source: item.id,
        target: dep,
        markerEnd: { type: MarkerType.ArrowClosed },
        className: 'flow-edge',
      })),
    );
    return { nodes: [...laneNodes, ...itemNodes], edges: itemEdges };
  }, [items, selectedId]);

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
