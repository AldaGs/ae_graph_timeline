import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addEdge, addNode, createGraph, tagFor } from '../src/graph.js';
import { captureCompState, classifyDrift, ReconcileError } from '../src/reconcile.js';
import { createDriftGuard } from '../src/drift.js';
import { diff } from '../src/diff.js';
import { parseCompState, readCompCall } from '../src/reader.js';
import { makeAE } from './fake-ae.js';

const layer = (id, over = {}) => ({
  nativeId: over.nativeId ?? id.charCodeAt(0), index: 1, name: id,
  comment: tagFor(id), kind: 'solid', enabled: true, label: 1,
  blendMode: 'normal', parentTag: null, props: { opacity: 100 },
  expressions: {}, effects: [], ...over,
});
const comp = (layers) => ({ compId: 1, compName: 'Shot', revision: 2, layers });

test('comp-wins captures constants, names, order, and deletion without mutating the input', () => {
  const graph = createGraph('Shot');
  addNode(graph, { id: 'a', name: 'Old A', props: { opacity: 100 } });
  addNode(graph, { id: 'b', name: 'B', props: { opacity: 100 } });
  const result = captureCompState(graph, comp([
    layer('b', { index: 1, name: 'Renamed B', props: { opacity: 35 } }),
  ])).graph;
  assert.equal(graph.nodes.b.name, 'B', 'capture is transactional');
  assert.equal(result.nodes.a, undefined);
  assert.equal(result.nodes.b.name, 'Renamed B');
  assert.equal(result.nodes.b.props.opacity, 35);
  assert.equal(result.nodes.b.order, 1);
});

test('comp-wins removes a graph expression edge instead of capturing its evaluated value', () => {
  const graph = createGraph('Shot');
  addNode(graph, { id: 'a', name: 'A', props: { opacity: 100 } });
  addNode(graph, { id: 'b', name: 'B', props: { opacity: 100 } });
  addEdge(graph, { id: 'e1', from: 'a', fromProp: '.transform.opacity', to: 'b', toProp: 'opacity' });
  const result = captureCompState(graph, comp([
    layer('a'),
    layer('b', { props: { opacity: 17 }, expressions: {} }),
  ])).graph;
  assert.equal(result.edges.e1, undefined);
  assert.equal(result.nodes.b.props.opacity, 17, 'after the edge is removed, the AE value becomes the constant');
});

test('comp-wins converges with a shared effect that has non-expression parameters', () => {
  const graph = createGraph('Shot');
  addNode(graph, { id: 'a', name: 'Layer', props: { opacity: 100 } });
  addNode(graph, { id: 'fx', kind: 'effect', name: 'Fill fx', matchName: 'ADBE Fill',
    props: { 'ADBE Fill-0002': [1, 0, 0, 1] } });
  graph.edges.flow = { id: 'flow', from: 'a', to: 'fx', kind: 'flow' };
  const state = comp([
    layer('a', { name: 'Layer', effects: [{
      matchName: 'ADBE Fill', name: 'Fill fx',
      params: { 'ADBE Fill-0001': 0, 'ADBE Fill-0002': [0, 1, 0, 1] },
      expressionParams: ['ADBE Fill-0002'],
      expressions: { 'ADBE Fill-0002': 'thisComp.layer("Fill fx").effect(1)(3)' },
    }] }),
    layer('fx', { kind: 'null', name: 'Fill fx', effects: [{
      matchName: 'ADBE Fill', name: 'Fill fx',
      params: { 'ADBE Fill-0001': 0, 'ADBE Fill-0002': [0, 1, 0, 1] },
      expressionParams: ['ADBE Fill-0002'], expressions: {},
    }] }),
  ]);

  const captured = captureCompState(graph, state);
  assert.deepEqual(captured.graph.nodes.fx.props, { 'ADBE Fill-0002': [0, 1, 0, 1] });
  assert.deepEqual(diff(captured.graph, state).ops, []);
});

test('comp-wins refuses duplicate identities transactionally', () => {
  const graph = createGraph('Shot');
  addNode(graph, { id: 'a', name: 'A', props: { opacity: 100 } });
  assert.throws(() => captureCompState(graph, comp([
    layer('a', { nativeId: 1 }), layer('a', { nativeId: 2 }),
  ])), (error) => error instanceof ReconcileError && /duplicated/.test(error.message));
  assert.equal(graph.nodes.a.name, 'A');
});

// ---- M4.8: a timeline edit is adopted, not escalated to a decision --------

test('an ordinary AE property edit is adopted rather than made a decision', () => {
  // The reported symptom: changing a layer property in the timeline popped up
  // "choose which version is the source of truth" and disabled every control
  // until the user answered.
  const ae = makeAE();
  ae.comp.add('Source', { comment: tagFor('a') });
  const graph = createGraph();
  addNode(graph, { id: 'a', name: 'Source',
    props: { opacity: 100, position: [960, 540] } });

  const before = parseCompState(ae.eval(readCompCall()));
  const guard = createDriftGuard();
  guard.mark(before);

  ae.comp.byTag('a').prop('opacity').setValue(33);      // the user, in AE
  const after = parseCompState(ae.eval(readCompCall()));
  const report = guard.inspect(after);

  assert.deepEqual(report.changes.map((c) => c.kind), ['propChanged']);
  assert.equal(report.blocking.length, 0);
  assert.equal(classifyDrift({ report, compState: after, dirty: false }), 'adopt');

  // And the adoption is representable, so nothing is left pending.
  const captured = captureCompState(graph, after);
  assert.equal(captured.graph.nodes.a.props.opacity, 33);
  assert.deepEqual(diff(captured.graph, after).ops, []);
});

test('drift is a decision when it blocks, or when the graph holds unwritten changes', () => {
  const report = { blocking: [], changes: [{ kind: 'propChanged' }] };
  const compState = { layers: [] };
  assert.equal(classifyDrift({ report, compState, dirty: true }), 'decide',
    'an AE edit on top of unwritten graph changes is a real collision');
  assert.equal(classifyDrift({ report: { blocking: [{ kind: 'vanished' }], changes: [] }, compState }),
    'decide', 'a lost identity can never be adopted through');
  assert.equal(classifyDrift({ report, compState: null }), 'decide',
    'a drift event without a comp state cannot be adopted');
  assert.equal(classifyDrift({}), 'decide');
});
