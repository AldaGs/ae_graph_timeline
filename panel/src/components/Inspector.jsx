import { useCallback, useEffect, useState } from 'react';
import { BLEND_MODES, desiredExpressions } from '../../../src/graph.js';
import { scrubFieldsFor, scrubLabelFor, withComponent } from '../../../src/scrub.js';
import ScrubValue from './ScrubValue.jsx';

const EFFECTS = [
  { name: 'Gaussian Blur', matchName: 'ADBE Gaussian Blur 2' },
  { name: 'Fill', matchName: 'ADBE Fill' },
  { name: 'Tint', matchName: 'ADBE Tint' },
];

/**
 * One property, edited the way After Effects edits one.
 *
 * A vector is one scrubbable field per component rather than a comma-separated
 * string: "960, 540" in a single box is a text field pretending to be two
 * numbers, and it cannot be dragged.
 *
 * The whole scrub is ONE gesture, so a drag across the field costs one undo
 * entry in AE rather than one per frame - the same rule P1.5 applies to a drag
 * on the canvas, for the same measured reason (S5: the stack holds 99).
 */
function PropertyRow({ node, prop, value, driven = false, label, onWrite, onGesture, onError }) {
  const fields = scrubFieldsFor(prop, value);

  const write = useCallback((next) => {
    try {
      onWrite(next);
    } catch (e) {
      onError(e.message);
    }
  }, [onWrite, onError]);

  return (
    <div className="ntl-prop">
      <span className="ntl-prop-name" title={prop}>
        {label ?? scrubLabelFor(prop)}{driven ? ' · linked' : ''}
      </span>
      <div className="ntl-prop-fields">
        {fields.map((field) => (
          <ScrubValue
            key={field.index ?? prop}
            value={field.value}
            spec={field.spec}
            axis={field.axis}
            label={`${node.name} ${prop}${field.axis ? ` ${field.axis}` : ''}`}
            disabled={driven}
            onScrubStart={() => onGesture.begin(`Set ${node.name} ${prop}`)}
            onScrub={(next) => write(withComponent(value, field.index, next))}
            onScrubEnd={() => void onGesture.end()}
            onCommit={(next) => write(withComponent(value, field.index, next))}
          />
        ))}
      </div>
    </div>
  );
}

export default function Inspector({ graph, selected, commands, editable, onError }) {
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
    <strong>Inspector · {node.kind}</strong>
    <fieldset disabled={!editable}>
      <label>Name<input id="ntl-inspector-name" value={name} onChange={(e) => setName(e.target.value)}
        onBlur={() => { if (name !== node.name) commands.rename(node.id, name); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setName(node.name); }} /></label>
      {layer && <label>Blend mode<select id="ntl-inspector-blend" value={node.blendMode} onChange={(e) => commands.setBlendMode(node.id, e.target.value)}>
        <optgroup label="Compositing">{BLEND_MODES.slice(0, 15).map((mode) => <option key={mode}>{mode}</option>)}</optgroup>
        <optgroup label="Contrast and colour">{BLEND_MODES.slice(15).map((mode) => <option key={mode}>{mode}</option>)}</optgroup>
      </select></label>}
      {/* An effect node has no transform of its own - the host null it lives on
          does, and that null is machinery, not something to edit. What
          identifies it is its display name and AE's match name. */}
      {node.kind === 'effect' && <label>Match name
        <input aria-label="Effect match name" value={node.matchName || ''} readOnly
          title="After Effects' stable internal name for this effect" /></label>}
      {/* Not gated on `layer`: an effect node's parameters live in `props` too,
          and while this was layer-only they were readable on the canvas and
          editable nowhere. */}
      {node.kind !== 'expression' && Object.entries(node.props).map(([prop, value]) => (
        <PropertyRow key={prop} node={node} prop={prop} value={value}
          driven={!!driven[`${node.id}|${prop}`]} onGesture={gesture} onError={onError}
          onWrite={(next) => commands.setProperty(node.id, prop, next)} />
      ))}

      {/* An INLINE effect's parameters. They live in node.effects rather than in
          node.props, which is why they were the one place in the inspector a
          number could be read and not touched - the canvas printed them and
          nothing could edit them. This is the panel's Effect Controls. */}
      {layer && node.effects.map((effect, index) => (
        <section className="ntl-fx" key={`${effect.matchName}:${index}`}>
          <span className="ntl-fx-name" title={effect.matchName}>{effect.name || effect.matchName}</span>
          {Object.keys(effect.params).length === 0
            ? <p className="ntl-inspector-note">No parameters were read for this effect.</p>
            : Object.entries(effect.params).map(([param, value]) => (
              <PropertyRow key={param} node={node} prop={param} value={value} label={param}
                onGesture={gesture} onError={onError}
                onWrite={(next) => commands.setEffectParam(node.id, index, param, next)} />
            ))}
        </section>
      ))}
      {layer && <details id="ntl-inspector-effects"><summary>Add effect</summary>
        <input aria-label="Search effects" placeholder="Search effects…" value={search} onChange={(e) => setSearch(e.target.value)} />
        {EFFECTS.filter((fx) => fx.name.toLowerCase().includes(search.toLowerCase())).map((fx) => <button key={fx.matchName} onClick={() => add(fx)}>{fx.name}</button>)}
        <details><summary>Advanced match name</summary><input aria-label="New effect match name" value={raw} onChange={(e) => setRaw(e.target.value)} /><button onClick={() => add({ matchName: raw.trim(), name: raw.trim() })}>Add</button></details>
      </details>}
      {node.kind === 'effect' && !hasParams && <p>This effect has no parameters in the graph yet. Add one by wiring a value into it.</p>}
      {node.kind === 'effect' && <p className="ntl-inspector-note">Lives on a host null in After Effects. That layer's transform belongs to the machinery, not to this node.</p>}
      <button id="ntl-inspector-delete" onClick={() => setConfirmDelete(true)}>Delete node…</button>
      {confirmDelete && <div role="alert"><p>Delete {node.name} and its connections? AE layer deletion removes its animation too.</p><button onClick={() => { commands.remove(node.id); onError('Deleted node. Use AE Undo to restore a synchronized layer.'); }}>Delete</button><button onClick={() => setConfirmDelete(false)}>Cancel</button></div>}
    </fieldset>
  </aside>;
}
