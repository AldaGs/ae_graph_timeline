// Offline tests for P1.5's coalesced write loop.
//
// These drive the whole reconciler end to end: mutate a plain JS graph, and the
// REAL jsx/reader.jsx and jsx/patch.jsx - running in a VM against the fake After
// Effects - change a comp. What is being tested is the sequencing, and one claim
// above all others, from S5: the undo stack holds 99 entries, so a gesture must
// cost ONE of them no matter how many times the graph was mutated during it.
//
// The clock is injected. A test that waited on a real debounce would be slow and,
// worse, flaky in exactly the place where a race would hide.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeAE } from './fake-ae.js';
import { createWriteLoop, LoopError } from '../src/loop.js';
import { createDriftGuard } from '../src/drift.js';
import { createGraph, addNode, addEdge, tagFor } from '../src/graph.js';

// A clock the test owns. tick() runs every timer whose deadline has passed, so a
// debounce that was restarted really does have to wait again.
function fakeTimer() {
  let now = 0;
  let next = 1;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    async tick(ms) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) { timers.delete(id); t.fn(); }
      }
      // A flush is several awaited round trips deep, so the queue is drained to
      // the bottom rather than a fixed number of microtasks: a test that asserted
      // half way through a patch would be flaky exactly where a race would hide.
      await drain();
    },
    get pending() { return timers.size; },
  };
}

// Let every pending microtask and immediate run. setImmediate fires after the
// microtask queue is empty, so two of them bracket any promise chain that does
// not itself wait on a timer.
const drain = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

// A comp with two of our layers and one of the user's, and a graph that agrees
// with it - so a first pass is clean and every later change is the test's.
function setup({ guard, debounceMs = 60, onDrift } = {}) {
  const ae = makeAE();
  ae.comp.add('Source', { comment: tagFor('a') });
  ae.comp.add('Target', { comment: tagFor('b') });
  ae.comp.add('THE USER LAYER', { comment: 'notes about this layer' });

  const graph = createGraph();
  addNode(graph, { id: 'a', name: 'Source', props: { opacity: 100, position: [960, 540] } });
  addNode(graph, { id: 'b', name: 'Target', props: { opacity: 100 } });

  const timer = fakeTimer();
  const events = [];
  const loop = createWriteLoop({
    host: ae.host, graph, debounceMs, timer,
    guard: guard ?? createDriftGuard(onDrift ? { onDrift } : undefined),
  });
  loop.on((e) => events.push(e));
  return { ae, graph, loop, timer, events };
}

const types = (events) => events.map((e) => e.type);

// ---- coalescing: the whole reason this file exists -------------------------

test('a burst of mutations costs ONE patch and ONE undo entry', async () => {
  // The failure this prevents: 40 frames of dragging, 40 patches, and the user's
  // 99-entry undo history gone in under two seconds.
  const { ae, graph, loop, timer } = setup();
  for (let i = 0; i < 40; i++) {
    graph.nodes.a.props.opacity = 100 - i;
    loop.touch('drag opacity');
    await timer.tick(10);     // half the debounce window, every time
  }
  await timer.tick(60);

  assert.equal(loop.stats.touches, 40);
  assert.equal(loop.stats.patches, 1);
  assert.equal(loop.stats.undoEntries, 1);
  assert.deepEqual(ae.undo.groups, ['drag opacity']);
  assert.equal(ae.comp.byTag('a').prop('opacity').value, 61, 'and the LAST value is what landed');
});

test('nothing at all is written while a gesture is open', async () => {
  const { ae, graph, loop, timer } = setup();
  loop.beginGesture('move node A');
  for (let i = 0; i < 10; i++) {
    graph.nodes.a.props.position = [900 + i, 540];
    loop.touch();
    await timer.tick(500);    // far past the debounce; it must not fire
  }
  assert.equal(loop.stats.patches, 0, 'a gesture is not a debounce - it is a hold');
  assert.deepEqual(ae.undo.groups, []);

  await loop.endGesture();
  assert.equal(loop.stats.patches, 1);
  assert.deepEqual(ae.undo.groups, ['move node A']);
  assert.deepEqual([...ae.comp.byTag('a').prop('position').value], [909, 540]);
});

test('nested gestures flush once, at the outermost close', async () => {
  const { ae, graph, loop, timer } = setup();
  loop.beginGesture('compound edit');
  loop.beginGesture('inner');
  graph.nodes.a.props.opacity = 10;
  loop.touch();
  await timer.tick(500);                 // well past the debounce, and still held
  assert.equal((await loop.endGesture()).status, 'nested');
  assert.equal(loop.stats.patches, 0, 'closing an inner gesture writes nothing');
  graph.nodes.b.props.opacity = 20;
  loop.touch();
  await timer.tick(500);
  assert.equal(loop.stats.patches, 0);
  await loop.endGesture();
  assert.equal(loop.stats.patches, 1);
  assert.deepEqual(ae.undo.groups, ['compound edit']);
  assert.equal(ae.comp.byTag('a').prop('opacity').value, 10);
  assert.equal(ae.comp.byTag('b').prop('opacity').value, 20);
});

test('gesture() closes its gesture even when the mutation throws', async () => {
  const { loop, graph } = setup();
  await assert.rejects(() => loop.gesture('boom', () => {
    graph.nodes.a.props.opacity = 5;
    loop.touch();
    throw new Error('the panel had a bug');
  }));
  assert.equal(loop.state.gestureDepth, 0, 'a gesture left open would freeze the loop forever');
  // The mutation still happened, so the loop is still dirty and the next flush
  // writes it. The graph is the source of truth; a panel bug does not change that.
  await loop.flush();
  assert.equal(loop.stats.patches, 1);
  assert.equal(loop.state.gestureDepth, 0);
});

test('endGesture without beginGesture is an error, not a silent flush', () => {
  const { loop } = setup();
  assert.throws(() => loop.endGesture(), LoopError);
});

test('a pass with nothing to write opens no undo group at all', async () => {
  // An empty group still costs the user one of 99 entries, and reads as
  // "Node Timeline" in their history for a pass that changed nothing.
  const { ae, loop, timer, events } = setup();
  loop.touch();
  await timer.tick(60);
  assert.equal(loop.stats.cleanPasses, 1);
  assert.equal(loop.stats.patches, 0);
  assert.deepEqual(ae.undo.groups, []);
  assert.deepEqual(types(events), ['clean']);
});

test('mutations arriving mid-patch get their own pass, not a race', async () => {
  const { ae, graph, loop, timer } = setup();
  let released;
  const held = new Promise((r) => { released = r; });
  let first = true;
  ae.host.before = async (source) => {
    if (first && source.startsWith('NTL_ApplyPatch')) { first = false; await held; }
  };

  graph.nodes.a.props.opacity = 50;
  loop.touch('first');
  await timer.tick(60);                    // the patch is now in flight, blocked

  graph.nodes.b.props.opacity = 30;
  loop.touch('second');                    // arrives DURING the patch
  assert.equal(loop.stats.patches, 0);

  released();
  await timer.tick(0);
  await timer.tick(60);

  assert.equal(loop.stats.patches, 2, 'two gestures, two patches - never interleaved');
  assert.deepEqual(ae.undo.groups, ['first', 'second']);
  assert.equal(ae.comp.byTag('b').prop('opacity').value, 30);
  assert.equal(ae.undo.open, 0);
  assert.equal(ae.undo.unbalanced, undefined);
});

test('the undo group is closed after every pass, including the failing ones', async () => {
  const { ae, graph, loop } = setup();
  // A keyframed property: the writer refuses it, mid-patch, by throwing.
  ae.comp.byTag('b').prop('opacity').numKeys = 2;
  graph.nodes.a.props.opacity = 44;
  graph.nodes.b.props.opacity = 44;
  loop.touch('a patch that will fail');
  const r = await loop.flush();
  assert.equal(r.status, 'failed');
  assert.equal(ae.undo.open, 0, 'an open group would swallow the user\'s next actions into ours');
  assert.equal(ae.undo.unbalanced, undefined);
});

// ---- the graph reaching After Effects, per P1's done-when -----------------

test('add, retarget, change and delete all reach the comp in one patch each', async () => {
  const { ae, graph, loop } = setup();

  // add a layer
  addNode(graph, { id: 'c', name: 'New Layer', kind: 'solid', props: { opacity: 80 } });
  await loop.gesture('add node C', () => loop.touch());
  assert.ok(ae.comp.byTag('c'), 'the layer exists and carries its tag');
  assert.equal(ae.comp.byTag('c').prop('opacity').value, 80);

  // retarget a parent
  graph.nodes.c.parent = 'a';
  await loop.gesture('parent C to A', () => loop.touch());
  assert.equal(ae.comp.byTag('c').parent, ae.comp.byTag('a'));

  // change a value
  graph.nodes.c.props.opacity = 12;
  await loop.gesture('change C opacity', () => loop.touch());
  assert.equal(ae.comp.byTag('c').prop('opacity').value, 12);

  // an expression edge, which is a relationship rather than a value (S6)
  addEdge(graph, { id: 'e1', from: 'a', to: 'b', toProp: 'position' });
  await loop.gesture('link A to B', () => loop.touch());
  assert.match(ae.comp.byTag('b').prop('position').expression, /ntl:edge:e1/);

  // delete a layer
  delete graph.nodes.c;
  await loop.gesture('delete node C', () => loop.touch());
  if (ae.comp.byTag('c')) console.log('C WAS NOT DELETED!', ae.comp.byTag('c').name);
  assert.equal(ae.comp.byTag('c'), undefined);

  assert.equal(loop.stats.patches, 5, 'one gesture, one patch, one undo entry - five times');
  assert.equal(loop.stats.undoEntries, 5);
  assert.deepEqual(ae.undo.groups, ['add node C', 'parent C to A', 'change C opacity',
                                    'link A to B', 'delete node C']);

  // And the loop settles: a pass with nothing left to do writes nothing.
  await loop.flush({ force: true });
  assert.equal(loop.stats.patches, 5);
  assert.equal(loop.stats.cleanPasses, 1);
});

test("the user's own layer is never touched, however many passes run", async () => {
  const { ae, graph, loop } = setup();
  const theirs = ae.comp._layers.find((l) => l.name === 'THE USER LAYER');
  const before = { name: theirs.name, opacity: theirs.prop('opacity').value, writes: theirs.prop('opacity').writes };
  for (let i = 0; i < 5; i++) {
    graph.nodes.a.props.opacity = 90 - i;
    await loop.gesture(`edit ${i}`, () => loop.touch());
  }
  assert.equal(theirs.name, before.name);
  assert.equal(theirs.prop('opacity').value, before.opacity);
  assert.equal(theirs.prop('opacity').writes, before.writes, 'not one write landed on it');
});

// ---- drift, P1.4 wired in -------------------------------------------------

test('the idle poll costs one revision read and nothing else', async () => {
  const { ae, loop } = setup();
  await loop.flush({ force: true });          // establish a baseline
  ae.host.calls.length = 0;

  const r = await loop.poll();
  assert.equal(r.status, 'clean');
  assert.deepEqual(ae.host.calls, ['NTL_Revision()'], 'no comp read while nothing moved');
});

test('a revision that moved for nothing structural is adopted silently', async () => {
  const { ae, loop, events } = setup();
  await loop.flush({ force: true });
  // Something happened in the project that is not in this comp. This is the case
  // that would otherwise stop the reconciler every few seconds.
  ae.project.revision += 3;
  const r = await loop.poll();
  assert.equal(r.status, 'spurious');
  assert.deepEqual(events.filter((e) => e.type === 'drift'), []);
  // And the next gate is cheap again.
  ae.host.calls.length = 0;
  assert.equal((await loop.poll()).status, 'clean');
  assert.deepEqual(ae.host.calls, ['NTL_Revision()']);
});

test('the user editing one of our layers is reported, and then corrected', async () => {
  const { ae, graph, loop, events } = setup();
  await loop.flush({ force: true });

  ae.comp.byTag('a').prop('opacity').setValue(33);   // the user, behind our back
  const r = await loop.poll();
  assert.equal(r.status, 'drifted');
  assert.deepEqual(r.report.changes.map((c) => c.kind), ['propChanged']);
  assert.ok(events.some((e) => e.type === 'drift' && e.verdict === 'report'));

  // Not blocking, so the graph - still the source of truth - wins on the next pass.
  loop.touch('reconcile');
  await loop.flush();
  assert.equal(ae.comp.byTag('a').prop('opacity').value, 100);
  assert.equal(graph.nodes.a.props.opacity, 100);
});

test('drift that invalidates an identity refuses the write until it is accepted', async () => {
  const { ae, graph, loop, events } = setup();
  await loop.flush({ force: true });

  // The user deleted a layer the graph owns. Patching through that would write
  // into a comp the diff no longer describes.
  ae.comp.byTag('b').remove();
  graph.nodes.a.props.opacity = 15;
  loop.touch('a change we must hold');
  const r = await loop.flush();

  assert.equal(r.status, 'refused');
  assert.equal(loop.stats.patches, 0);
  assert.equal(ae.comp.byTag('a').prop('opacity').value, 100, 'nothing was written');
  assert.ok(loop.held, 'the loop says what stopped it');
  assert.ok(events.some((e) => e.type === 'drift' && e.verdict === 'refused'));

  // A further mutation does not sneak past the hold.
  graph.nodes.a.props.opacity = 16;
  loop.touch();
  assert.equal((await loop.flush()).status, 'held');
  assert.equal(loop.stats.patches, 0);

  // The user has seen it and chooses to go on: the comp becomes the baseline, and
  // the graph is written over it - which here means re-creating the layer.
  await loop.acceptDrift();
  assert.equal(loop.held, null);
  assert.equal(ae.comp.byTag('a').prop('opacity').value, 16);
  assert.ok(ae.comp.byTag('b'), 'the node the graph still holds gets its layer back');
});

test('the pending change can be discarded instead, and the comp left alone', async () => {
  const { ae, graph, loop } = setup();
  await loop.flush({ force: true });
  ae.comp.byTag('b').remove();
  graph.nodes.a.props.opacity = 15;
  loop.touch();
  await loop.flush();

  loop.discardPending();
  assert.equal(loop.held, null);
  assert.equal(loop.state.dirty, false);
  assert.equal((await loop.flush()).status, 'idle');
  assert.equal(ae.comp.byTag('a').prop('opacity').value, 100);
});

test("with onDrift 'report' the loop writes through drift instead of holding", async () => {
  const { ae, graph, loop } = setup({ onDrift: 'report' });
  await loop.flush({ force: true });
  ae.comp.byTag('b').remove();
  graph.nodes.a.props.opacity = 15;
  loop.touch();
  const r = await loop.flush();
  assert.equal(r.status, 'patched');
  assert.equal(ae.comp.byTag('a').prop('opacity').value, 15);
});

// ---- the things the host can do to us ------------------------------------

test('a stale patch is re-read and re-diffed, never re-sent', async () => {
  const { ae, graph, loop } = setup();
  await loop.flush({ force: true });

  // Move the project between our read and our write, once. The revision guard in
  // patch.jsx must refuse, and the loop must go round again rather than replaying
  // ops computed against a comp that no longer exists.
  let bumped = false;
  ae.host.before = async (source) => {
    if (!bumped && source.startsWith('NTL_ApplyPatch')) { bumped = true; ae.project.revision += 1; }
  };
  graph.nodes.a.props.opacity = 21;
  loop.touch('a stale write');
  const r = await loop.flush();

  assert.equal(r.status, 'patched');
  assert.equal(loop.stats.staleRetries, 1);
  assert.equal(loop.stats.patches, 1, 'the refused attempt wrote nothing');
  assert.equal(ae.comp.byTag('a').prop('opacity').value, 21);
});

test('a project that keeps moving is given up on, not retried forever', async () => {
  const { ae, graph, loop, events } = setup();
  await loop.flush({ force: true });
  ae.host.before = async (source) => {
    if (source.startsWith('NTL_ApplyPatch')) ae.project.revision += 1;
  };
  graph.nodes.a.props.opacity = 22;
  loop.touch();
  const r = await loop.flush();
  assert.equal(r.status, 'stale');
  assert.equal(r.gaveUp, true);
  assert.equal(loop.stats.patches, 0);
  assert.ok(events.some((e) => e.type === 'gaveUp'));
});

test('a failed patch is rolled back by its inverse, not by pressing undo', async () => {
  const { ae, graph, loop, events } = setup();
  // Two ops, the second of which the writer refuses. The first must not be left
  // standing: a half-applied patch is a comp the next diff would lie about.
  ae.comp.byTag('b').prop('opacity').numKeys = 2;
  graph.nodes.a.props.opacity = 66;
  graph.nodes.b.props.opacity = 66;
  loop.touch('half a patch');
  const r = await loop.flush();

  assert.equal(r.status, 'failed');
  assert.equal(r.rolledBack, true);
  assert.equal(ae.comp.byTag('a').prop('opacity').value, 100, 'the applied half was put back');
  assert.ok(events.some((e) => e.type === 'failed'));
  assert.equal(loop.stats.rollbacks, 1);
});

test('a read that cannot be trusted is not written from', async () => {
  const { ae, graph, loop, events } = setup();
  // What a lost host actually looks like from the panel: evalScript does not
  // reject, it hands back a string that is not JSON.
  ae.host.before = (source) => (source.startsWith('NTL_ReadComp') ? 'EvalScript error.' : undefined);
  graph.nodes.a.props.opacity = 77;
  loop.touch();
  const r = await loop.flush();

  assert.equal(r.status, 'readFailed');
  assert.equal(loop.stats.patches, 0);
  assert.equal(ae.comp.byTag('a').prop('opacity').value, 100);
  assert.ok(events.some((e) => e.type === 'readFailed'));
  // Still dirty: the graph's change has not been written, so it must not be lost.
  assert.equal(loop.state.dirty, true);

  ae.host.before = null;
  await loop.flush();
  assert.equal(ae.comp.byTag('a').prop('opacity').value, 77);
});

test('a listener that throws does not take the loop with it', async () => {
  const { ae, graph, loop } = setup();
  loop.on(() => { throw new Error('the panel re-rendered badly'); });
  graph.nodes.a.props.opacity = 88;
  loop.touch();
  await loop.flush();
  assert.equal(ae.comp.byTag('a').prop('opacity').value, 88);
});

test('a closed loop writes nothing and leaves no timer behind', async () => {
  const { ae, graph, loop, timer } = setup();
  graph.nodes.a.props.opacity = 5;
  loop.touch();
  await loop.close();
  await timer.tick(1000);
  assert.equal(timer.pending, 0);
  assert.equal(loop.stats.patches, 0);
  assert.equal(ae.comp.byTag('a').prop('opacity').value, 100);
  assert.equal((await loop.flush()).status, 'closed');
});

// ---- the control ---------------------------------------------------------

test('CONTROL: a loop that patched per touch would fail the first test', async () => {
  // Every test above would also pass against a loop that wrote immediately on
  // every mutation - except the coalescing ones. This states that plainly: the
  // same 40 mutations, written eagerly, cost 40 undo entries.
  const { ae, graph, loop } = setup({ debounceMs: 0 });
  for (let i = 1; i <= 40; i++) {
    graph.nodes.a.props.opacity = 100 - i;
    loop.touch('eager');
    await loop.flush();            // what a per-frame writer would do
  }
  assert.equal(ae.undo.groups.length, 40, 'this is the behaviour P1.5 exists to prevent');
  assert.ok(ae.undo.groups.length > loop.stats.patches - 1);
  // 99 is the measured ceiling (S5). Two and a half seconds of dragging at 16 fps.
  assert.ok(ae.undo.groups.length < 99);
});
