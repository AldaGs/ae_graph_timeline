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
//
// M2: effects render as collapsible sections below the transform properties,
// each with their own parameter rows and ports. The header uses AE's system
// label colour, keeping the visual language familiar.

import { memo, useState } from 'react';
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

const BLEND_LABEL = {
  normal: 'Normal',
  dissolve: 'Dissolve',
  darken: 'Darken',
  multiply: 'Multiply',
  colorBurn: 'Color Burn',
  linearBurn: 'Linear Burn',
  darkerColor: 'Darker Color',
  lighten: 'Lighten',
  screen: 'Screen',
  colorDodge: 'Color Dodge',
  linearDodge: 'Add',
  lighterColor: 'Lighter Color',
  overlay: 'Overlay',
  softLight: 'Soft Light',
  hardLight: 'Hard Light',
  vividLight: 'Vivid Light',
  linearLight: 'Linear Light',
  pinLight: 'Pin Light',
  hardMix: 'Hard Mix',
  difference: 'Difference',
  exclusion: 'Exclusion',
  subtract: 'Subtract',
  divide: 'Divide',
  hue: 'Hue',
  saturation: 'Saturation',
  color: 'Color',
  luminosity: 'Luminosity',
};

function formatValue(v) {
  if (Array.isArray(v)) return v.map((n) => round(n)).join(', ');
  if (typeof v === 'number') return round(v);
  return String(v ?? '');
}

// Two decimals is what a user reads; the model keeps the float. The diff
// compares at 1e-6, so this is display only and never round-trips.
const round = (n) => (Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '—');

function EffectSection({ effect, nodeId }) {
  const [collapsed, setCollapsed] = useState(false);
  const { name, matchName, ports = [], params = {}, index } = effect;

  return (
    <div className="ntl-effect">
      <div
        className="ntl-effect-head"
        onClick={() => setCollapsed((c) => !c)}
        title={matchName}
      >
        <span className="ntl-effect-toggle">{collapsed ? '▸' : '▾'}</span>
        <span className="ntl-effect-name">{name}</span>
      </div>
      {!collapsed && ports.map((param) => (
        <div key={`fx${index}:${param}`} className="ntl-row ntl-row-effect">
          <Handle
            type="target"
            position={Position.Left}
            id={`in:fx${index}:${param}`}
            className="ntl-handle ntl-handle-effect"
          />
          <span className="ntl-row-label">{param}</span>
          <span className="ntl-row-value">{formatValue(params[param])}</span>
          <Handle
            type="source"
            position={Position.Right}
            id={`out:fx${index}:${param}`}
            className="ntl-handle ntl-handle-effect"
          />
        </div>
      ))}
    </div>
  );
}

function LayerNode({ id, data, selected }) {
  const {
    name, kind, ports = [], props = {}, driven = {},
    effects = [], blendMode = 'normal', labelColor,
  } = data;

  // The header colour comes from AE's label system. If no label is set,
  // KIND_DEFAULT_LABEL provides a sensible default so the canvas is colourful
  // without manual effort.
  const headerStyle = labelColor ? { borderLeftColor: labelColor } : undefined;

  return (
    <div className={`ntl-node${selected ? ' is-selected' : ''}`}>
      <Handle type="target" position={Position.Top} id="in:in" className="ntl-handle-flow" />
      <header className={`ntl-node-head kind-${kind}`} style={headerStyle}>
        <span className="ntl-node-name" title={name}>{name}</span>
        <span className="ntl-node-kind">{KIND_LABEL[kind] || kind}</span>
        {blendMode !== 'normal' && (
          <span className="ntl-node-blend" title={`Blend: ${BLEND_LABEL[blendMode] || blendMode}`}>
            {BLEND_LABEL[blendMode] || blendMode}
          </span>
        )}
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

      {/* M2: effects render below transform properties */}
      {effects.length > 0 && (
        <div className="ntl-effects">
          {effects.map((fx) => (
            <EffectSection key={`fx${fx.index}`} effect={fx} nodeId={id} />
          ))}
        </div>
      )}

      <footer className="ntl-node-foot">{id}</footer>
      <Handle type="source" position={Position.Bottom} id="out:out" className="ntl-handle-flow" />
    </div>
  );
}

export default memo(LayerNode);
