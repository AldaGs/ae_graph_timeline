import { memo } from 'react';
import { Handle, Position } from 'reactflow';

function ExpressionNode({ id, data, selected }) {
  const { name, expression = '' } = data;

  return (
    <div className={`ntl-node ntl-node-expression${selected ? ' is-selected' : ''}`}>
      <header className="ntl-node-head kind-expression">
        <span className="ntl-node-name">{name}</span>
        <span className="ntl-node-kind">expression</span>
      </header>

      <div className="ntl-expr-body">
        <textarea 
          className="ntl-expr-text nodrag" 
          value={expression} 
          onChange={(e) => data.onExpressionChange?.(e.target.value)}
          onFocus={() => data.onExpressionFocus?.()}
          onBlur={() => data.onExpressionBlur?.()}
          placeholder="value;" 
        />
      </div>

      <Handle type="source" position={Position.Right} id="out:out" className="ntl-handle-expr" />
    </div>
  );
}

export default memo(ExpressionNode);
