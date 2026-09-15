import { useEffect, useState } from 'react';
import { BLEND_MODES, desiredExpressions } from '../../../src/graph.js';

const EFFECTS = [
  { name: 'Gaussian Blur', matchName: 'ADBE Gaussian Blur 2' },
  { name: 'Fill', matchName: 'ADBE Fill' },
  { name: 'Tint', matchName: 'ADBE Tint' },
];

function ValueEditor({ value, label, disabled, onCommit, onError }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    try {
      const parts = draft.split(',').map((part) => part.trim());
      if (parts.some((part) => !part)) throw new Error('Enter a number for each component');
      onCommit(Array.isArray(value) ? parts.map(Number) : Number(draft));
    } catch (e) { onError(e.message); setDraft(String(value)); }
  };
  return <input aria-label={label} disabled={disabled} value={draft}
    onChange={(e) => setDraft(e.target.value)} onBlur={commit}
    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setDraft(String(value)); }} />;
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
      {/* Not gated on `layer`: an effect node's parameters live in `props` too,
          and while this was layer-only they were readable on the canvas and
          editable nowhere. */}
      {node.kind !== 'expression' && Object.entries(node.props).map(([prop, value]) => <label key={prop}>{prop}{driven[`${node.id}|${prop}`] ? ' · linked' : ''}
        <ValueEditor value={value} label={`${node.name} ${prop}`} disabled={!!driven[`${node.id}|${prop}`]}
          onCommit={(next) => { if (JSON.stringify(next) !== JSON.stringify(value)) commands.setProperty(node.id, prop, next); }} onError={onError} />
      </label>)}
      {layer && <details id="ntl-inspector-effects"><summary>Add effect</summary>
        <input aria-label="Search effects" placeholder="Search effects…" value={search} onChange={(e) => setSearch(e.target.value)} />
        {EFFECTS.filter((fx) => fx.name.toLowerCase().includes(search.toLowerCase())).map((fx) => <button key={fx.matchName} onClick={() => add(fx)}>{fx.name}</button>)}
        <details><summary>Advanced match name</summary><input aria-label="Effect match name" value={raw} onChange={(e) => setRaw(e.target.value)} /><button onClick={() => add({ matchName: raw.trim(), name: raw.trim() })}>Add</button></details>
      </details>}
      {node.kind === 'effect' && !hasParams && <p>This effect has no parameters in the graph yet. Add one by wiring a value into it.</p>}
      <button id="ntl-inspector-delete" onClick={() => setConfirmDelete(true)}>Delete node…</button>
      {confirmDelete && <div role="alert"><p>Delete {node.name} and its connections? AE layer deletion removes its animation too.</p><button onClick={() => { commands.remove(node.id); onError('Deleted node. Use AE Undo to restore a synchronized layer.'); }}>Delete</button><button onClick={() => setConfirmDelete(false)}>Cancel</button></div>}
    </fieldset>
  </aside>;
}
