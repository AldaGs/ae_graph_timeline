import { addNode, addEffect, defaultLayerProps, moveNode, setEffectParam, setNodeExpression, setNodeProperty, setNodeField, reorderNodes } from '../../src/graph.js';
import {
  connect, connectExpression, connectFlow, connectParent,
  disconnect, handleMeta, nextNodeId, removeNode, renameNode,
} from '../../src/view.js';

const LAYER_NAMES = {
  solid: 'Solid', null: 'Null', text: 'Text', shape: 'Shape',
  footage: 'Footage', precomp: 'Precomp', camera: 'Camera', light: 'Light',
};

/**
 * The panel's single mutation boundary.
 *
 * Every comp-affecting command mutates the graph, redraws the panel, and marks
 * the write loop dirty with a useful undo label. Canvas-only movement redraws
 * without touching AE.
 */
export function createGraphCommands({ graph, getLoop, redraw, setSelected = () => {},
                                     onChange = () => {}, getCompSize = () => ({}) }) {
  if (!graph) throw new Error('graph commands need a graph');
  const repaint = typeof redraw === 'function' ? redraw : () => {};
  const loop = () => getLoop?.() ?? null;

  const commit = (label, result, { draw = true, write = true } = {}) => {
    if (draw) repaint();
    if (write) loop()?.touch(label);
    onChange();
    return result;
  };

  return {
    setProperty(nodeId, prop, value) {
      const node = setNodeProperty(graph, nodeId, prop, value);
      return commit(`Set ${node.name} ${prop}`, value);
    },
    addLayer(kind, position) {
      const id = nextNodeId(graph);
      const count = Object.keys(graph.nodes).length;
      const x = position?.x ?? (40 + (count % 4) * 300);
      const y = position?.y ?? (40 + Math.floor(count / 4) * 260);
      const node = addNode(graph, {
        id, kind, name: `${LAYER_NAMES[kind] || 'Layer'} ${id}`,
        // The comp's own frame, so a new layer lands in the middle of THIS comp
        // rather than in the middle of a 1920x1080 one.
        props: defaultLayerProps(kind, getCompSize() || {}), ui: { x, y },
      });
      return commit(`Add ${node.name}`, node);
    },

    addEffectNode(matchName, name, props = {}, position = { x: 40, y: 40 }) {
      const id = nextNodeId(graph);
      const node = addNode(graph, {
        id, kind: 'effect', name: `${name} ${id}`, matchName, props,
        ui: { x: position.x, y: position.y },
      });
      return commit(`Add ${node.name}`, node);
    },

    addExpressionNode(position = { x: 40, y: 40 }) {
      const id = nextNodeId(graph);
      const node = addNode(graph, {
        id, kind: 'expression', name: `Expr ${id}`, expression: 'value;',
        ui: { x: position.x, y: position.y },
      });
      return commit(`Add ${node.name}`, node);
    },

    rename(nodeId, wanted) {
      const settled = renameNode(graph, nodeId, wanted);
      return settled === null ? null : commit(`Rename ${settled}`, settled);
    },

    remove(nodeId) {
      if (!removeNode(graph, nodeId)) return false;
      setSelected(null);
      return commit(`Delete ${nodeId}`, true);
    },

    setEffectParam(nodeId, effectIndex, param, value) {
      const effect = setEffectParam(graph, nodeId, effectIndex, param, value);
      return commit(`Set ${effect.name} ${param}`, value);
    },

    addInlineEffect(nodeId, effect) {
      const entry = addEffect(graph, nodeId, effect);
      return commit(`Add ${entry.name} effect`, entry);
    },

    setBlendMode(nodeId, mode) {
      const node = setNodeField(graph, nodeId, 'blendMode', mode);
      if (!node) return null;
      return commit(`Set ${node.name} blend mode`, mode);
    },

    setExpression(nodeId, expression) {
      const node = setNodeExpression(graph, nodeId, expression);
      if (!node) return null;
      return commit(`Edit ${node.name} expression`, node, { draw: false });
    },

    setEnabled(nodeId, enabled) {
      const node = setNodeField(graph, nodeId, 'enabled', enabled);
      if (!node) return null;
      return commit(`${enabled ? 'Show' : 'Hide'} ${node.name}`, enabled);
    },

    setText(nodeId, text) {
      const node = setNodeField(graph, nodeId, 'text', text);
      if (!node) return null;
      return commit(`Edit ${node.name} text`, text);
    },

    setLabel(nodeId, label) {
      const node = setNodeField(graph, nodeId, 'label', label);
      if (!node) return null;
      return commit(`Set ${node.name} label`, label);
    },

    reorder(nodeIds) {
      const changed = reorderNodes(graph, nodeIds);
      return changed ? commit('Reorder layers', true) : false;
    },

    connect(connection) {
      return commit('Connect nodes', connect(graph, connection));
    },

    connectFlow(connection) {
      return commit('Connect effect flow', connectFlow(graph, connection));
    },

    connectExpression(connection) {
      return commit('Connect expression', connectExpression(graph, connection));
    },

    connectParent(connection) {
      return commit('Set parent', connectParent(graph, connection));
    },

    connectTyped(connection) {
      const from = handleMeta(connection.sourceHandle);
      const to = handleMeta(connection.targetHandle);
      if (from?.type === 'flow' || to?.type === 'flow') return this.connectFlow(connection);
      if (from?.type === 'parent' || to?.type === 'parent') return this.connectParent(connection);
      return this.connectExpression(connection);
    },

    disconnect(edgeId) {
      const result = disconnect(graph, edgeId);
      return result ? commit('Disconnect nodes', result) : null;
    },

    removeFromCanvas(nodeId) {
      return this.remove(nodeId);
    },

    moveNodes(nodes) {
      for (const node of nodes) moveNode(graph, node.id, node.position.x, node.position.y);
      return commit('Move nodes', true, { write: false });
    },

    beginGesture(label) {
      // A closed loop throws, and closing one is an ordinary event: the comp
      // changed, or After Effects is quitting. A gesture opening across that
      // moment must not take the drag down with it - the graph is still the
      // graph, and the panel is still usable without a loop behind it.
      try {
        return loop()?.beginGesture(label) ?? 0;
      } catch {
        return 0;
      }
    },

    endGesture() {
      const current = loop();
      if (!current || current.state.gestureDepth === 0) return Promise.resolve({ status: 'idle' });
      try {
        return current.endGesture();
      } catch (e) {
        return Promise.resolve({ status: 'idle', error: e });
      }
    },
  };
}
