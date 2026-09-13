import { memo } from 'react';
import { Handle, Position } from 'reactflow';

const round = (n) => (Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '—');

function formatValue(v) {
  if (Array.isArray(v)) return v.map((n) => round(n)).join(', ');
  if (typeof v === 'number') return round(v);
  return String(v ?? '');
}

function EffectNode({ id, data, selected }) {
  const { name, matchName, ports = [], props = {} } = data;

  return (
    <div className={`ntl-node ntl-node-effect${selected ? ' is-selected' : ''}`}>
      <Handle type="target" position={Position.Top} id="in:in" className="ntl-handle-flow" />
      <header className="ntl-node-head kind-effect">
        <span className="ntl-node-name" title={matchName}>{name}</span>
        <span className="ntl-node-kind">effect</span>
      </header>

      <div className="ntl-ports">
        {ports.map((port) => (
          <div key={port} className="ntl-row ntl-row-effect">
            <Handle
              type="target"
              position={Position.Left}
              id={`in:${port}`}
              className="ntl-handle ntl-handle-effect"
            />
            <span className="ntl-row-label">{port}</span>
            <span className="ntl-row-value">{formatValue(props[port])}</span>
            <Handle
              type="source"
              position={Position.Right}
              id={`out:${port}`}
              className="ntl-handle ntl-handle-effect"
            />
          </div>
        ))}
      </div>
      <Handle type="source" position={Position.Bottom} id="out:out" className="ntl-handle-flow" />
    </div>
  );
}

export default memo(EffectNode);
