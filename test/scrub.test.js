// After Effects' numeric fields, as arithmetic.
//
// The point of keeping the feel of a drag in a pure module is that it can be
// tested without a pointer. What is checked here is what a user would notice:
// a drag that goes out and comes back leaves the value where it was, a value
// read out of AE is not snapped to a grid it was never on, and the modifiers
// mean what they mean in After Effects rather than in Blender.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyScrub, clampScrub, decimalsFor, formatScrub, parseScrub, scrubFieldsFor,
  scrubSpecFor, scrubLabelFor, scrubModifiers, stepScrub, withComponent, COARSE, FINE,
} from '../src/scrub.js';

test('dragging right raises a value and dragging left lowers it', () => {
  const spec = scrubSpecFor('position', [960, 540]);
  assert.equal(applyScrub({ start: 960, dx: 40, spec }), 1000);
  assert.equal(applyScrub({ start: 960, dx: -40, spec }), 920);
  assert.equal(applyScrub({ start: 960, dx: 0, spec }), 960);
});

test('a drag that returns to where it began returns the value with it', () => {
  // The reason the arithmetic is written against the value the drag STARTED at
  // rather than the previous frame: accumulating per-frame deltas drifts, and
  // the drift is exactly what a user notices when they waggle the pointer.
  const spec = scrubSpecFor('opacity', 100);
  const start = 50;
  let value = start;
  for (const dx of [3, 11, 40, 7, -20, 0]) value = applyScrub({ start, dx, spec });
  assert.equal(value, start);
});

test('Shift is coarse and Ctrl is fine, as in After Effects', () => {
  // Deliberately not Blender's convention, where Shift is the fine one. This
  // panel is docked in AE and AE's muscle memory is the one that matters.
  const spec = scrubSpecFor('position', [0, 0]);
  assert.equal(applyScrub({ start: 0, dx: 10, spec }), 10);
  assert.equal(applyScrub({ start: 0, dx: 10, spec, shift: true }), 10 * COARSE);
  assert.equal(applyScrub({ start: 0, dx: 10, spec, fine: true }), 10 * FINE);
  assert.equal(COARSE, 10);
  assert.equal(FINE, 0.1);
});

test('a value read out of AE is not snapped to a grid it was never on', () => {
  // AE hands back 669.33332824707. Scrubbing that by one gives 670.333..., not
  // 670: snapping would silently move a value the user did not touch.
  const spec = scrubSpecFor('position', [669.33332824707, 628]);
  const next = applyScrub({ start: 669.33332824707, dx: 1, spec });
  assert.ok(Math.abs(next - 670.33332824707) < 1e-6, `got ${next}`);
});

test('float dust never reaches the graph', () => {
  // 0.1 + 0.2 arithmetic, done a hundred times over a colour channel.
  const spec = scrubSpecFor('ADBE Fill-0002', [1, 0.5, 0, 1]);
  assert.equal(spec.step, 0.01);
  const value = applyScrub({ start: 0.07, dx: 1, spec });
  assert.equal(value, 0.08, 'not 0.08000000000000002');
  assert.equal(applyScrub({ start: 0.3, dx: -1, spec }), 0.29);
});

test('opacity is clamped because its limits are known; a guess never is', () => {
  const opacity = scrubSpecFor('opacity', 100);
  assert.equal(applyScrub({ start: 95, dx: 40, spec: opacity }), 100);
  assert.equal(applyScrub({ start: 5, dx: -40, spec: opacity }), 0);

  // An effect parameter's range is something AE never tells us. Clamping a
  // guess would leave a value the user cannot type their way out of.
  const unknown = scrubSpecFor('ADBE Gaussian Blur 2-0001', 10);
  assert.equal(unknown.min, undefined);
  assert.equal(unknown.max, undefined);
  assert.equal(applyScrub({ start: 0, dx: -500, spec: unknown }), -500);
});

test('known transforms carry their units; an unknown parameter claims none', () => {
  assert.equal(scrubSpecFor('position', [0, 0]).unit, 'px');
  assert.equal(scrubSpecFor('scale', [100, 100]).unit, '%');
  assert.equal(scrubSpecFor('rotation', 0).unit, '°');
  assert.equal(scrubSpecFor('opacity', 100).unit, '%');
  assert.equal(scrubSpecFor('ADBE Tint-0003', 50).unit, '');
});

test('a four-component vector inside 0..1 is scrubbed as a colour', () => {
  assert.deepEqual(scrubSpecFor('ADBE Fill-0002', [1, 0.5, 0, 1]).axes, ['R', 'G', 'B', 'A']);
  // Four components that are not all inside 0..1 are not a colour.
  assert.equal(scrubSpecFor('whatever', [10, 20, 30, 40]).step, 1);
  // A lone small number is being measured in something small.
  assert.equal(scrubSpecFor('whatever', 0.4).step, 0.01);
  assert.equal(scrubSpecFor('whatever', 0).step, 1, 'zero says nothing about scale');
});

test('a vector becomes one field per component, labelled as AE labels them', () => {
  // "960, 540" in a single box is a text field pretending to be two numbers,
  // and it cannot be dragged.
  const fields = scrubFieldsFor('position', [960, 540]);
  assert.deepEqual(fields.map((f) => f.axis), ['X', 'Y']);
  assert.deepEqual(fields.map((f) => f.value), [960, 540]);
  assert.deepEqual(scrubFieldsFor('position', [1, 2, 3]).map((f) => f.axis), ['X', 'Y', 'Z']);
  assert.deepEqual(scrubFieldsFor('ADBE Fill-0002', [1, 0, 0, 1]).map((f) => f.axis),
    ['R', 'G', 'B', 'A']);

  const scalar = scrubFieldsFor('opacity', 100);
  assert.equal(scalar.length, 1);
  assert.equal(scalar[0].index, null, 'a scalar has no component to address');
  assert.equal(scalar[0].axis, null);
});

test('one component changing produces the whole property value', () => {
  assert.deepEqual(withComponent([960, 540], 1, 600), [960, 600]);
  assert.equal(withComponent(100, null, 50), 50, 'a scalar is replaced outright');
  assert.deepEqual(withComponent([1, 2], 0, 9), [9, 2]);
  // The original is not mutated: the graph's value is not the editor's to hold.
  const value = [1, 2];
  withComponent(value, 0, 9);
  assert.deepEqual(value, [1, 2]);
});

test('the keyboard moves a value the way the pointer does', () => {
  const spec = scrubSpecFor('rotation', 0);
  assert.equal(stepScrub({ value: 10, direction: 1, spec }), 11);
  assert.equal(stepScrub({ value: 10, direction: -1, spec }), 9);
  assert.equal(stepScrub({ value: 10, direction: 1, spec, shift: true }), 20);
  assert.equal(stepScrub({ value: 10, direction: 1, spec, fine: true }), 10.1);
});

test('a number is printed as short as it can be without lying', () => {
  const px = scrubSpecFor('position', [0, 0]);
  assert.equal(formatScrub(960, px), '960');
  assert.equal(formatScrub(960.5, px), '960.5');
  assert.equal(formatScrub(-0, px), '0');
  // A position that reads "960.00" invites the belief that the decimals mean
  // something.
  assert.equal(formatScrub(669.33332824707, px), '669.33');
  const colour = scrubSpecFor('ADBE Fill-0002', [1, 0.5, 0, 1]);
  assert.equal(formatScrub(0.5, colour), '0.5');
  assert.equal(formatScrub(1, colour), '1');
  assert.equal(formatScrub(NaN, px), '');
  assert.equal(formatScrub(undefined, px), '');
});

test('what the user typed, or null - never NaN and never a throw', () => {
  // Typing over a field is something a user does wrong constantly and by
  // accident; the answer is to put the old value back, not to raise.
  assert.equal(parseScrub('42'), 42);
  assert.equal(parseScrub('  -3.5 '), -3.5);
  assert.equal(parseScrub('.5'), 0.5);
  assert.equal(parseScrub('+7'), 7);
  assert.equal(parseScrub('3,5'), 3.5, 'a decimal comma is what half the world types');
  assert.equal(parseScrub(''), null);
  assert.equal(parseScrub('abc'), null);
  assert.equal(parseScrub('1e9'), null, 'exponent notation is not a number anyone scrubs');
  assert.equal(parseScrub('12px'), null);
  assert.equal(parseScrub('--3'), null);
  assert.equal(parseScrub('Infinity'), null);
});

test('decimals are counted from the step, so the step decides the precision', () => {
  assert.equal(decimalsFor(1), 0);
  assert.equal(decimalsFor(0.01), 2);
  assert.equal(decimalsFor(0.5), 1);
  assert.equal(clampScrub(5, { min: 0, max: 100 }), 5);
  assert.equal(clampScrub(-5, { min: 0 }), 0);
  assert.equal(clampScrub(5, undefined), 5);
});

test('a known property is labelled as AE labels it; a parameter is not guessed at', () => {
  assert.equal(scrubLabelFor('position'), 'Position');
  assert.equal(scrubLabelFor('anchorPoint'), 'Anchor Point');
  assert.equal(scrubLabelFor('opacity'), 'Opacity');
  // An effect parameter's display name is something AE never hands over, so the
  // matchName is shown rather than a prettied-up guess at one.
  assert.equal(scrubLabelFor('ADBE Fill-0002'), 'ADBE Fill-0002');
});

test('the modifiers are read in exactly one place, so they cannot disagree', () => {
  // They did disagree: a value could be dragged, arrowed, or stepped with the
  // field's own arrows, and the arrows honoured Shift while silently dropping
  // Ctrl - the same key meaning "finer" in two places and nothing in the third.
  assert.deepEqual(scrubModifiers({}), { shift: false, fine: false });
  assert.deepEqual(scrubModifiers({ shiftKey: true }), { shift: true, fine: false });

  // Ctrl on Windows, Cmd on macOS. AE's fine modifier is the platform's command
  // key, and honouring only one would be wrong on half the machines.
  assert.deepEqual(scrubModifiers({ ctrlKey: true }), { shift: false, fine: true });
  assert.deepEqual(scrubModifiers({ metaKey: true }), { shift: false, fine: true });

  // Nothing at all is still an answer, because a synthesized step has no event.
  assert.deepEqual(scrubModifiers(undefined), { shift: false, fine: false });
  assert.deepEqual(scrubModifiers(null), { shift: false, fine: false });
});

test('everything held at once is coarse, not a third behaviour', () => {
  const spec = scrubSpecFor('position', [0, 0]);
  const both = scrubModifiers({ shiftKey: true, ctrlKey: true });
  assert.deepEqual(both, { shift: true, fine: true });
  // A user pressing everything is more plausibly reaching for the big movement.
  assert.equal(applyScrub({ start: 0, dx: 10, spec, ...both }), 10 * COARSE);
  assert.equal(stepScrub({ value: 0, direction: 1, spec, ...both }), COARSE);
});

test('a drag, an arrow key and a step arrow move a value identically', () => {
  // The three paths a value can move by. Given the same modifiers they have to
  // land on the same number, or the field behaves differently depending on
  // which part of it the user touched.
  const spec = scrubSpecFor('opacity', 100);
  for (const event of [{}, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }]) {
    const mods = scrubModifiers(event);
    const dragged = applyScrub({ start: 50, dx: 1, spec, ...mods });
    const arrowed = stepScrub({ value: 50, direction: 1, spec, ...mods });
    assert.equal(dragged, arrowed, `modifiers ${JSON.stringify(event)}`);
  }
});
