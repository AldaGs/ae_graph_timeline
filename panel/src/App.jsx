// M1 — the panel shell.
//
// A canvas over the P1 graph model, docked in After Effects. What it does NOT
// do yet is write: M3 attaches the reconciler. The handshake below proves the
// transport is live (it reads `app.project.revision` through the same
// `NTL_Revision` entry point P1.4's drift gate uses), and the status line is
// explicit that nothing is being written - a panel that looked connected while
// silently doing nothing would be the worst of both.

import { useCallback, useEffect, useRef, useState } from 'react';

import Canvas from './canvas/Canvas.jsx';
import { createHost } from './bridge/cep.js';
import { createGraph, addNode, addEffect, BLEND_MODES } from '../../src/graph.js';
import { nextNodeId, renameNode, removeNode } from '../../src/view.js';
import { revisionCall, parseRevision } from '../../src/drift.js';
import './App.css';

// Something to look at on first run. Deliberately a graph and not a comp: M1 is
// the canvas over the model, and reading an existing comp into a graph is M3's
// problem (and, for a hand-built comp, explicitly out of the MVP).
function seedGraph() {
  const graph = createGraph();
  addNode(graph, { id: 'n1', name: 'Background', kind: 'solid',
    props: { position: [960, 540], scale: [100, 100], opacity: 100 }, ui: { x: 40, y: 40 } });
  addNode(graph, { id: 'n2', name: 'Card', kind: 'solid',
    props: { position: [960, 540], scale: [100, 100], opacity: 100 },
    effects: [{ matchName: 'ADBE Fill', name: 'Fill', params: { 'ADBE Fill-0002': [1, 0.5, 0, 1] } }],
    ui: { x: 360, y: 40 } });
  addNode(graph, { id: 'n3', name: 'Controller', kind: 'null',
    props: { position: [960, 540], rotation: 0 }, ui: { x: 360, y: 300 } });
  return graph;
}

export default function App() {
  // The graph is a plain object held in a ref, not React state: it is the source
  // of truth for the comp, and cloning it on every keystroke to satisfy React's
  // identity checks would make "the graph" an ambiguous thing. `version` is what
  // tells React something changed.
  const graph = useRef(seedGraph()).current;
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState(null);
  const [message, setMessage] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [host] = useState(() => createHost());
  const [link, setLink] = useState({ state: 'checking', detail: '' });

  const redraw = useCallback(() => setVersion((v) => v + 1), []);

  const handlePaneContextMenu = useCallback((event) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const addEffectNode = useCallback((matchName, name, props = {}, position) => {
    const id = nextNodeId(graph);
    addNode(graph, {
      id,
      kind: 'effect',
      name: `${name} ${id}`,
      matchName,
      props,
      ui: { x: position.x, y: position.y }
    });
    redraw();
  }, [graph, redraw]);

  const addExpressionNode = useCallback((position) => {
    const id = nextNodeId(graph);
    addNode(graph, {
      id,
      kind: 'expression',
      name: `Expr ${id}`,
      expression: 'value;',
      ui: { x: position.x, y: position.y }
    });
    redraw();
  }, [graph, redraw]);

  const ping = useCallback(async () => {
    if (!host.connected) {
      setLink({ state: 'browser', detail: 'no CEP host - the canvas works, After Effects is not there' });
      return;
    }
    try {
      const revision = parseRevision(await host.evalScript(revisionCall()));
      setLink({ state: 'live', detail: `project revision ${revision}` });
    } catch (e) {
      // The host answered with something that is not a revision. Almost always
      // the bundled host.jsx failing to load, which is worth saying plainly.
      setLink({ state: 'error', detail: e.message });
    }
  }, [host]);

  // Wire M3 write loop
  const loopRef = useRef(null);
  useEffect(() => {
    if (!host.connected) return;
    import('../../src/loop.js').then(({ createWriteLoop }) => {
      loopRef.current = createWriteLoop({ 
        host, 
        graph, 
        includeEffects: true,
        onSync: (status) => setLink({ state: 'live', detail: status })
      });
      // Initial flush
      loopRef.current.touch();
    });
    
    return () => loopRef.current?.close();
  }, [host, graph]);

  useEffect(() => { void ping(); }, [ping]);

  const onChanged = useCallback(({ structural }) => {
    if (structural) redraw();
    loopRef.current?.touch();
  }, [redraw]);

  const onGestureStart = useCallback(() => {
    loopRef.current?.gesture();
  }, []);

  const onGestureEnd = useCallback(() => {
    loopRef.current?.endGesture();
  }, []);

  const addLayer = useCallback((kind, position) => {
    const id = nextNodeId(graph);
    const names = {
      solid: 'Solid', null: 'Null', text: 'Text', shape: 'Shape',
      footage: 'Footage', precomp: 'Precomp', camera: 'Camera', light: 'Light',
    };
    const baseProps = (kind === 'null' || kind === 'camera' || kind === 'light')
      ? { position: [960, 540], rotation: 0 }
      : { position: [960, 540], scale: [100, 100], opacity: 100 };
      
    // ReactFlow positions are slightly offset by the canvas transform, but 
    // for MVP absolute mouse coords are close enough for a context menu drop.
    const x = position?.x ?? (40 + (Object.keys(graph.nodes).length % 4) * 300);
    const y = position?.y ?? (40 + Math.floor(Object.keys(graph.nodes).length / 4) * 260);

    addNode(graph, {
      id,
      kind,
      name: `${names[kind] || 'Layer'} ${id}`,
      props: baseProps,
      ui: { x, y },
    });
    redraw();
  }, [graph, redraw]);

  const rename = useCallback(() => {
    if (!selected) return;
    const wanted = window.prompt('Layer name', graph.nodes[selected]?.name ?? '');
    if (wanted === null) return;
    // Expressions address layers by name (S6), so the view layer makes it unique
    // rather than letting two layers answer to one expression.
    const settled = renameNode(graph, selected, wanted);
    if (settled !== wanted) setMessage(`named "${settled}" - two layers cannot share a name`);
    redraw();
  }, [graph, selected, redraw]);

  const remove = useCallback(() => {
    if (!selected) return;
    removeNode(graph, selected);
    setSelected(null);
    redraw();
  }, [graph, selected, redraw]);

  // M2: add an effect to the selected node by matchName
  const addFx = useCallback(() => {
    if (!selected) return;
    const matchName = window.prompt('Effect matchName (e.g. ADBE Gaussian Blur 2)');
    if (!matchName) return;
    const name = window.prompt('Display name', matchName);
    addEffect(graph, selected, { matchName, name: name || matchName, params: {} });
    redraw();
    setMessage(`added effect "${name || matchName}" to ${graph.nodes[selected]?.name}`);
  }, [graph, selected, redraw]);

  // M2: set blend mode on the selected node
  const setBlend = useCallback(() => {
    if (!selected) return;
    const node = graph.nodes[selected];
    if (!node) return;
    const mode = window.prompt(
      `Blend mode (${BLEND_MODES.join(', ')})`,
      node.blendMode || 'normal',
    );
    if (mode === null) return;
    if (!BLEND_MODES.includes(mode)) {
      setMessage(`unknown blend mode "${mode}"`);
      return;
    }
    node.blendMode = mode;
    redraw();
  }, [graph, selected, redraw]);

  const counts = {
    nodes: Object.keys(graph.nodes).length,
    edges: Object.keys(graph.edges).length,
  };

  return (
    <div className="ntl-app">
      <header className="ntl-bar">
        <span className="ntl-title">Node Timeline</span>

        <div className="ntl-actions">
          <button onClick={() => addLayer('solid')}>+ Solid</button>
          <button onClick={() => addLayer('null')}>+ Null</button>
          <button onClick={() => addLayer('text')}>+ Text</button>
          <button onClick={() => addLayer('shape')}>+ Shape</button>
          <button onClick={rename} disabled={!selected}>Rename</button>
          <button onClick={remove} disabled={!selected}>Delete</button>
          <button onClick={addFx} disabled={!selected}>+ Effect</button>
          <button onClick={setBlend} disabled={!selected}>Blend</button>
        </div>

        <span className="ntl-count">{counts.nodes} nodes · {counts.edges} edges</span>

        <button className={`ntl-link is-${link.state}`} onClick={ping} title={link.detail}>
          <span className="ntl-dot" />
          {link.state === 'live' ? 'After Effects' : link.state}
        </button>
      </header>

      <div className="ntl-canvas" onClick={closeContextMenu}>
        <Canvas
          graph={graph}
          version={version}
          onChanged={onChanged}
          onError={setMessage}
          onSelect={setSelected}
          onPaneContextMenu={handlePaneContextMenu}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd}
        />
        {contextMenu && (
          <div className="ntl-context-menu" style={{ top: contextMenu.y, left: contextMenu.x }}>
            <div className="ntl-menu-group">Layers</div>
            <button onClick={() => { addLayer('solid', contextMenu); closeContextMenu(); }}>Solid</button>
            <button onClick={() => { addLayer('null', contextMenu); closeContextMenu(); }}>Null</button>
            <button onClick={() => { addLayer('text', contextMenu); closeContextMenu(); }}>Text</button>
            <button onClick={() => { addLayer('shape', contextMenu); closeContextMenu(); }}>Shape</button>
            
            <div className="ntl-menu-group">Effects</div>
            <button onClick={() => { addEffectNode('ADBE Gaussian Blur 2', 'Gaussian Blur', {'ADBE Gaussian Blur 2-0001': 10}, contextMenu); closeContextMenu(); }}>Gaussian Blur</button>
            <button onClick={() => { addEffectNode('ADBE Tint', 'Tint', {}, contextMenu); closeContextMenu(); }}>Tint</button>
            <button onClick={() => { addEffectNode('ADBE Fill', 'Fill', {'ADBE Fill-0002': [1,0,0,1]}, contextMenu); closeContextMenu(); }}>Fill</button>

            <div className="ntl-menu-group">Logic</div>
            <button onClick={() => { addExpressionNode(contextMenu); closeContextMenu(); }}>Expression</button>
          </div>
        )}
      </div>

      <footer className="ntl-foot">
        <span className="ntl-foot-detail">{link.detail}</span>
        {message && (
          <button className="ntl-message" onClick={() => setMessage(null)} title="dismiss">
            {message}
          </button>
        )}
      </footer>
    </div>
  );
}

