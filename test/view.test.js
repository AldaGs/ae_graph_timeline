// Offline tests for M1's canvas view.
//
// The canvas is the first thing in this project a user touches directly, so the
// invariant under test is the direction of authority: React Flow renders the
// graph and never holds state of its own. A gesture on the canvas is a mutation
// of the graph, or it is nothing.
//
// The second thing under test is that moving a node around the canvas can never
// reach After Effects. A drawing change that emitted a patch would spend one of
// the 99 undo entries on rearranging boxes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toFlow, toFlowNodes, toFlowEdges, toParentEdges, connect, disconnect,
  applyNodeChanges, removeNode, renameNode, uniqueName, wouldCycle,
  propFromHandle, nextNodeId, nextEdgeId, portFromPath, pathFromPort, ViewError,
} from '../src/view.js';
import { createGraph, addNode, addEdge, moveNode, tagFor } from '../src/graph.js';
import { diff } from '../src/diff.js';

function graphOfTwo() {
  const graph = createGraph();
  addNode(graph, { id: 'a', name: 'Source', props: { opacity: 100, position: [960, 540] },
                   ui: { x: 40, y: 60 } });
  addNode(graph, { id: 'b', name: 'Target', props: { opacity: 100, position: [100, 100] },
                   ui: { x: 320, y: 60 } });
  return graph;
}

// The comp state those two nodes would read back as, so a diff can be run
// against a graph the canvas has just edited.
function compOf(graph, { revision = 5 } = {}) {
  return {
    compName: 'Shot 01', compId: 1, revision, duration: 10, frameRate: 24,
    layers: Object.values(graph.nodes).map((node, i) => ({
      nativeId: 500 + i, index: i + 1, name: node.name, comment: tagFor(node.id),
      kind: 'footage', enabled: true, inPoint: 0, outPoint: 5,
      parentTag: node.parent ?? null, parentIndex: null,
      props: { ...node.props }, expressions: {},
    })),
  };
}

// ---- rendering the graph ---------------------------------------------------

test('a node carries its position, its name and the ports it actually owns', () => {
  const graph = graphOfTwo();
  const [a] = toFlowNodes(graph);
  assert.deepEqual(a.position, { x: 40, y: 60 });
  assert.equal(a.data.name, 'Source');
  // The ports ARE the properties the graph owns, so a port list cannot drift
  // from what the reconciler would write.
  assert.deepEqual(a.data.ports, ['opacity', 'position']);
});

test('an edge lands on the input it drives, not on the node as a whole', () => {
  const graph = graphOfTwo();
  addEdge(graph, { id: 'e1', from: 'a', to: 'b', toProp: 'position' });
  const [e] = toFlowEdges(graph);
  assert.equal(e.source, 'a');
  assert.equal(e.target, 'b');
  assert.equal(e.targetHandle, 'in:position');
});

// Every wire on the canvas has to end on a port that is actually there. React
// Flow discards an edge whose handle id it cannot find - in silence, with no
// warning and no error - so the wire lands in the model and simply never
// appears. The panel's first run did exactly that: an edge's source is stored
// the way AFTER EFFECTS addresses it (".transform.position", which is what goes
// into the expression body) and a port is named after the property alone, and
// the renderer used one where it needed the other.
function assertWiresLandOnPorts(graph) {
  const portsOf = new Map(toFlowNodes(graph).map((n) => [n.id, new Set(n.data.ports)]));
  for (const edge of [...toFlowEdges(graph), ...toParentEdges(graph)]) {
    const source = portFromPath(propFromHandle(edge.sourceHandle));
    const target = portFromPath(propFromHandle(edge.targetHandle));
    for (const [nodeId, port] of [[edge.source, source], [edge.target, target]]) {
      if (port === 'parent') continue;         // every node carries a parent port
      assert.ok(portsOf.get(nodeId)?.has(port),
        `edge ${edge.id} points at "${port}" on ${nodeId}, which has no such port`);
    }
  }
}

test('every wire lands on a port that exists - React Flow drops the rest in silence', () => {
  const graph = graphOfTwo();
  connect(graph, { source: 'a', target: 'b',
    sourceHandle: 'out:position', targetHandle: 'in:position' });
  connect(graph, { source: 'a', target: 'b',
    sourceHandle: 'out:opacity', targetHandle: 'in:opacity' });
  graph.nodes.b.parent = 'a';

  assertWiresLandOnPorts(graph);

  // The source path and the port name are different strings on purpose, and the
  // renderer has to translate between them.
  const [edge] = toFlowEdges(graph);
  assert.equal(graph.edges[edge.id].fromProp, '.transform.position',
    'the model keeps the path the expression body needs');
  assert.equal(edge.sourceHandle, 'out:position',
    'and the canvas gets the port the node actually renders');
});

test('the path and the port convert both ways, and an unknown shape passes through', () => {
  assert.equal(pathFromPort('scale'), '.transform.scale');
  assert.equal(portFromPath('.transform.scale'), 'scale');
  // An edge written by hand against something outside the transform group is not
  // mangled into a wrong port; it simply does not match one.
  assert.equal(portFromPath('.effect("Blur")("Blurriness")'), '.effect("Blur")("Blurriness")');
});

test('a driven input is marked as driven, because it is not the user\'s to type into', () => {
  const graph = graphOfTwo();
  addEdge(graph, { id: 'e1', from: 'a', to: 'b', toProp: 'position' });
  const b = toFlowNodes(graph).find((n) => n.id === 'b');
  assert.deepEqual(b.data.driven, { position: 'e1' });
  assert.deepEqual(toFlowNodes(graph)[0].data.driven, {}, 'the source is not driven');
});

test('a parent is drawn as a wire, but never as an expression edge', () => {
  const graph = graphOfTwo();
  graph.nodes.b.parent = 'a';
  const parents = toParentEdges(graph);
  assert.equal(parents.length, 1);
  assert.equal(parents[0].source, 'a');
  assert.equal(parents[0].target, 'b');
  assert.equal(toFlowEdges(graph).length, 0, 'and it is not in the expression edges');
});

test('a parent pointing at a node that is gone draws nothing', () => {
  const graph = graphOfTwo();
  graph.nodes.b.parent = 'ghost';
  assert.deepEqual(toParentEdges(graph), []);
});

test('an empty graph renders an empty canvas rather than throwing', () => {
  assert.deepEqual(toFlow(createGraph()), { nodes: [], edges: [] });
});

// ---- the canvas changing the graph -----------------------------------------

test('dragging a node moves it in the MODEL, and never reaches After Effects', () => {
  // The whole reason `ui` lives in the graph rather than in the panel - and the
  // reason the diff must not look at it.
  const graph = graphOfTwo();
  const comp = compOf(graph);
  assert.equal(diff(graph, comp).ops.length, 0, 'the graph starts clean');

  const result = applyNodeChanges(graph, [
    { type: 'position', id: 'a', position: { x: 900, y: 400 } },
    { type: 'select', id: 'b', selected: true },
    { type: 'dimensions', id: 'b', dimensions: { width: 200, height: 90 } },
  ]);

  assert.deepEqual(graph.nodes.a.ui, { x: 900, y: 400 });
  assert.equal(result.moved, true);
  assert.equal(result.structural, false, 'nothing here is a change to the comp');
  assert.deepEqual(diff(graph, comp).ops, [], 'and the diff still has nothing to write');
});

test('deleting a node takes its edges and the parents pointing at it with it', () => {
  const graph = graphOfTwo();
  addNode(graph, { id: 'c', name: 'Third' });
  addEdge(graph, { id: 'e1', from: 'a', to: 'b', toProp: 'position' });
  graph.nodes.c.parent = 'a';

  const result = applyNodeChanges(graph, [{ type: 'remove', id: 'a' }]);
  assert.equal(result.structural, true);
  assert.deepEqual(Object.keys(graph.nodes), ['b', 'c']);
  assert.deepEqual(Object.keys(graph.edges), [], 'an edge to a node that is gone is not a graph');
  assert.equal(graph.nodes.c.parent, null);
});

test('removing a node that is not there changes nothing and says so', () => {
  const graph = graphOfTwo();
  assert.equal(removeNode(graph, 'ghost'), false);
  assert.equal(Object.keys(graph.nodes).length, 2);
});

// ---- wiring ----------------------------------------------------------------

test('a wire between two inputs becomes an expression edge', () => {
  const graph = graphOfTwo();
  const r = connect(graph, { source: 'a', target: 'b',
    sourceHandle: 'out:position', targetHandle: 'in:position' });
  assert.equal(r.kind, 'edge');
  const edge = graph.edges[r.edge];
  assert.equal(edge.from, 'a');
  assert.equal(edge.toProp, 'position');
  // The body addresses the source the way After Effects does.
  assert.equal(edge.fromProp, '.transform.position');

  // And it reaches the comp as an expression, not as a value.
  const ops = diff(graph, compOf(graph)).ops;
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'setExpression');
});

test('a second wire onto one input replaces the first - a property holds one expression', () => {
  const graph = graphOfTwo();
  addNode(graph, { id: 'c', name: 'Third', props: { position: [0, 0] } });
  const first = connect(graph, { source: 'a', target: 'b',
    sourceHandle: 'out:position', targetHandle: 'in:position' });
  const second = connect(graph, { source: 'c', target: 'b',
    sourceHandle: 'out:position', targetHandle: 'in:position' });

  assert.deepEqual(second.replaced, [first.edge]);
  assert.equal(Object.keys(graph.edges).length, 1);
  // Left to stand, the two edges would be the conflict diff() warns about -
  // which is a worse thing to hand a user than a wire that visibly moved.
  assert.equal(diff(graph, compOf(graph)).warnings.length, 0);
});

test('a parent wire sets the parent, and is not an edge', () => {
  const graph = graphOfTwo();
  // The comp as it stands BEFORE the wire is drawn - a diff against the comp the
  // edit already reached would prove nothing.
  const comp = compOf(graph);

  const r = connect(graph, { source: 'a', target: 'b',
    sourceHandle: 'out:parent', targetHandle: 'in:parent' });
  assert.equal(r.kind, 'parent');
  assert.equal(graph.nodes.b.parent, 'a');
  assert.equal(Object.keys(graph.edges).length, 0);
  assert.deepEqual(diff(graph, comp).ops,
    [{ op: 'setParent', node: 'b', from: null, to: 'a' }]);
});

test('a parent port cannot be wired to a property port', () => {
  const graph = graphOfTwo();
  assert.throws(() => connect(graph, { source: 'a', target: 'b',
    sourceHandle: 'out:parent', targetHandle: 'in:position' }), ViewError);
});

test('a node cannot be wired to itself, and a parent loop is refused by name', () => {
  const graph = graphOfTwo();
  assert.throws(() => connect(graph, { source: 'a', target: 'a',
    sourceHandle: 'out:position', targetHandle: 'in:position' }),
    (e) => e instanceof ViewError && /itself/.test(e.message));

  graph.nodes.b.parent = 'a';
  assert.throws(() => connect(graph, { source: 'b', target: 'a',
    sourceHandle: 'out:parent', targetHandle: 'in:parent' }),
    (e) => e instanceof ViewError && /loop/.test(e.message));
});

test('wouldCycle does not spin on a loop that is already there', () => {
  const graph = graphOfTwo();
  graph.nodes.a.parent = 'b';
  graph.nodes.b.parent = 'a';
  assert.equal(wouldCycle(graph, 'a', 'b'), true);
});

test('wiring to a node that does not exist is refused, not half-applied', () => {
  const graph = graphOfTwo();
  assert.throws(() => connect(graph, { source: 'ghost', target: 'b',
    sourceHandle: 'out:position', targetHandle: 'in:position' }), ViewError);
  assert.equal(Object.keys(graph.edges).length, 0);
});

test('cutting a wire removes the edge, or clears the parent', () => {
  const graph = graphOfTwo();
  const { edge } = connect(graph, { source: 'a', target: 'b',
    sourceHandle: 'out:position', targetHandle: 'in:position' });
  assert.equal(disconnect(graph, edge).kind, 'edge');
  assert.equal(Object.keys(graph.edges).length, 0);

  graph.nodes.b.parent = 'a';
  assert.equal(disconnect(graph, 'parent:b').kind, 'parent');
  assert.equal(graph.nodes.b.parent, null);

  assert.equal(disconnect(graph, 'nothing-like-this'), null);
});

// ---- names -----------------------------------------------------------------

test('two nodes cannot share a name, because expressions address layers by name', () => {
  // S6: an expression says thisComp.layer("Source"). Two layers called Source is
  // not untidy, it is an ambiguous expression target.
  const graph = graphOfTwo();
  assert.equal(uniqueName(graph, 'Source'), 'Source 2');
  assert.equal(uniqueName(graph, 'Source', 'a'), 'Source', 'except for the node that has it');
  assert.equal(renameNode(graph, 'b', 'Source'), 'Source 2');
  assert.equal(renameNode(graph, 'b', '   '), 'b', 'an empty name falls back to the id');
});

test('ids are handed out without collisions, since the comment tags carry them', () => {
  const graph = createGraph();
  addNode(graph, { id: 'n1' });
  addNode(graph, { id: 'n2' });
  assert.equal(nextNodeId(graph), 'n3');
  addEdge(graph, { id: 'e1', from: 'n1', to: 'n2' });
  assert.equal(nextEdgeId(graph), 'e2');
});

test('a handle name yields its property, and a malformed one yields nothing', () => {
  assert.equal(propFromHandle('in:opacity'), 'opacity');
  assert.equal(propFromHandle('opacity'), null);
  assert.equal(propFromHandle(undefined), null);
});

// ---- the control -----------------------------------------------------------

test('CONTROL: a view that kept positions out of the model loses them', () => {
  // The alternative design - positions held in React Flow, the graph unaware -
  // passes every rendering test above and fails the only one that matters: a
  // reload. Stated here so the choice is visible rather than assumed.
  const graph = graphOfTwo();
  moveNode(graph, 'a', 900, 400);
  const reloaded = JSON.parse(JSON.stringify(graph));    // what M6 will persist
  assert.deepEqual(toFlowNodes(reloaded)[0].position, { x: 900, y: 400 });

  const panelOnly = JSON.parse(JSON.stringify(graph));
  delete panelOnly.nodes.a.ui;
  assert.deepEqual(toFlowNodes(panelOnly)[0].position, { x: 0, y: 0 },
    'every node stacked at the origin - the arrangement the user spent longest on, gone');
});
