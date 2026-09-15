// The inspector, drawn as Blender's properties editor is and behaving as After
// Effects' fields do.
//
// The layout is Blender's, and deliberately, because the outliner next to it
// already is: collapsible sections under a chevron, one component per ROW, a
// right-aligned label column in which only the first row of a vector carries
// the property's name, the value in a flat inset field with its unit inside it,
// and a narrow state column on the right.
//
// The behaviour of a number is in ScrubValue and src/scrub.js.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Link2, Lock } from 'lucide-react';

import { BLEND_MODES, desiredExpressions } from '../../../src/graph.js';
import { scrubFieldsFor, scrubLabelFor, withComponent } from '../../../src/scrub.js';
import ScrubValue from './ScrubValue.jsx';

const EFFECTS = [
  { name: 'Gaussian Blur', matchName: 'ADBE Gaussian Blur 2' },
  { name: 'Fill', matchName: 'ADBE Fill' },
  { name: 'Tint', matchName: 'ADBE Tint' },
];

/** Blender's collapsible panel header, with the outliner's own chevron. */
function Section({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="ntl-section">
      <button className="ntl-section-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
              : <ChevronRight size={12} strokeWidth={2} aria-hidden="true" />}
        <span>{title}</span>
      </button>
      {open && <div className="ntl-section-body">{children}</div>}
    </section>
  );
}

/**
 * One property, as a stack of rows - one per component.
 *
 * Only the FIRST row carries the property's name; the rest carry just their
 * axis. That is Blender's own economy, and it is what keeps a three-component
 * vector from repeating "Position" three times down a 225px panel.
 *
 * The whole scrub is ONE gesture, so a drag across a field costs one undo entry
 * in AE rather than one per frame - the same rule P1.5 applies to a drag on the
 * canvas, for the same measured reason (S5: the stack holds 99).
 */
function PropertyRows({ node, prop, value, driven = false, label, onWrite, onGesture, onError }) {
  const fields = scrubFieldsFor(prop, value);
  const name = label ?? scrubLabelFor(prop);

  const write = useCallback((next) => {
    try {
      onWrite(next);
    } catch (e) {
      onError(e.message);
    }
  }, [onWrite, onError]);

  return fields.map((field, row) => (
    <div className="ntl-irow" key={field.index ?? prop}>
      {/* Two spans, not one string: the NAME may be long enough to truncate -
          an effect parameter's matchName routinely is - and the axis letter is
          the half that must survive it. One string put the ellipsis through
          the "R" of a colour's first channel. */}
      <span className="ntl-irow-label" title={prop}>
        {row === 0 && <span className="ntl-irow-name">{name}</span>}
        {field.axis && <span className="ntl-irow-axis">{field.axis}</span>}
      </span>
      <ScrubValue
        value={field.value}
        spec={field.spec}
        label={`${node.name} ${prop}${field.axis ? ` ${field.axis}` : ''}`}
        disabled={driven}
        onScrubStart={() => onGesture.begin(`Set ${node.name} ${prop}`)}
        onScrub={(next) => write(withComponent(value, field.index, next))}
        onScrubEnd={() => void onGesture.end()}
        onCommit={(next) => write(withComponent(value, field.index, next))}
      />
      {/* Blender's lock-and-animate column. Ours says one thing: an input driven
          by an expression edge is not the user's to type into, because the
          expression IS the value there. */}
      <span className="ntl-irow-state">
        {driven && row === 0 && <Link2 size={11} strokeWidth={2} aria-label="Driven by an expression" />}
      </span>
    </div>
  ));
}

/**
 * A text layer's string.
 *
 * A textarea, not an input, because After Effects text is multi-line and a
 * single-line box would quietly make a two-line title impossible to type.
 *
 * Committed on blur rather than on every keystroke: each commit is a write to
 * the graph and so an entry in AE's 99-deep undo stack, and a typist would
 * spend the whole stack on one sentence. Escape restores what the graph holds;
 * Enter inserts a newline, as it must in a multi-line field, so there is
 * deliberately no Enter-to-commit here.
 */
function TextEditor({ node, locked, commands, onError }) {
  const [draft, setDraft] = useState(node.text ?? '');
  const [editing, setEditing] = useState(false);
  // Escape blurs, and blur commits. A `setDraft` in the Escape handler has not
  // applied by the time the blur handler reads it, so the cancelled edit was
  // committed anyway - the exact bug Enter had in ScrubValue. A ref is visible
  // immediately, which is the whole reason it is one.
  const cancelled = useRef(false);

  // A string that changed underneath us - an AE edit the panel adopted - must
  // be shown, but not while the user is mid-sentence.
  useEffect(() => { if (!editing) setDraft(node.text ?? ''); }, [node.id, node.text, editing]);

  const commit = () => {
    if (draft === (node.text ?? '')) return;
    try { commands.setText(node.id, draft); }
    catch (e) { onError(e.message); setDraft(node.text ?? ''); }
  };

  return (
    <div className="ntl-irow is-text">
      <span className="ntl-irow-label"><span className="ntl-irow-name">Source</span></span>
      <textarea
        className="ntl-text-input"
        aria-label={`${node.name} source text`}
        rows={2}
        value={draft}
        readOnly={locked}
        placeholder={locked ? '' : 'Type the layer’s text'}
        title={locked ? 'Keyframed or expression-driven in After Effects — not the graph’s to overwrite' : undefined}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (cancelled.current) { cancelled.current = false; setDraft(node.text ?? ''); return; }
          commit();
        }}
        onKeyDown={(e) => {
          // The canvas deletes the selected node on Delete; a textarea must not
          // lose the layer because the user backspaced past the first character.
          e.stopPropagation();
          // Enter is deliberately NOT a commit: this is multi-line text, and a
          // field where Enter ends the edit cannot hold a second line.
          if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur(); }
        }}
      />
      <span className="ntl-irow-state">
        {locked && <Lock size={11} strokeWidth={2} aria-label="Keyframed or expression-driven" />}
      </span>
    </div>
  );
}

export default function Inspector({ graph, selected, commands, editable, onError,
                                   textLocked = new Set() }) {
  const node = graph.nodes[selected];
  const [name, setName] = useState('');
  const [search, setSearch] = useState('');
  const [raw, setRaw] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { setName(node?.name || ''); setConfirmDelete(false); }, [selected, node?.name]);
  if (!node) return <aside className="ntl-inspector"><strong>Inspector</strong><p>Select a node on the canvas or in the outliner to edit it.</p></aside>;
  const layer = !['effect', 'expression'].includes(node.kind);
  const hasParams = Object.keys(node.props).length > 0;
  const driven = desiredExpressions(graph);
  // Every scrub in this panel opens and closes a gesture the same way, so a
  // drag is one undo entry in After Effects however many frames it spans.
  const gesture = {
    begin: (label) => commands.beginGesture(label),
    end: () => commands.endGesture(),
  };
  const add = (effect) => {
    if (!effect.matchName.trim()) { onError('Enter an effect match name'); return; }
    try { commands.addInlineEffect(node.id, effect); }
    catch (e) { onError(e.message); }
  };

  return <aside className="ntl-inspector" aria-label="Node inspector">
    {/* Blender puts the object's icon and name at the top, above the panels. */}
    <div className="ntl-inspector-head">
      <span className="ntl-inspector-kind">{node.kind}</span>
      <input id="ntl-inspector-name" aria-label="Name" value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => { if (name !== node.name) commands.rename(node.id, name); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setName(node.name); }} />
    </div>

    <fieldset disabled={!editable}>
      {/* Above Transform, because for a title the string is what the layer IS
          and its position is a detail of where it sits. */}
      {node.kind === 'text' && (
        <Section title="Text">
          <TextEditor node={node} locked={textLocked.has(node.id)} commands={commands} onError={onError} />
        </Section>
      )}

      {node.kind !== 'expression' && hasParams && (
        <Section title={layer ? 'Transform' : 'Parameters'}>
          {Object.entries(node.props).map(([prop, value]) => (
            <PropertyRows key={prop} node={node} prop={prop} value={value}
              driven={!!driven[`${node.id}|${prop}`]} onGesture={gesture} onError={onError}
              onWrite={(next) => commands.setProperty(node.id, prop, next)} />
          ))}
        </Section>
      )}

      {layer && (
        <Section title="Compositing">
          <div className="ntl-irow">
            <span className="ntl-irow-label">Blend</span>
            <select id="ntl-inspector-blend" value={node.blendMode}
              onChange={(e) => commands.setBlendMode(node.id, e.target.value)}>
              <optgroup label="Compositing">{BLEND_MODES.slice(0, 15).map((mode) => <option key={mode}>{mode}</option>)}</optgroup>
              <optgroup label="Contrast and colour">{BLEND_MODES.slice(15).map((mode) => <option key={mode}>{mode}</option>)}</optgroup>
            </select>
            <span className="ntl-irow-state" />
          </div>
        </Section>
      )}

      {/* An effect node has no transform of its own - the host null it lives on
          does, and that null is machinery, not something to edit. What
          identifies it is its display name and AE's match name. */}
      {node.kind === 'effect' && (
        <Section title="Effect">
          <div className="ntl-irow">
            <span className="ntl-irow-label">Match name</span>
            <input aria-label="Effect match name" value={node.matchName || ''} readOnly
              title="After Effects' stable internal name for this effect" />
            <span className="ntl-irow-state" />
          </div>
          {!hasParams && <p className="ntl-inspector-note">No parameters in the graph yet. Wire a value into it.</p>}
          <p className="ntl-inspector-note">Lives on a host null in After Effects. That layer's transform belongs to the machinery, not to this node.</p>
        </Section>
      )}

      {/* An INLINE effect's parameters. They live in node.effects rather than in
          node.props, which is why they were the one place in the inspector a
          number could be read and not touched. This is the panel's Effect
          Controls, one collapsible section per effect as Blender does modifiers. */}
      {layer && node.effects.map((effect, index) => (
        <Section key={`${effect.matchName}:${index}`} title={effect.name || effect.matchName}>
          {Object.keys(effect.params).length === 0
            ? <p className="ntl-inspector-note">No parameters were read for this effect.</p>
            : Object.entries(effect.params).map(([param, value]) => (
              <PropertyRows key={param} node={node} prop={param} value={value} label={param}
                onGesture={gesture} onError={onError}
                onWrite={(next) => commands.setEffectParam(node.id, index, param, next)} />
            ))}
        </Section>
      ))}

      {layer && (
        <Section title="Add effect" defaultOpen={false}>
          <div id="ntl-inspector-effects">
            <input aria-label="Search effects" placeholder="Search effects…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="ntl-effect-picks">
              {EFFECTS.filter((fx) => fx.name.toLowerCase().includes(search.toLowerCase())).map((fx) => <button key={fx.matchName} onClick={() => add(fx)}>{fx.name}</button>)}
            </div>
            <input aria-label="New effect match name" placeholder="Match name…" value={raw} onChange={(e) => setRaw(e.target.value)} />
            <button onClick={() => add({ matchName: raw.trim(), name: raw.trim() })}>Add by match name</button>
          </div>
        </Section>
      )}

      <div className="ntl-inspector-foot">
        <button id="ntl-inspector-delete" onClick={() => setConfirmDelete(true)}>Delete node…</button>
        {confirmDelete && <div role="alert"><p>Delete {node.name} and its connections? AE layer deletion removes its animation too.</p><button onClick={() => { commands.remove(node.id); onError('Deleted node. Use AE Undo to restore a synchronized layer.'); }}>Delete</button><button onClick={() => setConfirmDelete(false)}>Cancel</button></div>}
      </div>
    </fieldset>
  </aside>;
}
