// The canvas.
//
// React Flow renders the graph and owns nothing. Every gesture goes through
// src/view.js into the graph object, and the graph is re-rendered from there -
// so there is exactly one source of truth and the canvas cannot silently hold a
// second copy of it.
//
// A drag is a GESTURE in P1.5's sense. Node positions never reach After Effects,
// but wiring and deleting do, and when M3 attaches the write loop the begin/end
// pair here is what makes a drag cost one undo entry instead of one per frame.

import { useCallback, useMemo } from 'react';
import ReactFlow, { Background, Controls, MiniMap, ReactFlowProvider } from 'reactflow';
import 'reactflow/dist/style.css';

import LayerNode from './LayerNode.jsx';
import {
  toFlowNodes, toFlowEdges, toParentEdges,
  connect, disconnect, applyNodeChanges, ViewError,
} from '../../../src/view.js';

const nodeTypes = { ntlLayer: LayerNode };

const EXPRESSION_EDGE = { stroke: '#5b9dd9', strokeWidth: 2 };
const PARENT_EDGE = { stroke: '#c8a45c', strokeWidth: 2, strokeDasharray: '6 4' };

export default function Canvas({ graph, version, onChanged, onError, onSelect }) {
  // Rebuilt whenever the graph version bumps. Cheap at P1 sizes, and it removes
  // a whole class of bug: there is no incremental canvas state to fall out of
  // step with the model.
  const nodes = useMemo(() => toFlowNodes(graph), [graph, version]);
  const edges = useMemo(() => {
    const expression = toFlowEdges(graph).map((e) => ({ ...e, type: 'default', style: EXPRESSION_EDGE }));
    const parents = toParentEdges(graph).map((e) => ({ ...e, type: 'default', style: PARENT_EDGE }));
    return [...expression, ...parents];
  }, [graph, version]);

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
    const { structural, moved } = applyNodeChanges(graph, changes);
    // `structural` is the flag M3 turns into loop.touch(). A move is reported
    // separately so the redraw happens without ever marking the comp dirty.
    if (structural || moved) onChanged?.({ structural, moved });
  }, [graph, onChanged]);

  const handleEdgesChange = useCallback((changes) => {
    let structural = false;
    for (const change of changes) {
      if (change.type !== 'remove') continue;
      if (disconnect(graph, change.id)) structural = true;
    }
    if (structural) onChanged?.({ structural: true, moved: false });
  }, [graph, onChanged]);

  const handleConnect = useCallback((connection) => {
    const result = guard(() => connect(graph, connection));
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
