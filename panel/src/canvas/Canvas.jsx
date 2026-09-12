// The canvas.
//
// React Flow renders the graph and owns nothing that lasts: every gesture goes
// through src/view.js into the graph object, and the canvas is re-seeded from
// there. One source of truth, and no incremental canvas state to fall out of
// step with the model.
//
// The exception is a drag IN PROGRESS, and it is a deliberate one.
//
// The first version re-derived every node and every edge from the graph on every
// pointer move, which is sixty rebuilds a second of an array whose objects are
// all new - so React re-rendered every card, and the whole CEP panel flickered.
// Panning and zooming never did, because React Flow handles the viewport itself
// and React is not involved at all. That asymmetry is what named the bug.
//
// So React Flow keeps the positions while the pointer is down, and the model
// learns the final one when it comes up. That is not a compromise of the "graph
// owns everything" rule; it is the same rule P1.5 applies to After Effects. A
// drag is ONE gesture, and it is worth exactly one write at the end of it.

import { useCallback, useEffect } from 'react';
import ReactFlow, {
  Background, Controls, MiniMap, ReactFlowProvider,
  useEdgesState, useNodesState,
} from 'reactflow';
import 'reactflow/dist/style.css';

import LayerNode from './LayerNode.jsx';
import {
  toFlowNodes, toFlowEdges, toParentEdges,
  connect, disconnect, removeNode, ViewError,
} from '../../../src/view.js';
import { moveNode } from '../../../src/graph.js';

// Defined once, outside the component. A fresh object here would tell React Flow
// its node types changed on every render, and it re-mounts every node when they
// do - which looks exactly like the flicker this file is about.
const nodeTypes = { ntlLayer: LayerNode };

const EXPRESSION_EDGE = { stroke: '#5b9dd9', strokeWidth: 2 };
const PARENT_EDGE = { stroke: '#c8a45c', strokeWidth: 2, strokeDasharray: '6 4' };

const wiresOf = (graph) => [
  ...toFlowEdges(graph).map((e) => ({ ...e, type: 'default', style: EXPRESSION_EDGE })),
  ...toParentEdges(graph).map((e) => ({ ...e, type: 'default', style: PARENT_EDGE })),
];

export default function Canvas({ graph, version, onChanged, onError, onSelect }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(() => toFlowNodes(graph));
  const [edges, setEdges, onEdgesChange] = useEdgesState(() => wiresOf(graph));

  // Re-seeded only when the GRAPH changed - a node added, a wire drawn, a rename.
  // Never during a drag, because a drag does not bump the version.
  useEffect(() => {
    setNodes(toFlowNodes(graph));
    setEdges(wiresOf(graph));
  }, [graph, version, setNodes, setEdges]);

  const guard = useCallback((fn) => {
    // A refusal from the view layer is a sentence for the user, not a crash:
    // "a node cannot be wired to itself" is the whole point of checking.
    try {
      return fn();
    } catch (e) {
      if (e instanceof ViewError) { onError?.(e.message); return null; }
      throw e;
    }
  }, [onError]);

  const handleNodesChange = useCallback((changes) => {
    // React Flow moves the one node the pointer is on. Positions land in the
    // model at drag stop; everything else here is about the canvas.
    onNodesChange(changes);

    let structural = false;
    for (const change of changes) {
      if (change.type === 'remove' && removeNode(graph, change.id)) structural = true;
    }
    if (structural) onChanged?.({ structural: true, moved: false });
  }, [graph, onNodesChange, onChanged]);

  // The end of the gesture. Every node that moved is written to the model at
  // once, because a multi-selection drags together.
  const handleNodeDragStop = useCallback((_event, _node, dragged) => {
    const moved = dragged?.length ? dragged : (_node ? [_node] : []);
    for (const n of moved) moveNode(graph, n.id, n.position.x, n.position.y);
    // Reported, but with structural false: where a node sits is a fact about the
    // drawing, and it must never mark the comp dirty or reach After Effects.
    if (moved.length) onChanged?.({ structural: false, moved: true });
  }, [graph, onChanged]);

  const handleEdgesChange = useCallback((changes) => {
    onEdgesChange(changes);
    let structural = false;
    for (const change of changes) {
      if (change.type !== 'remove') continue;
      if (disconnect(graph, change.id)) structural = true;
    }
    if (structural) onChanged?.({ structural: true, moved: false });
  }, [graph, onEdgesChange, onChanged]);

  const handleConnect = useCallback((connection) => {
    const result = guard(() => connect(graph, connection));
    // No edge is pushed into React Flow here. The graph took the wire, the
    // version bumps, and the effect above re-seeds - so what is drawn is what the
    // model holds, rather than a wire the canvas invented and the model refused.
    if (result) onChanged?.({ structural: true, moved: false, what: result });
  }, [graph, guard, onChanged]);

  const handleSelectionChange = useCallback(({ nodes: selected }) => {
    onSelect?.(selected?.[0]?.id ?? null);
  }, [onSelect]);

  return (
    <ReactFlowProvider>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onNodeDragStop={handleNodeDragStop}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onSelectionChange={handleSelectionChange}
        // Deleting is destructive and reaches the comp, so it is a deliberate
        // keystroke rather than something a stray Backspace can do.
        deleteKeyCode={['Delete']}
        proOptions={{ hideAttribution: true }}
        fitView
        // Without the padding the outermost nodes sit against the pane edge,
        // and their ports - which hang over that edge - are the first thing a
        // user reaches for.
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={2.5}
      >
        <Background color="#2a2a2a" gap={22} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor="#4a4a4a"
          maskColor="rgba(10,10,10,0.6)"
          style={{ background: '#1a1a1a', border: '1px solid #3a3a3a' }}
        />
      </ReactFlow>
    </ReactFlowProvider>
  );
}
