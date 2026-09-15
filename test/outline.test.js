// The outliner's tree, as data. No React involved.
//
// The claim worth testing is not "a tree was built". It is that the tree and
// After Effects' flat layer stack stay the same thing: what the user reads top
// to bottom in the outliner is the order the comp is in, and a drag produces an
// order the tree can redraw.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGraph, addNode, addEdge } from '../src/graph.js';
import { outlineTree, outlineRows, outlineOrder, moveInOutline, subtreeIds } from '../src/outline.js';

function scene() {
  const graph = createGraph('Shot 01');
  addNode(graph, { id: 'bg', kind: 'solid', name: 'Background', order: 1 });
  addNode(graph, { id: 'ctl', kind: 'null', name: 'Controller', order: 2 });
  addNode(graph, { id: 'card', kind: 'solid', name: 'Card', order: 3, parent: 'ctl' });
  addNode(graph, { id: 'title', kind: 'text', name: 'Title', order: 4, parent: 'ctl' });
  return graph;
}

const names = (rows) => rows.map((r) => `${'  '.repeat(r.depth)}${r.name}`);

test('the tree nests by parent and is titled with the composition', () => {
  const groups = outlineTree(scene());
  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, 'comp');
  assert.equal(groups[0].name, 'Shot 01');
  assert.equal(groups[0].count, 4);
  assert.deepEqual(names(outlineRows(groups)), [
    'Shot 01',
    '  Background',
    '  Controller',
    '    Card',
    '    Title',
  ]);
});

test('the rows read top to bottom in the order After Effects holds', () => {
  // The two have to be the same thing, or the outliner is showing an order the
  // comp is not in.
  const groups = outlineTree(scene());
  assert.deepEqual(outlineOrder(groups), ['bg', 'ctl', 'card', 'title']);
});

test('a collapsed row hides its children and nothing else', () => {
  const groups = outlineTree(scene());
  assert.deepEqual(names(outlineRows(groups, new Set(['ctl']))), [
    'Shot 01', '  Background', '  Controller',
  ]);
  assert.deepEqual(names(outlineRows(groups, new Set(['@comp']))), ['Shot 01']);
  const rows = outlineRows(groups);
  assert.equal(rows.find((r) => r.id === 'ctl').hasChildren, true);
  assert.equal(rows.find((r) => r.id === 'card').hasChildren, false);
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
    '    Card',
    '      Gaussian Blur',
    '    Title',
  ]);
  // An effect node's host null is machinery: it is never a layer of its own,
  // and it is not in the stacking order.
  assert.deepEqual(outlineOrder(groups), ['bg', 'ctl', 'card', 'title']);
  // A standalone effect node keeps its id, so clicking the row selects the node
  // the user actually drew.
  const wired = outlineRows(groups).find((r) => r.name === 'Gaussian Blur');
  assert.equal(wired.nodeId, 'blur');
  assert.equal(outlineRows(groups).find((r) => r.name === 'Fill').nodeId, null);
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

test('a drag moves a row, and its children travel with it', () => {
  // The tree nests by parent and the flat order is its walk, so leaving a child
  // behind would print an order the tree could never redraw.
  const groups = outlineTree(scene());
  assert.deepEqual(subtreeIds(groups, 'ctl'), ['ctl', 'card', 'title']);
  assert.deepEqual(moveInOutline(groups, 'ctl', 'bg', { before: true }),
    ['ctl', 'card', 'title', 'bg']);
  assert.deepEqual(moveInOutline(groups, 'bg', 'title', { before: false }),
    ['ctl', 'card', 'title', 'bg']);
  assert.deepEqual(moveInOutline(groups, 'title', 'card', { before: true }),
    ['bg', 'ctl', 'title', 'card']);
});

test('a move that changes nothing, or cannot be made, is refused', () => {
  const groups = outlineTree(scene());
  assert.equal(moveInOutline(groups, 'bg', 'bg'), null, 'onto itself');
  assert.equal(moveInOutline(groups, 'ctl', 'card'), null, 'into its own subtree');
  assert.equal(moveInOutline(groups, 'bg', 'ctl', { before: true }), null,
    'already immediately above it');
  assert.equal(moveInOutline(groups, 'bg', 'nope'), null, 'onto a row that is not there');
  assert.equal(moveInOutline(groups, 'nope', 'bg'), null, 'from a row that is not there');
});

test('a layer whose parent is gone is still shown, not dropped', () => {
  const graph = createGraph('Shot');
  addNode(graph, { id: 'a', kind: 'solid', name: 'Orphan', order: 1, parent: 'missing' });
  const groups = outlineTree(graph);
  assert.deepEqual(names(outlineRows(groups)), ['Shot', '  Orphan']);
  assert.deepEqual(outlineOrder(groups), ['a']);
});

test('a parent cycle in a hand-edited file does not hang the panel', () => {
  // The graph refuses to build one; a .ntl file on disk is not the graph's to
  // vouch for, and an outliner that recursed forever would take the panel down.
  const graph = createGraph('Shot');
  addNode(graph, { id: 'a', kind: 'solid', name: 'A', order: 1 });
  addNode(graph, { id: 'b', kind: 'solid', name: 'B', order: 2 });
  graph.nodes.a.parent = 'b';
  graph.nodes.b.parent = 'a';
  const groups = outlineTree(graph);
  assert.deepEqual(outlineOrder(groups).sort(), ['a', 'b']);
  assert.equal(outlineRows(groups).length, 3);
});

test('an empty graph produces no groups rather than an empty composition', () => {
  assert.deepEqual(outlineTree(createGraph('Shot')), []);
  assert.deepEqual(outlineRows([]), []);
  assert.deepEqual(outlineOrder([]), []);
});

test('an effect node wired to nothing is grouped, not lost', () => {
  // A just-dropped effect node is wired to no layer, so no layer claims it -
  // and it would appear nowhere: drawn on the canvas, absent from the outliner.
  // It gets its own group until it is wired.
  const graph = scene();
  addNode(graph, { id: 'loose', kind: 'effect', name: 'Tint',
    matchName: 'ADBE Tint', props: {} });
  let groups = outlineTree(graph);
  assert.deepEqual(groups.map((g) => g.type), ['comp', 'unwired']);
  const row = outlineRows(groups).find((r) => r.name === 'Tint');
  assert.equal(row.nodeId, 'loose', 'clicking it selects the node the user drew');
  assert.deepEqual(outlineOrder(groups), ['bg', 'ctl', 'card', 'title'],
    'and it is still not in the stacking order');

  // Wire it, and it moves under the layer whose stack it joined.
  addEdge(graph, { id: 'f1', from: 'bg', to: 'loose', kind: 'flow' });
  groups = outlineTree(graph);
  assert.deepEqual(groups.map((g) => g.type), ['comp']);
  assert.deepEqual(names(outlineRows(groups)), [
    'Shot 01', '  Background', '    Tint', '  Controller', '    Card', '    Title',
  ]);
});
