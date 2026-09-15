// After Effects' numeric fields, as arithmetic.
//
// In AE every number is a SCRUBBER: drag across it and the value follows the
// pointer, click it and you type. That is not a nicety - it is how the
// application is used, and a panel whose values can only be typed reads as a
// web form parked inside AE.
//
// What lives here is the arithmetic and the unit table, kept pure so the feel
// of a drag can be tested without a pointer: how far a pixel moves a value,
// what the modifiers do, where a value is clamped, and how it is printed. The
// React component is only the pointer handling on top.
//
// No React, no After Effects.

// How much a value moves per pixel dragged, before the step and the modifiers.
// One step per pixel is AE's own feel for position; the modifiers are what make
// coarse and fine work, not this number.
const PIXELS_PER_STEP = 1;

// AE's modifier convention for a scrub: Shift is coarse, Ctrl/Cmd is fine.
// Deliberately NOT Blender's (where Shift is the fine one) - this panel is
// docked in After Effects, and the muscle memory that matters is AE's.
export const COARSE = 10;
export const FINE = 0.1;

/**
 * What a property's numbers are.
 *
 * The transform properties are known, so their units and limits are facts
 * rather than guesses. Everything else is an effect parameter, whose units AE
 * never tells us - see the heuristic below, and note that it only picks a STEP.
 * Nothing unknown is ever clamped, because a clamp on a guess is a value the
 * user cannot type their way out of.
 */
const SPECS = {
  position:    { step: 1,   unit: 'px', axes: ['X', 'Y', 'Z'] },
  anchorPoint: { step: 1,   unit: 'px', axes: ['X', 'Y', 'Z'] },
  scale:       { step: 1,   unit: '%',  axes: ['X', 'Y', 'Z'] },
  rotation:    { step: 1,   unit: '°' },
  opacity:     { step: 1,   unit: '%', min: 0, max: 100 },
};

// What After Effects calls these in its own timeline. Only the properties the
// graph knows: an effect parameter's display name is something AE never hands
// over, so its matchName is shown rather than a prettied-up guess at one.
const LABELS = {
  position: 'Position',
  anchorPoint: 'Anchor Point',
  scale: 'Scale',
  rotation: 'Rotation',
  opacity: 'Opacity',
};

export const scrubLabelFor = (prop) => LABELS[prop] || prop;

export function scrubSpecFor(prop, value) {
  const known = SPECS[prop];
  if (known) return { pixelsPerStep: PIXELS_PER_STEP, ...known };

  // An effect parameter. AE's colours are four components in 0..1, and a step
  // of 1 on one of those would jump the whole range in a single pixel - so a
  // four-component vector that sits inside 0..1 is scrubbed at 0.01. It is a
  // heuristic and it is allowed to be wrong: being wrong costs a drag that
  // feels coarse or fine, and the user can still type the number.
  if (Array.isArray(value) && value.length === 4
      && value.every((v) => typeof v === 'number' && v >= 0 && v <= 1)) {
    return { step: 0.01, unit: '', axes: ['R', 'G', 'B', 'A'], pixelsPerStep: PIXELS_PER_STEP };
  }
  // A lone value that lives near zero is being measured in something small.
  const magnitude = Array.isArray(value)
    ? Math.max(...value.map((v) => Math.abs(Number(v) || 0)))
    : Math.abs(Number(value) || 0);
  return { step: magnitude > 0 && magnitude <= 2 ? 0.01 : 1, unit: '',
           pixelsPerStep: PIXELS_PER_STEP };
}

/** How many decimals a step implies, so float dust never reaches the graph. */
export function decimalsFor(step) {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** The decimals a number is actually carrying, however it got them. */
const decimalsOf = (value) => {
  const text = String(value);
  if (text.includes('e') || text.includes('E')) return 12;
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
};

// Removing float dust must not remove PRECISION. AE reads 669.33332824707 out
// of a comp, and scrubbing that by one has to give 670.33332824707 - so the
// result is rounded to whatever the starting value already carried, or to what
// the step implies, whichever is finer. Rounding to the step alone would
// silently truncate a value the user never touched; not rounding at all leaves
// 0.08000000000000002 in the graph, and then in the comp.
const tidy = (value, start, step) => {
  const decimals = Math.min(Math.max(decimalsOf(start), decimalsFor(step)), 12);
  const rounded = Number(value.toFixed(decimals));
  return Object.is(rounded, -0) ? 0 : rounded;
};

/**
 * Where a drag has got to.
 *
 * Computed from the value the drag STARTED at and the total distance since,
 * never from the previous frame: accumulating per-frame deltas drifts, and a
 * drag that returns to where it began has to return the value with it.
 */
export function applyScrub({ start, dx, spec, shift = false, fine = false }) {
  const { step = 1, min, max, pixelsPerStep = PIXELS_PER_STEP } = spec || {};
  const scale = shift ? COARSE : (fine ? FINE : 1);
  const steps = Math.round(dx / pixelsPerStep);
  const delta = steps * step * scale;
  return clampScrub(tidy(start + delta, start, step * scale), spec);
}

/** The keyboard's version of the same thing: one step, or ten with Shift. */
export function stepScrub({ value, direction, spec, shift = false, fine = false }) {
  return applyScrub({ start: value, dx: direction * (spec?.pixelsPerStep ?? PIXELS_PER_STEP),
                      spec, shift, fine });
}

export function clampScrub(value, spec) {
  let out = value;
  if (typeof spec?.min === 'number') out = Math.max(spec.min, out);
  if (typeof spec?.max === 'number') out = Math.min(spec.max, out);
  return out;
}

/**
 * The number as AE prints one: as short as it can be without lying.
 *
 * Trailing zeros are dropped, because a position that reads "960.00" invites
 * the belief that the two decimals mean something.
 */
export function formatScrub(value, spec) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const decimals = Math.max(decimalsFor(spec?.step ?? 1), 1) + 1;
  const text = value.toFixed(Math.min(decimals, 6));
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/**
 * What the user typed, or null.
 *
 * Null rather than NaN or a throw: the caller's answer to "that is not a
 * number" is to put the old value back, and null says that without an
 * exception for something the user does constantly by accident.
 */
export function parseScrub(text) {
  const trimmed = String(text).trim().replace(',', '.');
  if (!trimmed || !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * The fields one property is edited through.
 *
 * A vector becomes one scrubber per component, labelled the way AE labels them,
 * because "960, 540" in a single box is a text field pretending to be two
 * numbers - and it cannot be dragged.
 */
export function scrubFieldsFor(prop, value) {
  const spec = scrubSpecFor(prop, value);
  if (!Array.isArray(value)) return [{ index: null, axis: null, value, spec }];
  return value.map((component, index) => ({
    index,
    axis: spec.axes?.[index] ?? String(index + 1),
    value: component,
    spec,
  }));
}

/** One component changed; the whole property value that results. */
export function withComponent(value, index, next) {
  if (index === null || index === undefined || !Array.isArray(value)) return next;
  const out = [...value];
  out[index] = next;
  return out;
}
