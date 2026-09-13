import React, { useState, useEffect } from 'react';
import './Outliner.css';

const AE_LABEL_COLORS = [
  '#000000', // 0: None
  '#b53838', // 1: Red
  '#e4d84c', // 2: Yellow
  '#a9cbc7', // 3: Aqua
  '#e5bcca', // 4: Pink
  '#a9a9ca', // 5: Lavender
  '#e7c19e', // 6: Peach
  '#b3c7b3', // 7: Sea Foam
  '#677dbd', // 8: Blue
  '#4a9e4a', // 9: Green
  '#742774', // 10: Purple
  '#e8922f', // 11: Orange
  '#7a5233', // 12: Brown
  '#eb59a1', // 13: Fuchsia
  '#59a1eb', // 14: Cyan
  '#a1eb59', // 15: Sandstone
  '#5e5e5e'  // 16: Dark Gray
];

export function Outliner({ graph, version, onChanged }) {
  // Update state whenever the graph version changes
  const [layers, setLayers] = useState([]);

  useEffect(() => {
    const layerNodes = Object.values(graph.nodes)
      .filter(n => n.kind !== 'expression' && n.kind !== 'effect')
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    setLayers(layerNodes);
  }, [graph, version]);

  const toggleVisibility = (nodeId) => {
    const node = graph.nodes[nodeId];
    if (node) {
      node.enabled = !node.enabled;
      onChanged({ structural: false });
    }
  };

  const cycleLabel = (nodeId) => {
    const node = graph.nodes[nodeId];
    if (node) {
      node.label = ((node.label || 0) + 1) % 17;
      onChanged({ structural: false });
    }
  };

  // Basic HTML5 Drag and Drop for reordering
  const onDragStart = (e, index) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index.toString());
  };

  const onDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const onDrop = (e, targetIndex) => {
    e.preventDefault();
    const sourceIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (sourceIndex === targetIndex || isNaN(sourceIndex)) return;

    // We only reorder the managed layers.
    // To do this, we just extract the current array, move the item, and re-assign `order` to all.
    const newLayers = [...layers];
    const [movedItem] = newLayers.splice(sourceIndex, 1);
    newLayers.splice(targetIndex, 0, movedItem);

    // Now write back the orders (1-based to be safe)
    newLayers.forEach((layer, i) => {
      if (graph.nodes[layer.id]) {
        graph.nodes[layer.id].order = i + 1;
      }
    });

    onChanged({ structural: true });
  };

  if (layers.length === 0) return null;

  return (
    <div className="ntl-outliner">
      <div className="ntl-outliner-header">Outliner</div>
      <div className="ntl-outliner-list">
        {layers.map((layer, index) => (
          <div 
            key={layer.id} 
            className="ntl-outliner-row"
            draggable
            onDragStart={(e) => onDragStart(e, index)}
            onDragOver={onDragOver}
            onDrop={(e) => onDrop(e, index)}
          >
            <div 
              className="ntl-outliner-label" 
              style={{ backgroundColor: AE_LABEL_COLORS[layer.label] || AE_LABEL_COLORS[0] }}
              onClick={() => cycleLabel(layer.id)}
              title="Click to change label color"
            />
            <div className="ntl-outliner-name">{layer.name}</div>
            <button 
              className={`ntl-outliner-eye ${layer.enabled ? 'is-on' : 'is-off'}`} 
              onClick={() => toggleVisibility(layer.id)}
              title="Toggle Visibility"
            >
              {layer.enabled ? '👁' : '－'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
