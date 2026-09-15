import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAeHistory } from '../panel/src/aeHistory.js';
import { addNode, createGraph, tagFor } from '../src/graph.js';

const comp = (layers, revision) => ({ compId: 1, compName: 'Shot', revision, layers });
const layer = (id, over = {}) => ({
  nativeId: id.charCodeAt(0), index: 1, name: id, comment: tagFor(id), kind: 'solid',
  enabled: true, label: 1, blendMode: 'normal', parentTag: null,
  props: { opacity: 100 }, expressions: {}, effects: [], ...over,
});

test('AE undo and redo are matched against observed checkpoints, not guessed graph state', () => {
  const beforeGraph = createGraph('Shot');
  const afterGraphAtPatch = createGraph('Shot');
  addNode(afterGraphAtPatch, { id: 'a', name: 'a', props: { opacity: 100 } });
  const beforeComp = comp([], 1);

  const history = createAeHistory();
  history.begin({ beforeGraph, afterGraph: afterGraphAtPatch, beforeComp });
  assert.equal(history.state.undo, 0, 'a patch is not history until AE is observed');

  const afterGraphObserved = structuredClone(afterGraphAtPatch);
  afterGraphObserved.nodes.a.nativeId = 97;
  afterGraphObserved.nodes.a.props.anchorPoint = [50, 50];
  const afterComp = comp([layer('a', { nativeId: 97, props: { opacity: 100, anchorPoint: [50, 50] } })], 2);
  history.checkpoint({ afterGraph: afterGraphObserved, afterComp });

  const undo = history.reconcile(comp([], 3));
  assert.equal(undo.direction, 'undo');
  assert.deepEqual(undo.graph, beforeGraph);

  const redo = history.reconcile(comp([layer('a', {
    nativeId: 97, props: { opacity: 100, anchorPoint: [50, 50] },
  })], 4));
  assert.equal(redo.direction, 'redo');
  assert.deepEqual(redo.graph, afterGraphObserved);
});

test('multiple AE undos restore the oldest matching graph and remain redoable', () => {
  const empty = createGraph('Shot');
  const one = createGraph('Shot'); addNode(one, { id: 'a', name: 'a', props: { opacity: 100 } });
  const two = structuredClone(one); addNode(two, { id: 'b', name: 'b', props: { opacity: 100 } });
  const c0 = comp([], 1);
  const c1 = comp([layer('a')], 2);
  const c2 = comp([layer('a'), layer('b', { nativeId: 98, index: 2 })], 3);
  const history = createAeHistory();
  history.begin({ beforeGraph: empty, afterGraph: one, beforeComp: c0 });
  history.checkpoint({ afterGraph: one, afterComp: c1 });
  history.begin({ beforeGraph: one, afterGraph: two, beforeComp: c1 });
  history.checkpoint({ afterGraph: two, afterComp: c2 });

  assert.deepEqual(history.reconcile(comp([], 4)).graph, empty);
  assert.deepEqual(history.reconcile(comp([layer('a')], 5)).graph, one);
});
