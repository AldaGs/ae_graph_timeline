import { memo, useEffect, useState } from 'react';
import { Handle, Position } from 'reactflow';

function ExpressionNode({ id, data, selected }) {
  const { name, expression = '' } = data;
  const [draft, setDraft] = useState(expression);

  useEffect(() => setDraft(expression), [expression]);

  return (
    <div className={`ntl-node ntl-node-expression${selected ? ' is-selected' : ''}`}>
      <header className="ntl-node-head kind-expression">
        <span className="ntl-node-name">{name}</span>
        <span className="ntl-node-kind">expression</span>
      </header>

      <div className="ntl-expr-body">
        <textarea 
          className="ntl-expr-text nodrag nopan nowheel"
          readOnly={data.editable === false}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            data.onExpressionChange?.(e.target.value);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onFocus={() => data.onExpressionFocus?.()}
          onBlur={() => data.onExpressionBlur?.()}
          placeholder="value;" 
        />
      </div>

      <Handle type="source" position={Position.Right} id="expression:out" className="ntl-handle-expr" aria-label="Expression output" />
    </div>
  );
}

export default memo(ExpressionNode);
