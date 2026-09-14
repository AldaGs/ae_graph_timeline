// Offline tests for the reconciler's read half. No After Effects involved.
//
// Every case here encodes a rule that a P0 spike paid for. Where that is so,
// the spike is named - so if a rule is ever changed, the evidence that produced
// it is one grep away.
//
//   node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGraph, addNode, addEdge, tagFor, expressionFor, expressionBody } from '../src/graph.js';
import { buildEffectFlowIndex, diff, valueEquals, propertyEquals } from '../src/diff.js';

test('AE neutral third transform components do not create perpetual writes', () => {
  assert.equal(propertyEquals('position', [960, 540], [960, 540, 0]), true);
  assert.equal(propertyEquals('scale', [100, 100], [100, 100, 100]), true);
  assert.equal(propertyEquals('position', [960, 540], [960, 540, 10]), false);
  assert.equal(propertyEquals('color', [1, 1], [1, 1, 0]), false);
});

// ---- helpers ---------------------------------------------------------------

let nativeId = 1000;
const layer = (over = {}) => ({
  nativeId: nativeId++,
  index: 1,
  name: 'layer',
  comment: '',
  parentTag: null,
  props: { opacity: 100, position: [960, 540] },
  expressions: {},
  ...over,
});

const managed = (nodeId, over = {}) => layer({ comment: tagFor(nodeId), name: nodeId, ...over });

const comp = (layers) => ({ compName: 'test', layers });

const opsOf = (result, kind) => result.ops.filter((o) => o.op === kind);

// ---- value comparison ------------------------------------------------------

test('float comparison tolerates AE round-trip noise', () => {
  assert.ok(valueEquals(100, 100.0000000001));
  assert.ok(valueEquals([960, 540], [960.0000000001, 540]));
  assert.ok(!valueEquals(100, 100.1));
  assert.ok(!valueEquals([960, 540], [960, 541]));
  assert.ok(!valueEquals([960, 540], [960, 540, 0]));
});

test('effect controller hosts do not introduce a perpetual layer reorder', () => {
  const g = createGraph();
  addNode(g, { id: 'a', name: 'a', props: {} });
  addNode(g, { id: 'fx', kind: 'effect', name: 'fx', matchName: 'ADBE Fill', props: {} });
  const result = diff(g, comp([managed('fx', { props: {} }), managed('a', { props: {} })]));
  assert.equal(opsOf(result, 'reorder').length, 0);
});

test('flow indexing handles a deep chain without recursion or copied trails', () => {
  const graph = { nodes: {}, edges: {} };
  for (let i = 0; i < 12000; i++) {
    graph.nodes[i] = { id: String(i), kind: 'effect', matchName: 'ADBE Fill' };
    if (i) graph.edges[i] = { id: String(i), kind: 'flow', from: String(i - 1), to: String(i) };
  }
  assert.equal(buildEffectFlowIndex(graph).errors.length, 0);
});

// ---- creates and deletes ---------------------------------------------------

test('a node with no layer is created', () => {
  const g = createGraph();
  addNode(g, { id: 'n1', name: 'BG', props: { opacity: 100 } });
  const r = diff(g, comp([]));
  assert.equal(opsOf(r, 'createLayer').length, 1);
  assert.equal(opsOf(r, 'createLayer')[0].node, 'n1');
});

test('a managed layer with no node is deleted', () => {
  const g = createGraph();
  const r = diff(g, comp([managed('gone')]));
  assert.equal(opsOf(r, 'deleteLayer').length, 1);
  assert.equal(opsOf(r, 'deleteLayer')[0].node, 'gone');
});

test('UNTAGGED layers are never touched — they belong to the user', () => {
  // Wall 2 / S3: tagged = ours, untagged = theirs. The single most important
  // rule in the reconciler; violating it destroys the user's own work.
  const g = createGraph();
  const r = diff(g, comp([
    layer({ name: 'user drew this', comment: '' }),
    layer({ name: 'and this', comment: 'just a note' }),
  ]));
  assert.equal(r.ops.length, 0);
  assert.equal(r.stats.untaggedLayers, 2);
});

// ---- properties ------------------------------------------------------------

test('only changed properties are written', () => {
  const g = createGraph();
  addNode(g, { id: 'n1', name: 'n1', props: { opacity: 50, position: [960, 540] } });
  const r = diff(g, comp([managed('n1', { props: { opacity: 100, position: [960, 540] } })]));
  const sets = opsOf(r, 'setProp');
  assert.equal(sets.length, 1);
  assert.equal(sets[0].prop, 'opacity');
  assert.equal(sets[0].to, 50);
});

test('a clean graph produces an empty patch', () => {
  // S4 measured the clean pass at 6.3 ms for 200 properties; it runs constantly,
  // so it must emit nothing at all when nothing differs.
  const g = createGraph();
  addNode(g, { id: 'n1', name: 'n1', props: { opacity: 100, position: [960, 540] } });
  const r = diff(g, comp([managed('n1')]));
  assert.equal(r.ops.length, 0);
  assert.equal(r.warnings.length, 0);
});

test('a rename is emitted, and before any expression is written', () => {
  // Expressions address layers BY NAME, so names must be final first.
  const g = createGraph();
  addNode(g, { id: 'a', name: 'NEW NAME', props: {} });
  addNode(g, { id: 'b', name: 'b', props: {} });
  addEdge(g, { id: 'e1', from: 'a', to: 'b', toProp: 'position' });
  const r = diff(g, comp([managed('a', { name: 'OLD NAME' }), managed('b')]));
  const names = r.ops.findIndex((o) => o.op === 'setName');
  const exprs = r.ops.findIndex((o) => o.op === 'setExpression');
  assert.ok(names >= 0 && exprs >= 0);
  assert.ok(names < exprs, 'setName must be ordered before setExpression');
});

// ---- expression edges ------------------------------------------------------

test('an edge writes a tagged expression on the target property', () => {
  const g = createGraph();
  addNode(g, { id: 'a', name: 'Source', props: {} });
  addNode(g, { id: 'b', name: 'Target', props: {} });
  addEdge(g, { id: 'e1', from: 'a', to: 'b', fromProp: '.transform.position', toProp: 'position' });
  const r = diff(g, comp([managed('a', { name: 'Source' }), managed('b', { name: 'Target' })]));
  const set = opsOf(r, 'setExpression');
  assert.equal(set.length, 1);
  assert.match(set[0].text, /^\/\/ ntl:edge:e1\n/);
  assert.match(set[0].text, /thisComp\.layer\("Source"\)\.transform\.position/);
});

test('an expression edge suppresses writing that property as a value', () => {
  // The expression IS the value. Writing it too would be pointless churn and
  // would be recomputed away on the next frame.
  const g = createGraph();
  addNode(g, { id: 'a', name: 'A', props: {} });
  addNode(g, { id: 'b', name: 'B', props: { position: [0, 0] } });
  addEdge(g, { id: 'e1', from: 'a', to: 'b', toProp: 'position' });
  const r = diff(g, comp([managed('a', { name: 'A' }), managed('b', { name: 'B' })]));
  assert.equal(opsOf(r, 'setProp').filter((o) => o.prop === 'position').length, 0);
});

test('a hand-written expression is never overwritten', () => {
  // Ownership is detectable because the graph tags what it authors. Anything
  // untagged is the user's, exactly as with layers.
  const g = createGraph();
  addNode(g, { id: 'a', name: 'A', props: {} });
  addNode(g, { id: 'b', name: 'B', props: {} });
  addEdge(g, { id: 'e1', from: 'a', to: 'b', toProp: 'position' });
  const r = diff(g, comp([
    managed('a', { name: 'A' }),
    managed('b', { name: 'B', expressions: { position: 'wiggle(2,30)' } }),
  ]));
  assert.equal(opsOf(r, 'setExpression').length, 0);
  assert.equal(r.warnings.filter((w) => w.kind === 'userExpression').length, 1);
});

test('removing an edge clears the expression it wrote — and only that one', () => {
  const g = createGraph();
  addNode(g, { id: 'b', name: 'B', props: {} });
  const r = diff(g, comp([managed('b', {
    name: 'B',
    expressions: {
      position: expressionFor('e1', expressionBody('A', '.transform.position')),
      opacity: 'wiggle(2,30)', // the user's — must survive
    },
  })]));
  const cleared = opsOf(r, 'clearExpression');
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].prop, 'position');
});

test('two edges onto one property is reported, not silently resolved', () => {
  const g = createGraph();
  addNode(g, { id: 'a', name: 'A', props: {} });
  addNode(g, { id: 'a2', name: 'A2', props: {} });
  addNode(g, { id: 'b', name: 'B', props: {} });
  addEdge(g, { id: 'e1', from: 'a', to: 'b', toProp: 'position' });
  addEdge(g, { id: 'e2', from: 'a2', to: 'b', toProp: 'position' });
  const r = diff(g, comp([managed('a', { name: 'A' }), managed('a2', { name: 'A2' }), managed('b', { name: 'B' })]));
  assert.equal(r.warnings.filter((w) => w.kind === 'edgeConflict').length, 1);
});

// ---- duplicates ------------------------------------------------------------

test('a duplicated layer is detected, and the original is kept', () => {
  // S3: the copy carries the same comment tag but gets its own native id, so
  // the pair of carriers distinguishes original from copy. Neither alone can.
  const g = createGraph();
  const n = addNode(g, { id: 'n1', name: 'n1', props: { opacity: 100 } });
  n.nativeId = 7;
  const r = diff(g, comp([
    managed('n1', { nativeId: 7, props: { opacity: 100, position: [960, 540] } }),
    managed('n1', { nativeId: 8, props: { opacity: 100, position: [960, 540] } }),
  ]));
  const dup = r.warnings.filter((w) => w.kind === 'duplicate');
  assert.equal(dup.length, 1);
  assert.equal(dup[0].keptNativeId, 7);
  assert.equal(opsOf(r, 'deleteLayer').length, 0, 'a user copy must not be deleted');
});

// ---- ordering --------------------------------------------------------------

test('deletes come last and clears come first', () => {
  const g = createGraph();
  addNode(g, { id: 'keep', name: 'keep', props: {} });
  const r = diff(g, comp([
    managed('keep', { name: 'keep', expressions: { position: expressionFor('dead', 'x') } }),
    managed('remove', { name: 'remove' }),
  ]));
  assert.equal(r.ops[0].op, 'clearExpression');
  assert.equal(r.ops[r.ops.length - 1].op, 'deleteLayer');
});

test('creates precede the parenting that depends on them', () => {
  const g = createGraph();
  addNode(g, { id: 'parent', name: 'parent', props: {} });
  addNode(g, { id: 'child', name: 'child', parent: 'parent', props: {} });
  const r = diff(g, comp([managed('child', { name: 'child' })]));
  const create = r.ops.findIndex((o) => o.op === 'createLayer');
  const parent = r.ops.findIndex((o) => o.op === 'setParent');
  assert.ok(create >= 0 && parent >= 0);
  assert.ok(create < parent);
});

// ---- M2: effects and blend modes -------------------------------------------

test('effects are added, removed, and params diffed', () => {
  const g = createGraph();
  addNode(g, { id: 'n1', name: 'n1', props: {} });
  
  // M3: effects are separate nodes connected via flow edges
  addNode(g, { 
    id: 'fx1', 
    kind: 'effect', 
    matchName: 'ADBE Fill', 
    props: { 'ADBE Fill-0002': [1, 0, 0, 1] } 
  });
  addNode(g, { 
    id: 'fx2', 
    kind: 'effect', 
    matchName: 'ADBE Gaussian Blur 2', 
    props: { 'ADBE Gaussian Blur 2-0001': 10 } 
  });

  // Chain them: n1 -> fx1 -> fx2
  g.edges['e1'] = { id: 'e1', from: 'n1', to: 'fx1', kind: 'flow' };
  g.edges['e2'] = { id: 'e2', from: 'fx1', to: 'fx2', kind: 'flow' };

  const r = diff(g, comp([
    managed('n1', {
      name: 'n1',
      effects: [
        { matchName: 'ADBE Fill', params: { 'ADBE Fill-0002': [0, 1, 0, 1] } }, // color differs
        { matchName: 'ADBE Tint', params: {} }, // unexpected effect, but within wantEffects length so it's a mismatch
        { matchName: 'ADBE Invert', params: {} } // 3rd effect, triggers extraEffects warning
      ]
    })
  ]));

  assert.equal(r.ops.length, 4);
  
  assert.equal(r.ops[0].op, 'createLayer');
  assert.equal(r.ops[0].node, 'fx1');
  assert.equal(r.ops[1].op, 'createLayer');
  assert.equal(r.ops[1].node, 'fx2');
  
  assert.equal(r.ops[2].op, 'addEffect');
  assert.equal(r.ops[2].index, 2);
  assert.equal(r.ops[2].matchName, 'ADBE Gaussian Blur 2');
  
  assert.equal(r.ops[3].op, 'linkEffectToHost');
  assert.equal(r.ops[3].effectIndex, 1);
  assert.equal(r.ops[3].hostName, 'fx1');

  // M2: extra effects are warned about, not removed
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].kind, 'extraEffects');
});

test('blend mode changes are diffed', () => {
  const g = createGraph();
  addNode(g, { id: 'n1', name: 'n1', props: {}, blendMode: 'multiply' });

  const r = diff(g, comp([
    managed('n1', { name: 'n1', blendMode: 'normal' })
  ]));

  assert.equal(r.ops.length, 1);
  assert.equal(r.ops[0].op, 'setBlendMode');
  assert.equal(r.ops[0].to, 'multiply');
});

test('effect flow indexing reports branches and cycles instead of choosing silently', () => {
  const g = createGraph();
  addNode(g, { id: 'layer', props: {} });
  addNode(g, { id: 'fx1', kind: 'effect', matchName: 'ADBE Fill' });
  addNode(g, { id: 'fx2', kind: 'effect', matchName: 'ADBE Tint' });
  g.edges.a = { id: 'a', from: 'layer', to: 'fx1', kind: 'flow' };
  g.edges.b = { id: 'b', from: 'layer', to: 'fx2', kind: 'flow' };
  let index = buildEffectFlowIndex(g);
  assert.equal(index.errors[0].kind, 'flowBranch');
  assert.deepEqual(index.effectsFor('layer'), []);

  g.edges = {
    a: { id: 'a', from: 'layer', to: 'fx1', kind: 'flow' },
    b: { id: 'b', from: 'fx1', to: 'fx2', kind: 'flow' },
    c: { id: 'c', from: 'fx2', to: 'fx1', kind: 'flow' },
  };
  index = buildEffectFlowIndex(g);
  assert.ok(index.errors.some((error) => error.kind === 'flowCycle'));
  assert.doesNotThrow(() => index.effectsFor('layer'));
});

test('effect flow indexing is built once and walks a large chain linearly', () => {
  const g = createGraph();
  addNode(g, { id: 'layer', props: {} });
  let previous = 'layer';
  for (let i = 0; i < 1000; i++) {
    const id = `fx${i}`;
    addNode(g, { id, kind: 'effect', matchName: `ADBE Test ${i}` });
    g.edges[`flow${i}`] = { id: `flow${i}`, from: previous, to: id, kind: 'flow' };
    previous = id;
  }
  const index = buildEffectFlowIndex(g);
  assert.equal(index.errors.length, 0);
  assert.equal(index.effectsFor('layer').length, 1000);
});
