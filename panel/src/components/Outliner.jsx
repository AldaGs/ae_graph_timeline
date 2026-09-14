import { useState, useMemo } from 'react';
import { LABEL_COLORS } from '../../../src/graph.js';
import './Outliner.css';

export function Outliner({ graph, commands, version, editable = true, selected, onSelect }) {
  const [collapsed, setCollapsed] = useState(false);
  const layers = useMemo(() => Object.values(graph.nodes)
      .filter(n => n.kind !== 'expression' && n.kind !== 'effect')
      .sort((a, b) => (a.order || 0) - (b.order || 0))
  , [graph, version]);

  const toggleVisibility = (nodeId) => {
    if (!editable) return;
    const node = graph.nodes[nodeId];
    if (node) {
      commands.setEnabled(nodeId, !node.enabled);
    }
  };

  const cycleLabel = (nodeId) => {
    if (!editable) return;
    const node = graph.nodes[nodeId];
    if (node) {
      commands.setLabel(nodeId, ((node.label || 0) + 1) % LABEL_COLORS.length);
    }
  };

  // Basic HTML5 Drag and Drop for reordering
  const onDragStart = (e, index) => {
    if (!editable) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index.toString());
  };

  const onDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const onDrop = (e, targetIndex) => {
    if (!editable) return;
    e.preventDefault();
    const sourceIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (sourceIndex === targetIndex || !Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= layers.length) return;

    // We only reorder the managed layers.
    // To do this, we just extract the current array, move the item, and re-assign `order` to all.
    const newLayers = [...layers];
    const [movedItem] = newLayers.splice(sourceIndex, 1);
    newLayers.splice(targetIndex, 0, movedItem);

    commands.reorder(newLayers.map((layer) => layer.id));
  };

  if (layers.length === 0) return null;

  return (
    <div className="ntl-outliner">
      <button className="ntl-outliner-header" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>Outliner {collapsed ? '▸' : '▾'}</button>
      {!collapsed && <div className="ntl-outliner-list">
        {layers.map((layer, index) => (
          <div 
            key={layer.id} 
            className={`ntl-outliner-row${selected === layer.id ? ' is-selected' : ''}`}
            draggable={editable}
            onDragStart={(e) => onDragStart(e, index)}
            onDragOver={onDragOver}
            onDrop={(e) => onDrop(e, index)}
          >
            <button
              aria-label={`Change ${layer.name} label`}
              disabled={!editable}
              className="ntl-outliner-label" 
              style={{ backgroundColor: LABEL_COLORS[layer.label] || LABEL_COLORS[0] }}
              onClick={() => cycleLabel(layer.id)}
              title="Click to change label color"
              aria-disabled={!editable}
            />
            <button className="ntl-outliner-name" aria-pressed={selected === layer.id} onClick={() => onSelect?.(layer.id)}>{layer.name}</button>
            <button 
              className={`ntl-outliner-eye ${layer.enabled ? 'is-on' : 'is-off'}`} 
              onClick={() => toggleVisibility(layer.id)}
              title="Toggle Visibility"
              disabled={!editable}
            >
              {layer.enabled ? '👁' : '－'}
            </button>
          </div>
        ))}
      </div>}
    </div>
  );
}
