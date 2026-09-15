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

import { useCallback, useEffect, useRef } from 'react';
import ReactFlow, {
  Background, Controls, MiniMap, ReactFlowProvider,
  useEdgesState, useNodesState,
} from 'reactflow';
import 'reactflow/dist/style.css';

import LayerNode from './LayerNode.jsx';
import EffectNode from './EffectNode.jsx';
import ExpressionNode from './ExpressionNode.jsx';
import { createNodeCache } from './nodeCache.js';
import {
  toFlowNodes, toFlowEdges, toParentEdges,
  ViewError,
} from '../../../src/view.js';

// Defined once, outside the component. A fresh object here would tell React Flow
// its node types changed on every render, and it re-mounts every node when they
// do - which looks exactly like the flicker this file is about.
const nodeTypes = { 
  ntlLayer: LayerNode,
  ntlEffect: EffectNode,
  ntlExpression: ExpressionNode
};

const EXPRESSION_EDGE = { stroke: '#5b9dd9', strokeWidth: 2 };
const FLOW_EDGE = { stroke: '#70b978', strokeWidth: 3 };
const PARENT_EDGE = { stroke: '#c8a45c', strokeWidth: 2, strokeDasharray: '6 4' };

const wiresOf = (graph) => [
  ...toFlowEdges(graph).map((e) => ({
    ...e,
    type: e.data.kind === 'flow' ? 'smoothstep' : 'default',
    style: e.data.kind === 'flow' ? FLOW_EDGE : EXPRESSION_EDGE,
    animated: e.data.kind === 'flow',
  })),
  ...toParentEdges(graph).map((e) => ({ ...e, type: 'default', style: PARENT_EDGE })),
];

export default function Canvas({ graph, commands, version, selectedId = null, editable = true, onError, onSelect, onPaneContextMenu, onGestureStart, onGestureEnd, onProjectItemDrop }) {
  const flowRef = useRef(null);
  const cacheRef = useRef(createNodeCache());
  const callbacksRef = useRef(new Map());
  const [nodes, setNodes, onNodesChange] = useNodesState(() => toFlowNodes(graph));
  const [edges, setEdges, onEdgesChange] = useEdgesState(() => wiresOf(graph));

  // Re-seeded only when the GRAPH changed - a node added, a wire drawn, a rename.
  // Never during a drag, because a drag does not bump the version.
  useEffect(() => {
    const liveIds = new Set(Object.keys(graph.nodes));
    for (const id of callbacksRef.current.keys()) {
      if (!liveIds.has(id)) callbacksRef.current.delete(id);
    }
    const freshNodes = cacheRef.current(toFlowNodes(graph)).map(n => {
      const previous = callbacksRef.current.get(n.id);
      if (!previous || previous.commands !== commands || previous.editable !== editable
          || previous.start !== onGestureStart || previous.end !== onGestureEnd || previous.source !== n.data) {
        callbacksRef.current.set(n.id, {
          commands, editable, start: onGestureStart, end: onGestureEnd, source: n.data,
          data: { ...n.data, editable,
            onExpressionChange: (expr) => { if (editable) commands.setExpression(n.id, expr); },
            onExpressionFocus: onGestureStart, onExpressionBlur: onGestureEnd,
          },
        });
      }
      return {
        ...n,
        selected: n.id === selectedId,
        data: callbacksRef.current.get(n.id).data,
      };
    });
    setNodes(freshNodes);
    setEdges(wiresOf(graph));
  }, [graph, commands, version, selectedId, editable, setNodes, setEdges, onGestureStart, onGestureEnd]);

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

    for (const change of changes) {
      if (change.type === 'remove') commands.removeFromCanvas(change.id);
    }
  }, [commands, onNodesChange]);

  const handleNodeDragStart = useCallback(() => {
    onGestureStart?.();
  }, [onGestureStart]);

  // The end of the gesture. Every node that moved is written to the model at
  // once, because a multi-selection drags together.
  const handleNodeDragStop = useCallback((_event, _node, dragged) => {
    if (dragged.length > 0) commands.moveNodes(dragged);
    // Always close what drag-start opened, including a click with no movement.
    onGestureEnd?.();
  }, [commands, onGestureEnd]);

  const handleEdgesChange = useCallback((changes) => {
    onEdgesChange(changes);
    for (const change of changes) {
      if (change.type === 'remove') commands.disconnect(change.id);
    }
  }, [commands, onEdgesChange]);

  const handleConnect = useCallback((connection) => {
    guard(() => commands.connectTyped(connection));
  }, [commands, guard]);

  const handleSelectionChange = useCallback(({ nodes: selected }) => {
    // React Flow can report an empty selection when focus moves to the toolbar.
    // Only a positive selection is accepted here; pane clicks clear explicitly.
    if (selected?.[0]?.id) onSelect?.(selected[0].id);
  }, [onSelect]);

  const handlePaneClick = useCallback(() => onSelect?.(null), [onSelect]);

  const handleDragOver = useCallback((event) => {
    if (!editable || !onProjectItemDrop) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }, [editable, onProjectItemDrop]);

  const handleDrop = useCallback((event) => {
    if (!editable || !onProjectItemDrop) return;
    event.preventDefault();
    const position = flowRef.current?.screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    });
    if (position) void onProjectItemDrop(position);
  }, [editable, onProjectItemDrop]);

  return (
    <ReactFlowProvider>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onInit={(instance) => { flowRef.current = instance; }}
        onNodesChange={editable ? handleNodesChange : undefined}
        onNodeDragStart={editable ? handleNodeDragStart : undefined}
        onNodeDragStop={editable ? handleNodeDragStop : undefined}
        onEdgesChange={editable ? handleEdgesChange : undefined}
        onConnect={editable ? handleConnect : undefined}
        onSelectionChange={handleSelectionChange}
        onPaneClick={handlePaneClick}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onPaneContextMenu={editable ? (event) => onPaneContextMenu?.(event, flowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY })) : undefined}
        // Deleting is destructive and reaches the comp, so it is a deliberate
        // keystroke rather than something a stray Backspace can do.
        deleteKeyCode={null}
        onKeyDown={(event) => {
          if (editable && event.key === 'Delete' && !event.target.isContentEditable && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) {
            event.preventDefault();
            const selectedEdges = edges.filter((edge) => edge.selected);
            if (selectedEdges.length) {
              selectedEdges.forEach((edge) => guard(() => commands.disconnect(edge.id)));
            } else if (selectedId) {
              document.getElementById('ntl-inspector-delete')?.click();
            }
          }
        }}
        nodesDraggable={editable}
        nodesConnectable={editable}
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
        {nodes.length <= 200 && <MiniMap
          pannable
          zoomable
          nodeColor="#4a4a4a"
          maskColor="rgba(10,10,10,0.6)"
          style={{ background: '#1a1a1a', border: '1px solid #3a3a3a' }}
        />}
      </ReactFlow>
    </ReactFlowProvider>
  );
}
