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
import { createGraph, addNode } from '../../src/graph.js';
import { nextNodeId, renameNode, removeNode } from '../../src/view.js';
import { revisionCall, parseRevision } from '../../src/drift.js';
import './App.css';

// Something to look at on first run. Deliberately a graph and not a comp: M1 is
// the canvas over the model, and reading an existing comp into a graph is M4's
// problem (and, for a hand-built comp, explicitly out of the MVP).
function seedGraph() {
  const graph = createGraph();
  addNode(graph, { id: 'n1', name: 'Background', kind: 'solid',
    props: { position: [960, 540], scale: [100, 100], opacity: 100 }, ui: { x: 40, y: 40 } });
  addNode(graph, { id: 'n2', name: 'Card', kind: 'solid',
    props: { position: [960, 540], scale: [100, 100], opacity: 100 }, ui: { x: 360, y: 40 } });
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
  const [host] = useState(() => createHost());
  const [link, setLink] = useState({ state: 'checking', detail: '' });

  const redraw = useCallback(() => setVersion((v) => v + 1), []);

  // The handshake. One round trip through the gate P1.4 measured at 0.678 µs in
  // After Effects - the cheapest question the host can be asked.
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

  useEffect(() => { void ping(); }, [ping]);

  const onChanged = useCallback(({ structural }) => {
    // A redraw ONLY when the graph itself changed. A node that merely moved has
    // already been drawn by React Flow, and re-seeding the canvas for it would
    // rebuild every card - which is the flicker that made the whole CEP panel
    // blink on every drag.
    if (!structural) return;
    redraw();
    // Where M3 hooks in: `structural` is exactly the signal the write loop's
    // touch() wants. Until then it is shown rather than acted on, so what the
    // panel is and is not doing stays legible.
    setMessage('the graph changed - not written to After Effects yet (M3)');
  }, [redraw]);

  const addLayer = useCallback((kind) => {
    const id = nextNodeId(graph);
    addNode(graph, {
      id,
      kind,
      name: kind === 'null' ? `Null ${id}` : `Layer ${id}`,
      props: kind === 'null'
        ? { position: [960, 540], rotation: 0 }
        : { position: [960, 540], scale: [100, 100], opacity: 100 },
      // Dropped somewhere visible rather than at the origin, and staggered so a
      // run of them does not land in one pile.
      ui: { x: 40 + (Object.keys(graph.nodes).length % 4) * 300,
            y: 40 + Math.floor(Object.keys(graph.nodes).length / 4) * 260 },
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

  const counts = {
    nodes: Object.keys(graph.nodes).length,
    edges: Object.keys(graph.edges).length,
  };

  return (
    <div className="ntl-app">
      <header className="ntl-bar">
        <span className="ntl-title">Node Timeline</span>

        <div className="ntl-actions">
          <button onClick={() => addLayer('solid')}>Add solid</button>
          <button onClick={() => addLayer('null')}>Add null</button>
          <button onClick={rename} disabled={!selected}>Rename</button>
          <button onClick={remove} disabled={!selected}>Delete</button>
        </div>

        <span className="ntl-count">{counts.nodes} nodes · {counts.edges} edges</span>

        <button className={`ntl-link is-${link.state}`} onClick={ping} title={link.detail}>
          <span className="ntl-dot" />
          {link.state === 'live' ? 'After Effects' : link.state}
        </button>
      </header>

      <div className="ntl-canvas">
        <Canvas
          graph={graph}
          version={version}
          onChanged={onChanged}
          onError={setMessage}
          onSelect={setSelected}
        />
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
