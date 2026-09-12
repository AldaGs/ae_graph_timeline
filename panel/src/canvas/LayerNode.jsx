// A node is a layer.
//
// That sentence is the whole design. The card shows what decides which layer it
// is - the name and the kind - and one row per property the graph owns on it.
// Each row is a port, so what you can wire is exactly what the reconciler can
// write, and the two cannot drift apart.
//
// A property driven by an edge shows the edge instead of a value. That is not
// decoration: an expression IS the value there (P1.2 refuses to write a value to
// a driven property), and an editable box over a number After Effects recomputes
// every frame would be a lie.

import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { PARENT_HANDLE } from '../../../src/view.js';

const KIND_LABEL = {
  solid: 'solid',
  null: 'null',
  text: 'text',
  shape: 'shape',
  precomp: 'precomp',
  footage: 'footage',
  camera: 'camera',
  light: 'light',
};

function formatValue(v) {
  if (Array.isArray(v)) return v.map((n) => round(n)).join(', ');
  if (typeof v === 'number') return round(v);
  return String(v ?? '');
}

// Two decimals is what a user reads; the model keeps the float. The diff
// compares at 1e-6, so this is display only and never round-trips.
const round = (n) => (Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '—');

function LayerNode({ id, data, selected }) {
  const { name, kind, ports = [], props = {}, driven = {} } = data;

  return (
    <div className={`ntl-node${selected ? ' is-selected' : ''}`}>
      <header className={`ntl-node-head kind-${kind}`}>
        <span className="ntl-node-name" title={name}>{name}</span>
        <span className="ntl-node-kind">{KIND_LABEL[kind] || kind}</span>
      </header>

      {/* Parenting is a real AE pointer, not an expression, so it gets its own
          pair of ports at the top and its own wire colour. */}
      <div className="ntl-row ntl-row-parent">
        <Handle
          type="target"
          position={Position.Left}
          id={`in:${PARENT_HANDLE}`}
          className="ntl-handle ntl-handle-parent"
        />
        <span className="ntl-row-label">parent</span>
        <Handle
          type="source"
          position={Position.Right}
          id={`out:${PARENT_HANDLE}`}
          className="ntl-handle ntl-handle-parent"
        />
      </div>

      {ports.map((prop) => {
        const edge = driven[prop];
        return (
          <div key={prop} className={`ntl-row${edge ? ' is-driven' : ''}`}>
            <Handle type="target" position={Position.Left} id={`in:${prop}`} className="ntl-handle" />
            <span className="ntl-row-label">{prop}</span>
            <span className="ntl-row-value" title={edge ? `driven by ${edge}` : undefined}>
              {edge ? 'linked' : formatValue(props[prop])}
            </span>
            <Handle type="source" position={Position.Right} id={`out:${prop}`} className="ntl-handle" />
          </div>
        );
      })}

      {ports.length === 0 && <div className="ntl-row ntl-row-empty">no properties yet</div>}

      <footer className="ntl-node-foot">{id}</footer>
    </div>
  );
}

export default memo(LayerNode);
