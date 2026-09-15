// One numeric field, drawn as Blender draws one and behaving as After Effects
// behaves.
//
// Drag across it and the value follows the pointer; click it and you type; hover
// it and a step arrow appears at each end. All from the same element, which is
// the whole trick: the drag is what these applications are actually used with,
// and a field that only accepts typing makes every small adjustment a
// select-all-and-retype.
//
// The arithmetic - how far a pixel moves a value, what Shift and Ctrl do, where
// it clamps, how it prints - is in src/scrub.js and tested there. This file is
// the pointer handling, and the three things that are genuinely fiddly about it:
//
//   1. a drag is measured from where it STARTED, not frame to frame, so a
//      pointer waggled out and back leaves the value where it was;
//   2. pointer CAPTURE, so the drag survives leaving the element - a scrub that
//      stopped at the field's edge would be unusable at this row height;
//   3. a click and a drag are the same gesture until the pointer moves, so the
//      decision between "type" and "scrub" is made on distance, not on timing.
//
// Every scrub is wrapped in one gesture, which is what makes it one undo entry
// in After Effects (S5: the stack holds 99) no matter how far it is dragged.

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { applyScrub, formatScrub, parseScrub, stepScrub } from '../../../src/scrub.js';

// How far the pointer travels before a press becomes a drag rather than a click.
// Small enough that a deliberate nudge scrubs, large enough that a click with an
// unsteady hand still opens the field for typing.
const DRAG_THRESHOLD = 3;

export default function ScrubValue({
  value,
  spec,
  label,
  disabled = false,
  onScrubStart,
  onScrub,
  onScrubEnd,
  onCommit,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // Everything a live drag needs, held where a pointer handler can reach it:
  // these change many times between renders and none of them belongs in state.
  const drag = useRef(null);
  const inputRef = useRef(null);

  // A value that changed underneath us - a scrub in another field, an AE edit
  // the panel adopted - must be shown, but not while the user is mid-word.
  useEffect(() => {
    if (!editing) setDraft(formatScrub(value, spec));
  }, [value, spec, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commitText = () => {
    const parsed = parseScrub(draft);
    setEditing(false);
    if (parsed === null || parsed === value) {
      // Not a number, or not a change. Either way the field goes back to what
      // the graph holds rather than arguing about it.
      setDraft(formatScrub(value, spec));
      return;
    }
    onCommit?.(parsed);
  };

  // While the field is open for typing, the DRAFT is what the user is looking
  // at, so it is what a step has to move - stepping the graph's value instead
  // would change the value under a number that never moved on screen.
  const effectiveValue = () => {
    if (!editing) return value;
    const parsed = parseScrub(draft);
    return parsed === null ? value : parsed;
  };

  const step = (direction, modifiers = {}) => {
    const from = effectiveValue();
    const next = stepScrub({ value: from, direction, spec, ...modifiers });
    if (next === from) return;
    // The draft follows, so the number on screen is the number that was sent.
    if (editing) setDraft(formatScrub(next, spec));
    onCommit?.(next);
  };

  const onPointerDown = (event) => {
    if (disabled || editing || event.button !== 0) return;
    // Not preventDefault'd yet: until the pointer moves this may still be a
    // click, and a click has to be allowed to focus the field.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { x: event.clientX, start: value, moved: false };
  };

  const onPointerMove = (event) => {
    const state = drag.current;
    if (!state) return;
    const dx = event.clientX - state.x;
    if (!state.moved) {
      if (Math.abs(dx) < DRAG_THRESHOLD) return;
      state.moved = true;
      // Announced only once the press is definitely a drag, so a click never
      // opens a gesture - an empty gesture would still cost an undo entry.
      onScrubStart?.();
    }
    event.preventDefault();
    onScrub?.(applyScrub({ start: state.start, dx, spec,
      shift: event.shiftKey, fine: event.ctrlKey || event.metaKey }));
  };

  const endDrag = (event) => {
    const state = drag.current;
    drag.current = null;
    if (!state) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (state.moved) { onScrubEnd?.(); return; }
    // It never became a drag, so it was a click: type.
    if (!disabled) setEditing(true);
  };

  const onKeyDown = (event) => {
    if (event.key === 'Enter') {
      // Committed HERE, not left to the blur that follows. Relying on blur made
      // Enter depend on the field being focused in the first place, which is
      // not true of every way a value can be typed into.
      event.preventDefault();
      commitText();
      event.currentTarget.blur();
      return;
    }
    if (event.key === 'Escape') {
      setDraft(formatScrub(value, spec));
      setEditing(false);
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    // The keyboard's version of a scrub, and the reason a scrubber still has to
    // be a real focusable field: arrowing a value is how it is done precisely.
    event.preventDefault();
    step(event.key === 'ArrowUp' ? 1 : -1,
      { shift: event.shiftKey, fine: event.ctrlKey || event.metaKey });
  };

  // Blender's step arrows, which appear on hover at each end of the field. They
  // are the discoverable half of the affordance: a user who has not worked out
  // that the field can be dragged can still click one.
  const arrow = (direction, Icon, name) => (
    <button
      className={`ntl-scrub-step is-${name}`}
      aria-label={`${label} ${name}`}
      tabIndex={-1}
      disabled={disabled}
      // Pointer events are stopped, not just the click: the field's own
      // pointerdown would otherwise start a drag from under the arrow.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); step(direction, { shift: e.shiftKey }); }}
    >
      <Icon size={11} strokeWidth={2.25} aria-hidden="true" />
    </button>
  );

  return (
    <span className={`ntl-scrub${disabled ? ' is-disabled' : ''}${editing ? ' is-editing' : ''}`}>
      {!editing && !disabled && arrow(-1, ChevronLeft, 'down')}
      <input
        ref={inputRef}
        className="ntl-scrub-input"
        aria-label={label}
        value={editing ? draft : formatScrub(value, spec)}
        readOnly={!editing}
        disabled={disabled}
        inputMode="decimal"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={() => { drag.current = null; }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (editing) commitText(); }}
        onKeyDown={onKeyDown}
        onDoubleClick={() => { if (!disabled) setEditing(true); }}
      />
      {/* The unit sits INSIDE the field, right after the number, the way Blender
          writes "0 m" and "1.000" - not in a column of its own outside it. */}
      {spec?.unit && !editing && <span className="ntl-scrub-unit" aria-hidden="true">{spec.unit}</span>}
      {!editing && !disabled && arrow(1, ChevronRight, 'up')}
    </span>
  );
}
