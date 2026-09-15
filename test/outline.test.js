// The outliner's tree, as data. No React involved.
//
// The claim worth testing is that the outliner and After Effects' layer stack
// stay the same thing: every layer is a child of the composition, read top to
// bottom in the order the comp is in, and a drag produces that order back.
//
// Depth means one thing only - a layer under its comp, an effect under the layer
// whose stack it is in. Parenting is NOT nesting here: nesting layers under
// their parents would make the outliner disagree with the timeline about what
// the comp is.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGraph, addNode, addEdge } from '../src/graph.js';
import { outlineTree, outlineRows, outlineOrder, moveInOutline } from '../src/outline.js';

function scene() {
  const graph = createGraph('Shot 01');
  addNode(graph, { id: 'bg', kind: 'solid', name: 'Background', order: 1 });
  addNode(graph, { id: 'ctl', kind: 'null', name: 'Controller', order: 2 });
  addNode(graph, { id: 'card', kind: 'solid', name: 'Card', order: 3, parent: 'ctl' });
  addNode(graph, { id: 'title', kind: 'text', name: 'Title', order: 4, parent: 'ctl' });
  return graph;
}

const names = (rows) => rows.map((r) => `${'  '.repeat(r.depth)}${r.name}`);

test('every layer is a child of the composition, and of nothing else', () => {
  // Two of these layers are parented to Controller. That is a relationship the
  // canvas draws; it is not a position in the stack, and the outliner must not
  // rearrange the stack to express it.
  const groups = outlineTree(scene());
  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, 'comp');
  assert.equal(groups[0].name, 'Shot 01');
  assert.equal(groups[0].count, 4);
  assert.deepEqual(names(outlineRows(groups)), [
    'Shot 01',
    '  Background',
    '  Controller',
    '  Card',
    '  Title',
  ]);
  assert.deepEqual(outlineRows(groups).map((r) => r.depth), [0, 1, 1, 1, 1]);
});

test('the rows read top to bottom in the order After Effects holds', () => {
  const groups = outlineTree(scene());
  assert.deepEqual(outlineOrder(groups), ['bg', 'ctl', 'card', 'title']);
});

test('a parented layer still says so, without being moved for it', () => {
  // Carried as a fact about the row, for a tooltip to use. Losing it entirely
  // would be the other way to get this wrong.
  const rows = outlineRows(outlineTree(scene()));
  assert.equal(rows.find((r) => r.id === 'card').parent, 'ctl');
  assert.equal(rows.find((r) => r.id === 'bg').parent, null);
  // A parent that is gone is not a parent.
  const graph = scene();
  graph.nodes.card.parent = 'missing';
  assert.equal(outlineRows(outlineTree(graph)).find((r) => r.id === 'card').parent, null);
});

test('effects appear under the layer they belong to, inline or wired', () => {
  const graph = scene();
  graph.nodes.bg.effects = [{ matchName: 'ADBE Fill', name: 'Fill', params: {} }];
  addNode(graph, { id: 'blur', kind: 'effect', name: 'Gaussian Blur',
    matchName: 'ADBE Gaussian Blur 2', props: { 'ADBE Gaussian Blur 2-0001': 10 } });
  addEdge(graph, { id: 'f1', from: 'card', to: 'blur', kind: 'flow' });

  const groups = outlineTree(graph);
  assert.deepEqual(names(outlineRows(groups)), [
    'Shot 01',
    '  Background',
    '    Fill',
    '  Controller',
    '  Card',
    '    Gaussian Blur',
    '  Title',
  ]);
  // An effect node's host null is machinery: never a layer of its own, and not
  // in the stacking order.
  assert.deepEqual(outlineOrder(groups), ['bg', 'ctl', 'card', 'title']);
  // A standalone effect node keeps its id, so clicking the row selects the node
  // the user actually drew.
  const rows = outlineRows(groups);
  assert.equal(rows.find((r) => r.name === 'Gaussian Blur').nodeId, 'blur');
  assert.equal(rows.find((r) => r.name === 'Fill').nodeId, null);
  assert.equal(rows.find((r) => r.name === 'Fill').parentId, 'bg');
});

test('a collapsed row hides its children and nothing else', () => {
  const graph = scene();
  graph.nodes.bg.effects = [{ matchName: 'ADBE Fill', name: 'Fill', params: {} }];
  const groups = outlineTree(graph);
  assert.deepEqual(names(outlineRows(groups, new Set(['bg']))), [
    'Shot 01', '  Background', '  Controller', '  Card', '  Title',
  ]);
  assert.deepEqual(names(outlineRows(groups, new Set(['@comp']))), ['Shot 01']);
  const rows = outlineRows(groups);
  assert.equal(rows.find((r) => r.id === 'bg').hasChildren, true);
  assert.equal(rows.find((r) => r.id === 'ctl').hasChildren, false,
    'a layer with no effects has nothing to expand, parented children included');
});

test('expression nodes are their own group, outside the stacking order', () => {
  // They are not layers. Listing them among things that are would imply they
  // have a position in the comp.
  const graph = scene();
  addNode(graph, { id: 'x', kind: 'expression', name: 'Wiggle', expression: 'wiggle(2,10)' });
  const groups = outlineTree(graph);
  assert.deepEqual(groups.map((g) => g.type), ['comp', 'logic']);
  assert.deepEqual(names(outlineRows(groups)).slice(-2), ['Expressions', '  Wiggle']);
  assert.deepEqual(outlineOrder(groups), ['bg', 'ctl', 'card', 'title']);
});

test('an effect node wired to nothing is grouped, not lost', () => {
  // A just-dropped effect node is wired to no layer, so no layer claims it -
  // and it would appear nowhere: drawn on the canvas, absent from the outliner.
  const graph = scene();
  addNode(graph, { id: 'loose', kind: 'effect', name: 'Tint',
    matchName: 'ADBE Tint', props: {} });
  let groups = outlineTree(graph);
  assert.deepEqual(groups.map((g) => g.type), ['comp', 'unwired']);
  assert.equal(outlineRows(groups).find((r) => r.name === 'Tint').nodeId, 'loose');
  assert.deepEqual(outlineOrder(groups), ['bg', 'ctl', 'card', 'title'],
    'and it is still not in the stacking order');

  // Wire it, and it moves under the layer whose stack it joined.
  addEdge(graph, { id: 'f1', from: 'bg', to: 'loose', kind: 'flow' });
  groups = outlineTree(graph);
  assert.deepEqual(groups.map((g) => g.type), ['comp']);
  assert.deepEqual(names(outlineRows(groups)), [
    'Shot 01', '  Background', '    Tint', '  Controller', '  Card', '  Title',
  ]);
});

test('a drag moves one row, and takes nothing with it', () => {
  // Nothing is nested under a layer, so nothing travels with it - including the
  // layers parented to it, which keep their own places in the stack.
  const groups = outlineTree(scene());
  assert.deepEqual(moveInOutline(groups, 'ctl', 'bg', { before: true }),
    ['ctl', 'bg', 'card', 'title']);
  assert.deepEqual(moveInOutline(groups, 'bg', 'title', { before: false }),
    ['ctl', 'card', 'title', 'bg']);
  assert.deepEqual(moveInOutline(groups, 'title', 'card', { before: true }),
    ['bg', 'ctl', 'title', 'card']);
});

test('a move that changes nothing, or cannot be made, is refused', () => {
  const groups = outlineTree(scene());
  assert.equal(moveInOutline(groups, 'bg', 'bg'), null, 'onto itself');
  assert.equal(moveInOutline(groups, 'bg', 'ctl', { before: true }), null,
    'already immediately above it');
  assert.equal(moveInOutline(groups, 'ctl', 'bg', { before: false }), null,
    'already immediately below it');
  assert.equal(moveInOutline(groups, 'bg', 'nope'), null, 'onto a row that is not there');
  assert.equal(moveInOutline(groups, 'nope', 'bg'), null, 'from a row that is not there');
});

test('a parent cycle in a hand-edited file is simply not a hierarchy', () => {
  // The graph refuses to build one, and a .ntl file on disk is not the graph's
  // to vouch for. With nothing nested there is nothing to recurse into, which
  // is the quiet benefit of a flat outliner.
  const graph = createGraph('Shot');
  addNode(graph, { id: 'a', kind: 'solid', name: 'A', order: 1 });
  addNode(graph, { id: 'b', kind: 'solid', name: 'B', order: 2 });
  graph.nodes.a.parent = 'b';
  graph.nodes.b.parent = 'a';
  const groups = outlineTree(graph);
  assert.deepEqual(outlineOrder(groups), ['a', 'b']);
  assert.equal(outlineRows(groups).length, 3);
});

test('an empty graph produces no groups rather than an empty composition', () => {
  assert.deepEqual(outlineTree(createGraph('Shot')), []);
  assert.deepEqual(outlineRows([]), []);
  assert.deepEqual(outlineOrder([]), []);
});
