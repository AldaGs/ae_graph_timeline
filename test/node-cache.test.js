import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNodeCache } from '../panel/src/canvas/nodeCache.js';
import { createGraph, addNode, LABEL_COLORS } from '../src/graph.js';
import { toFlowNodes } from '../src/view.js';

test('display cache preserves unchanged data and detects in-place property mutations', () => {
  const graph = createGraph();
  addNode(graph, { id: 'a', name: 'A', props: { position: [1, 2] } });
  addNode(graph, { id: 'b', name: 'B', props: {} });
  const cached = createNodeCache();
  const first = cached(toFlowNodes(graph));
  graph.nodes.a.props.position[0] = 5;
  const next = cached(toFlowNodes(graph));
  assert.notEqual(next[0].data, first[0].data);
  assert.equal(next[1].data, first[1].data);
  const moved = cached(toFlowNodes(graph));
  assert.equal(moved[0].data, next[0].data);
  cached([]);
  assert.notEqual(cached(toFlowNodes(graph))[0].data, moved[0].data);
});

test('flow edges do not mark an expression input as driven; label 16 is displayable', () => {
  const graph = createGraph();
  addNode(graph, { id: 'a', name: 'A', label: 16, props: {} });
  graph.edges.e = { id: 'e', from: 'a', to: 'a', kind: 'flow' };
  const [node] = toFlowNodes(graph);
  assert.deepEqual(node.data.driven, {});
  assert.equal(node.data.labelColor, LABEL_COLORS[16]);
  assert.ok(node.data.labelColor);
});
