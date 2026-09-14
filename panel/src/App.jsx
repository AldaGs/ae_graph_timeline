import SyncPanels from './components/SyncPanels.jsx';
// Presentational shell; lifecycle and host synchronization live in the hook.
import Canvas from './canvas/Canvas.jsx';
import Inspector from './components/Inspector.jsx';
import { Outliner } from './components/Outliner.jsx';
import { usePanelLifecycle } from './hooks/usePanelLifecycle.js';
import './App.css';

const LINK_LABEL = {
  live: 'Synced', reading: 'Reading', writing: 'Writing',
  changed: 'AE changed', blocked: 'Blocked', browser: 'Offline',
  error: 'Error', checking: 'Checking',
};

export default function App() {
  const { graph, version, selected, setSelected, message, setMessage, contextMenu, host, link, startup, drift, storageRef, saveStatus, saveGraph, canEdit, commands, handlePaneContextMenu, closeContextMenu, addEffectNode, addExpressionNode, ping, onGestureStart, onGestureEnd, addLayer, rename, remove, addFx, setBlend, counts, startEmptyGraph, createNewComp, inspectActiveComp, reviewSaved, keepGraph, useAeChanges } = usePanelLifecycle();

  return (
    <div className="ntl-app">
      <header className="ntl-bar">
        <span className="ntl-title">Node Timeline</span>

        <div className="ntl-actions">
          <button onClick={() => addLayer('solid')} disabled={!canEdit}>+ Solid</button>
          <button onClick={() => addLayer('null')} disabled={!canEdit}>+ Null</button>
          <button onClick={() => addLayer('text')} disabled={!canEdit}>+ Text</button>
          <button onClick={() => addLayer('shape')} disabled={!canEdit}>+ Shape</button>
          <button onClick={rename} disabled={!canEdit || !selected}>Rename</button>
          <button onClick={remove} disabled={!canEdit || !selected}>Delete</button>
          <button onClick={addFx} disabled={!canEdit || !selected}>+ Effect</button>
          <button onClick={setBlend} disabled={!canEdit || !selected}>Blend</button>
          <button onClick={saveGraph} disabled={!storageRef.current || !canEdit} title={saveStatus}>Save Graph</button>
        </div>

        <span className="ntl-count">{counts.nodes} nodes · {counts.edges} edges</span>

        <button className={`ntl-link is-${link.state}`} onClick={ping} title={link.detail}>
          <span className="ntl-dot" />
          {LINK_LABEL[link.state] || link.state}
        </button>
      </header>

      <div className="ntl-canvas" onClick={closeContextMenu}>
        <Canvas
          graph={graph}
          commands={commands}
          version={version}
          selectedId={selected}
          editable={canEdit}
          onError={setMessage}
          onSelect={setSelected}
          onPaneContextMenu={handlePaneContextMenu}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd}
        />
        {canEdit && contextMenu && (
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
        <Outliner graph={graph} commands={commands} version={version} editable={canEdit} selected={selected} onSelect={setSelected} />
        <Inspector graph={graph} selected={selected} commands={commands} editable={canEdit} onError={setMessage} />
        <SyncPanels {...{ host, startup, drift, startEmptyGraph, reviewSaved, createNewComp, inspectActiveComp, keepGraph, useAeChanges }} />
      </div>

      <footer className="ntl-foot">
        <span title={storageRef.current?.path}>{saveStatus}</span>
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
