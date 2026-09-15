// M4.9 — the selection bridge, against the real jsx/select.jsx in a VM.
//
// The claim under test is not "a string was built". It is that selecting a node
// leaves After Effects with exactly the layer the user pointed at selected, so
// that AE's own Effect Controls and Properties panels have something to follow -
// and that it does so without taking an undo entry or touching a layer the graph
// does not own.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeAE } from './fake-ae.js';
import { createGraph, addNode, tagFor } from '../src/graph.js';
import {
  selectionTagsFor, selectLayersCall, parseSelection, showEffectControlsCall, SelectError,
} from '../src/select.js';

function scene() {
  const ae = makeAE();
  const a = ae.comp.add('Source', { comment: tagFor('a') });
  const b = ae.comp.add('Target', { comment: tagFor('b') });
  const theirs = ae.comp.add('THE USER LAYER', { comment: 'notes about this layer' });

  const graph = createGraph();
  addNode(graph, { id: 'a', name: 'Source', nativeId: a.id, props: { opacity: 100 } });
  addNode(graph, { id: 'b', name: 'Target', nativeId: b.id, props: { opacity: 100 } });
  return { ae, graph, a, b, theirs };
}

const select = (ae, graph, ids, opts = {}) => parseSelection(ae.eval(
  selectLayersCall(selectionTagsFor(graph, ids), { compId: ae.comp.id, ...opts })));

test('selecting a node selects its layer, and only its layer', () => {
  const { ae, graph, a, b } = scene();
  const r = select(ae, graph, ['a']);
  assert.equal(r.selected, 1);
  assert.equal(a.selected, true);
  assert.equal(b.selected, false);
  // AE's Effect Controls follows the selection, so this is the whole mechanism
  // by which a node's effects become reachable in the application.
  assert.deepEqual(ae.undo.groups, [], 'selection is view state: no undo entry');
});

test('selecting a different node clears the previous one', () => {
  const { ae, graph, a, b } = scene();
  select(ae, graph, ['a']);
  const r = select(ae, graph, ['b']);
  assert.equal(a.selected, false);
  assert.equal(b.selected, true);
  assert.equal(r.cleared, 1);
});

test("a layer the graph does not own is never deselected by us", () => {
  // They did not ask the graph to manage it, so a selection the graph had no
  // part in making is not the graph's to take away.
  const { ae, graph, theirs, a } = scene();
  theirs.selected = true;
  select(ae, graph, ['a']);
  assert.equal(theirs.selected, true, "the user's own selection survived");
  assert.equal(a.selected, true);
});

test('a node with no layer behind it selects nothing rather than clearing', () => {
  // An expression node is not a layer, and a layer node whose layer the next
  // patch has yet to create has nothing to point at. Deselecting everything
  // because the user clicked one of those is a worse answer than doing nothing.
  const { ae, graph, a } = scene();
  addNode(graph, { id: 'x', kind: 'expression', name: 'Expr x', expression: 'value;' });
  addNode(graph, { id: 'fresh', name: 'Not written yet', props: { opacity: 100 } });

  assert.deepEqual(selectionTagsFor(graph, ['x']), []);
  assert.deepEqual(selectionTagsFor(graph, ['fresh']), []);
  assert.deepEqual(selectionTagsFor(graph, ['a']), ['a']);
  assert.deepEqual(selectionTagsFor(graph, [null]), []);

  a.selected = true;
  const r = select(ae, graph, ['x']);
  assert.equal(r.selected, 0);
  assert.equal(r.cleared, 1, 'an empty selection still clears our own layers');
});

test('an effect node resolves to the host layer carrying its effect', () => {
  // The null the reconciler creates to carry a standalone effect IS the layer
  // whose Effect Controls holds it.
  const { ae, graph } = scene();
  const host = ae.comp.add('Blur n3', { comment: tagFor('n3'), kind: 'null' });
  addNode(graph, { id: 'n3', kind: 'effect', name: 'Blur n3', nativeId: host.id,
    matchName: 'ADBE Gaussian Blur 2', props: { 'ADBE Gaussian Blur 2-0001': 10 } });
  const r = select(ae, graph, ['n3']);
  assert.equal(r.selected, 1);
  assert.equal(host.selected, true);
});

test('selection is refused when the comp is not the one being reconciled', () => {
  // Selecting inside a comp the user is not looking at changes what their next
  // keystroke applies to.
  const { ae, graph, a } = scene();
  assert.throws(() => select(ae, graph, ['a'], { compId: ae.comp.id + 99 }),
    /active composition is not the one being reconciled/);
  assert.equal(a.selected, false, 'nothing was selected on the way to the refusal');
});

test('a node id cannot escape the literal it is written into', () => {
  // A node id is written into the host call as a string literal, so an id that
  // could close its own literal would be an injection into After Effects, not
  // merely a bad selection. Proven by running it: the call is evaluated for
  // real and the project is still standing afterwards.
  const { ae, graph, a } = scene();
  const hostile = 'a");app.project.close();//';
  addNode(graph, { id: hostile, name: 'Hostile', nativeId: 999 });

  const source = selectLayersCall(selectionTagsFor(graph, [hostile]), { compId: ae.comp.id });
  assert.match(source, /\\"/, 'the quote was escaped rather than passed through');

  const r = parseSelection(ae.eval(source));
  assert.equal(r.selected, 0, 'no layer carries that tag');
  assert.equal(ae.comp.numLayers, 3, 'the comp is intact');
  assert.equal(a.selected, false);
});

test('a reply that is not a selection is refused, not assumed to have worked', () => {
  assert.throws(() => parseSelection('EvalScript error.'), SelectError);
  assert.throws(() => parseSelection('{"ok":false,"message":"no active composition"}'),
    /no active composition/);
});

test('Effect Controls is brought forward by an explicit action, never a click', () => {
  const ae = makeAE();
  assert.equal(parseSelection(ae.eval(showEffectControlsCall())).ok, true);
  assert.deepEqual(ae.app.commands, [2163]);
  assert.deepEqual(ae.undo.groups, []);
});
