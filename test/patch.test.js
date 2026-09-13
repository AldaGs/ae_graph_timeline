// Offline tests for P1.3's patch emitter.
//
// These run the REAL jsx/patch.jsx inside a VM against a fake After Effects, so
// what is under test is the text AE will execute - not a description of it.
// What they cannot prove is that AE behaves like the fake; that is the in-AE
// pass, still owed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeAE } from './fake-ae.js';
import { applyPatchCall, parseReceipt, rollbackCall, toJsxLiteral, jsxString, PatchError } from '../src/patch.js';
import { createGraph, addNode, addEdge, tagFor, expressionFor, expressionBody } from '../src/graph.js';
import { diff } from '../src/diff.js';

const run = (ae, ops, opts = {}) => parseReceipt(ae.eval(applyPatchCall(ops, opts)));

// ---- serialization: this text is SOURCE CODE, not data ---------------------

test('a string cannot escape the literal it is written into', () => {
  assert.equal(jsxString('a"b'), '"a\\"b"');
  assert.equal(jsxString('C:\\x'), '"C:\\\\x"');
  assert.equal(jsxString('a\nb'), '"a\\u000ab"');
  // U+2028 terminates a line in some parsers and is invisible in every editor.
  assert.equal(jsxString('a\u2028b'), '"a\\u2028b"');
});

test('a hostile expression body is inert after serialization', () => {
  // The op travels as executable ExtendScript, so escaping is a boundary, not
  // formatting. Tested by SIDE EFFECT: a substring check would pass on escaped
  // text that never runs, and fail on harmless text that merely looks alarming.
  const ae = makeAE();
  ae.eval('var pwned = false;');
  const nasty = '"); pwned = true; ("';

  const literal = toJsxLiteral({ text: nasty });
  assert.equal(ae.eval(`(${literal}).text`), nasty, 'it round-trips as the same string');
  assert.equal(ae.eval('pwned'), false, 'and nothing in it executed');

  // The same hazard where it actually arrives: an expression body in an op.
  ae.comp.add('A', { comment: tagFor('a') });
  run(ae, [{ op: 'setExpression', node: 'a', prop: 'position', edge: 'e1',
             text: `// ntl:edge:e1
${nasty}` }]);
  assert.equal(ae.eval('pwned'), false);
  assert.ok(ae.comp.byTag('a').prop('position').expression.includes(nasty));
});

test('an unimplemented op is refused here, not discovered in After Effects', () => {
  assert.throws(() => applyPatchCall([{ op: 'reorder', node: 'a' }]),
    (e) => e instanceof PatchError && /not implemented/.test(e.message));
});

// ---- applying --------------------------------------------------------------

test('a property write lands, and costs one undo group', () => {
  // S5: the stack holds 99 entries. One patch must be one entry.
  const ae = makeAE();
  ae.comp.add('A', { comment: tagFor('a') });
  const r = run(ae, [{ op: 'setProp', node: 'a', prop: 'opacity', from: 100, to: 50 }]);

  assert.equal(r.applied, 1);
  assert.equal(ae.comp.byTag('a').prop('opacity').value, 50);
  assert.equal(ae.undo.groups.length, 1);
  assert.equal(ae.undo.open, 0, 'the group must be closed');
  assert.equal(ae.undo.maxOpen, 1, 'never more than one group at a time');
});

test('a hundred writes are still ONE undo group', () => {
  const ae = makeAE();
  const ops = [];
  for (let i = 0; i < 100; i++) {
    ae.comp.add(`L${i}`, { comment: tagFor(`n${i}`) });
    ops.push({ op: 'setProp', node: `n${i}`, prop: 'opacity', to: 42 });
  }
  const r = run(ae, ops);
  assert.equal(r.applied, 100);
  assert.equal(ae.undo.groups.length, 1);
});

test('an empty patch touches nothing and opens no undo group', () => {
  // The common case by far: the diff is clean. It must cost nothing at all.
  const ae = makeAE();
  const r = run(ae, []);
  assert.equal(r.applied, 0);
  assert.equal(ae.undo.groups.length, 0);
});

test('a created layer is tagged in the same undo group that created it', () => {
  const ae = makeAE();
  const r = run(ae, [{ op: 'createLayer', node: 'fresh', kind: 'solid', name: 'BG',
                       props: { opacity: 30 } }]);
  const made = ae.comp.byTag('fresh');
  assert.ok(made, 'an untagged creation would be indistinguishable from the user\'s own layer');
  assert.equal(made.name, 'BG');
  assert.equal(made.prop('opacity').value, 30);
  assert.equal(r.created, 1);
  assert.equal(ae.undo.groups.length, 1);
});

test('an expression edge is written, and its tag makes it ours', () => {
  const ae = makeAE();
  ae.comp.add('Source', { comment: tagFor('a') });
  ae.comp.add('Target', { comment: tagFor('b') });
  const text = expressionFor('e1', expressionBody('Source', '.transform.position'));
  run(ae, [{ op: 'setExpression', node: 'b', prop: 'position', edge: 'e1', text }]);
  assert.equal(ae.comp.byTag('b').prop('position').expression, text);
});

// ---- refusing --------------------------------------------------------------

test('a keyframed property is refused with a sentence, not an AE exception', () => {
  // The graph owns structure and relationships; After Effects keeps keyframes
  // (S6). Writing over a keyframed stream is the boundary being crossed.
  const ae = makeAE();
  const l = ae.comp.add('A', { comment: tagFor('a') });
  l.prop('opacity').numKeys = 4;
  assert.throws(() => run(ae, [{ op: 'setProp', node: 'a', prop: 'opacity', to: 50 }]),
    (e) => /is keyframed/.test(e.message));
});

test('a hand-written expression stops the patch even if the diff let it through', () => {
  // Second check, at the point of writing: the comp may have changed since the
  // read that produced these ops.
  const ae = makeAE();
  ae.comp.add('A', { comment: tagFor('a') });
  const b = ae.comp.add('B', { comment: tagFor('b') });
  b.prop('position').expressionEnabled = true;
  b.prop('position').expression = 'wiggle(2,30)';
  assert.throws(() => run(ae, [{ op: 'setExpression', node: 'b', prop: 'position', edge: 'e1', text: 'x' }]),
    (e) => /hand-written/.test(e.message));
  assert.equal(b.prop('position').expression, 'wiggle(2,30)', 'the user\'s expression survives');
});

test('an ambiguous tag is refused rather than guessed at', () => {
  // S3: a duplicated layer carries the same comment. Writing to the wrong one of
  // the pair is precisely the silent corruption this project exists to avoid.
  const ae = makeAE();
  ae.comp.add('A', { comment: tagFor('a') });
  ae.comp.add('A copy', { comment: tagFor('a') });
  assert.throws(() => run(ae, [{ op: 'setProp', node: 'a', prop: 'opacity', to: 1 }]),
    (e) => /refusing to guess/.test(e.message));
});

test('a stale patch is refused before a single write', () => {
  // S4's revision gate used as a guard: if the project moved between the read
  // and the write, these ops were computed against a comp that no longer exists.
  const ae = makeAE();
  const l = ae.comp.add('A', { comment: tagFor('a') });
  assert.throws(
    () => run(ae, [{ op: 'setProp', node: 'a', prop: 'opacity', to: 7 }],
              { revision: ae.project.revision - 1 }),
    (e) => e instanceof PatchError && e.detail.retryable === true,
  );
  assert.equal(l.prop('opacity').value, 100, 'nothing was written');
  assert.equal(ae.undo.groups.length, 0, 'no undo group was opened');
});

test('parenting to one of the user\'s own layers is never overwritten', () => {
  const ae = makeAE();
  const theirs = ae.comp.add('their null', { comment: '' });
  const ours = ae.comp.add('A', { comment: tagFor('a') });
  ae.comp.add('P', { comment: tagFor('p') });
  ours.parent = theirs;
  assert.throws(() => run(ae, [{ op: 'setParent', node: 'a', from: null, to: 'p' }]),
    (e) => /untagged layer/.test(e.message));
  assert.equal(ours.parent, theirs);
});

// ---- failure leaves a way back ---------------------------------------------

test('a failure mid-patch closes the undo group and returns what to undo', () => {
  const ae = makeAE();
  ae.comp.add('A', { comment: tagFor('a') });
  const b = ae.comp.add('B', { comment: tagFor('b') });
  b.prop('opacity').numKeys = 2;   // op 2 will be refused

  let thrown;
  try {
    run(ae, [
      { op: 'setProp', node: 'a', prop: 'opacity', to: 10 },
      { op: 'setProp', node: 'b', prop: 'opacity', to: 10 },
    ]);
  } catch (e) { thrown = e; }

  assert.ok(thrown instanceof PatchError);
  assert.equal(thrown.detail.failedAt, 1, 'one op applied before the failure');
  assert.equal(ae.undo.open, 0, 'an open group would swallow the user\'s next action');
  assert.ok(!ae.undo.unbalanced);

  // And the way back is re-applying the inverse, not pressing undo.
  assert.equal(ae.comp.byTag('a').prop('opacity').value, 10);
  ae.eval(rollbackCall(thrown.detail));
  assert.equal(ae.comp.byTag('a').prop('opacity').value, 100, 'rolled back to where it started');
});

test('rollback restores names, expressions and creations in reverse order', () => {
  const ae = makeAE();
  const a = ae.comp.add('Original', { comment: tagFor('a'), props: { opacity: 80 } });

  const r = run(ae, [
    { op: 'createLayer', node: 'new', kind: 'solid', name: 'Made', props: {} },
    { op: 'setName', node: 'a', from: 'Original', to: 'Renamed' },
    { op: 'setProp', node: 'a', prop: 'opacity', to: 20 },
    { op: 'setExpression', node: 'a', prop: 'position', edge: 'e1', text: '// ntl:edge:e1\nx' },
  ]);
  assert.equal(r.invertible, true);

  ae.eval(rollbackCall(r));

  assert.equal(a.name, 'Original');
  assert.equal(a.prop('opacity').value, 80);
  assert.equal(a.prop('position').expression, '');
  assert.equal(ae.comp.byTag('new'), undefined, 'the created layer is gone again');
});

test('a patch that deletes a layer reports itself as NOT fully reversible', () => {
  // Re-creating a solid is not restoring the layer that was there: its masks,
  // effects and keyframes are gone. Saying otherwise would be a lie the panel
  // would act on.
  const ae = makeAE();
  ae.comp.add('Doomed', { comment: tagFor('d') });
  const r = run(ae, [{ op: 'deleteLayer', node: 'd', nativeId: 1, name: 'Doomed' }]);
  assert.equal(r.invertible, false);
  assert.equal(ae.comp.byTag('d'), undefined);
});

// ---- the whole pipeline ----------------------------------------------------

test('graph -> diff -> patch -> comp, and the second pass is clean', () => {
  // The loop P1 exists to close. A reconciler that does not converge would
  // re-apply the same patch forever, burning the 99-entry undo stack in seconds.
  const ae = makeAE();
  ae.comp.add('Source', { comment: tagFor('a'), props: { opacity: 100, position: [960, 540] } });
  ae.comp.add('OldName', { comment: tagFor('b'), props: { opacity: 100, position: [0, 0] } });
  ae.comp.add('the user\'s layer', { comment: '' });

  const g = createGraph();
  addNode(g, { id: 'a', name: 'Source', props: { opacity: 100, position: [960, 540] } });
  addNode(g, { id: 'b', name: 'Target', props: { opacity: 25, position: [0, 0] } });
  addEdge(g, { id: 'e1', from: 'a', to: 'b', fromProp: '.transform.position', toProp: 'position' });

  // Read the fake comp into the shape the diff consumes.
  const readState = () => ({
    compName: ae.comp.name,
    layers: ae.comp._layers.map((l) => ({
      nativeId: l.id,
      index: ae.comp._layers.indexOf(l) + 1,
      name: l.name,
      comment: l.comment,
      parentTag: l.parent ? l.parent.comment.replace('ntl:', '') || null : null,
      props: { opacity: l.prop('opacity').value, position: l.prop('position').value },
      expressions: l.prop('position').expression
        ? { position: l.prop('position').expression } : {},
    })),
  });

  const first = diff(g, readState());
  assert.ok(first.ops.length > 0);
  const receipt = run(ae, first.ops, { revision: ae.project.revision });
  assert.equal(receipt.applied, first.ops.length);

  assert.equal(ae.comp.byTag('b').name, 'Target');
  assert.equal(ae.comp.byTag('b').prop('opacity').value, 25);

  const second = diff(g, readState());
  assert.equal(second.ops.length, 0, 'the reconciler must converge in one pass');
  assert.equal(second.warnings.length, 0);
  assert.equal(ae.undo.groups.length, 1, 'one gesture, one undo entry');
});

// ---- M2: effects and blend modes -------------------------------------------

test('M2 patch ops apply effects and blend mode', () => {
  const ae = makeAE();
  ae.comp.add('Target', { comment: tagFor('a') });
  
  const ops = [
    { op: 'setBlendMode', node: 'a', to: 'multiply' },
    { op: 'addEffect', node: 'a', matchName: 'ADBE Fill', index: 1, name: 'My Fill', params: { 'ADBE Fill-0002': [1, 0, 0, 1] } },
    { op: 'setEffect', node: 'a', index: 1, param: 'ADBE Fill-0002', to: [0, 1, 0, 1] },
    { op: 'removeEffect', node: 'a', index: 1 }
  ];
  
  let r = run(ae, [ops[0]]);
  assert.equal(r.ok, true);
  assert.equal(ae.comp.byTag('a').blendingMode, ae.ctx.BlendingMode.MULTIPLY);
  
  r = run(ae, [ops[1]]);
  assert.equal(r.ok, true);
  let fx = ae.comp.byTag('a').property('ADBE Effect Parade').property(1);
  assert.equal(fx.matchName, 'ADBE Fill');
  assert.equal(fx.name, 'My Fill');
  // the mock array value isn't deepEqual-friendly when returned via value, let's just check JSON
  assert.equal(JSON.stringify(fx.property('ADBE Fill-0002').value), JSON.stringify([1, 0, 0, 1]));
  
  r = run(ae, [ops[2]]);
  assert.equal(r.ok, true);
  assert.equal(JSON.stringify(fx.property('ADBE Fill-0002').value), JSON.stringify([0, 1, 0, 1]));
  
  r = run(ae, [ops[3]]);
  assert.equal(r.ok, true);
  assert.equal(ae.comp.byTag('a').property('ADBE Effect Parade').numProperties, 0);
});
