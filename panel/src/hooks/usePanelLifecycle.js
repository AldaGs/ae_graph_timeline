import { useGraphPersistence } from './useGraphPersistence.js';
import { useHostMonitoring } from './useHostMonitoring.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createGraphCommands } from '../graphCommands.js';
import { createHost } from '../bridge/cep.js';
import { createGraph, addNode, hydrateFromComp, replaceGraph } from '../../../src/graph.js';
import { diff } from '../../../src/diff.js';
import { revisionCall, parseRevision, compareSnapshots, snapshot } from '../../../src/drift.js';
import { captureCompState, classifyDrift } from '../../../src/reconcile.js';
import { createGraphStore, inspectSavedGraph } from '../../../src/persistence.js';
import {
  selectionTagsFor, selectLayersCall, parseSelection, showEffectControlsCall,
} from '../../../src/select.js';
import {
  readCompCall, parseCompState, newCompDialogCall, parseNewCompDialog,
  graphFilePathFor,
} from '../../../src/reader.js';

// Browser-only fixture. A live AE comp is never seeded automatically.
function seedGraph(graph) {
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

export function usePanelLifecycle() {
  // The graph is a plain object held in a ref, not React state: it is the source
  // of truth for the comp, and cloning it on every keystroke to satisfy React's
  // identity checks would make "the graph" an ambiguous thing. `version` is what
  // tells React something changed.
  const graph = useRef(createGraph()).current;
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState(null);
  const [message, setMessage] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [host] = useState(() => createHost());
  const [link, setLink] = useState({ state: 'checking', detail: '' });
  const [startup, setStartup] = useState({ state: 'loading', detail: 'Inspecting the active composition…' });
  const [drift, setDrift] = useState(null);
  const loopRef = useRef(null);
  const loopEventsRef = useRef(null);
  const inspectRef = useRef(null);
  const activeCompRef = useRef(null);
  const lastSyncedGraphRef = useRef(null);
  const pendingHistoryRef = useRef(null);
  const undoHistoryRef = useRef([]);
  const redoHistoryRef = useRef([]);
  const reconcileHistoryRef = useRef(null);
  const adoptDriftRef = useRef(null);
  const compFrameRef = useRef({ width: 1920, height: 1080 });
  const { storageRef, baselineRef, saveStatus, setSaveStatus, saveGraph, scheduleSave, flushSave } = useGraphPersistence(graph);
  const canEdit = (!host.connected || startup.state === 'ready') && !drift;

  const redraw = useCallback(() => setVersion((v) => v + 1), []);
  const cloneGraph = useCallback(() => JSON.parse(JSON.stringify(graph)), [graph]);
  const restoreGraph = useCallback((saved) => {
    replaceGraph(graph, saved);
    setSelected(null);
    setContextMenu(null);
    redraw();
  }, [graph, redraw]);
  const commands = useMemo(() => createGraphCommands({
    graph,
    getLoop: () => loopRef.current,
    redraw,
    setSelected,
    onChange: scheduleSave,
    getCompSize: () => compFrameRef.current,
  }), [graph, redraw, scheduleSave]);

  const handlePaneContextMenu = useCallback((event, position) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, position });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const addEffectNode = useCallback((matchName, name, props = {}, position) => {
    commands.addEffectNode(matchName, name, props, position?.position || position);
  }, [commands]);

  const addExpressionNode = useCallback((position) => {
    commands.addExpressionNode(position?.position || position);
  }, [commands]);

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

  // Load the graph and attach the serialized write loop
  useEffect(() => {
    let cancelled = false;
    let retryHandle = null;
    let inspecting = false;

    if (!host.connected) {
      seedGraph(graph);
      redraw();
      setStartup({ state: 'ready', detail: 'Browser preview — changes are local only.' });
      return;
    }

    async function inspectComp() {
      if (cancelled || inspecting) return;
      inspecting = true;
      try {
        flushSave();
        storageRef.current = null;
        const identity = JSON.parse(await host.evalScript('NTL_ProjectIdentity()'));
        let saved = null;
        const nodeRequire = window.cep_node?.require || window.require;
        if (identity.projectPath && identity.compId && nodeRequire) {
          const store = createGraphStore(nodeRequire('fs'));
          const path = graphFilePathFor(identity.projectPath, identity.compId);
          saved = store.load(path);
          if (saved && (saved.document.identity.projectPath !== identity.projectPath
              || saved.document.identity.compId !== identity.compId)) throw new Error('Saved graph belongs to another project or composition');
          storageRef.current = { store, path, identity, graphId: saved?.document.graphId };
          setSaveStatus(saved?.recovered ? 'Recovered graph backup — review before saving'
            : saved ? `Loaded graph saved ${saved.document.savedAt}` : 'Graph storage ready');
        } else setSaveStatus('Save the AE project, then reopen the panel to enable graph saving');
        const json = await host.evalScript(readCompCall({ includeEffects: true }));
        const compState = parseCompState(json);
        if (cancelled) return;
        if (identity.compId !== compState.compId) throw new Error('Active composition changed during graph loading');
        activeCompRef.current = { compId: compState.compId, compName: compState.compName };
        // A new layer is centred in THIS comp, not in a hardcoded 1920x1080 one.
        if (compState.width && compState.height) {
          compFrameRef.current = { width: compState.width, height: compState.height };
        }

        replaceGraph(graph, createGraph());
        if (saved) {
          replaceGraph(graph, saved.document.graph);
        } else hydrateFromComp(graph, compState);
        baselineRef.current = saved?.document.baseline || compState;
        redraw();
        lastSyncedGraphRef.current = cloneGraph();
        undoHistoryRef.current = [];
        redoHistoryRef.current = [];

        const inspected = inspectSavedGraph(graph, saved?.document.baseline, compState);
        const { diagnostic, baselineChanged } = inspected;
        replaceGraph(graph, inspected.graph);
        if (!loopRef.current) {
          const { createWriteLoop } = await import('../../../src/loop.js');
          if (cancelled) return;
          loopRef.current = createWriteLoop({ host, graph, compId: compState.compId, includeEffects: true, observeAfterPatch: true });
          loopEventsRef.current = loopRef.current.on((event) => {
            if (event.type === 'reading') setLink({ state: 'reading', detail: 'Reading composition…' });
            else if (event.type === 'patching') {
              pendingHistoryRef.current = {
                before: lastSyncedGraphRef.current || cloneGraph(),
                after: cloneGraph(),
              };
              setLink({ state: 'writing', detail: `Writing ${event.ops.length} change${event.ops.length === 1 ? '' : 's'}…` });
            } else if (event.type === 'patched') {
              if (pendingHistoryRef.current) {
                undoHistoryRef.current.push(pendingHistoryRef.current);
                if (undoHistoryRef.current.length > 50) undoHistoryRef.current.shift();
                redoHistoryRef.current = [];
                lastSyncedGraphRef.current = pendingHistoryRef.current.after;
                pendingHistoryRef.current = null;
              }
              setLink({ state: 'live', detail: `Synced — ${event.ops.length} change${event.ops.length === 1 ? '' : 's'}` });
            } else if (event.type === 'clean') {
              lastSyncedGraphRef.current = cloneGraph();
              pendingHistoryRef.current = null;
              setLink({ state: 'live', detail: 'Synced' });
            } else if (event.type === 'checkpoint') {
              baselineRef.current = event.compState;
              lastSyncedGraphRef.current = cloneGraph();
              redraw();
              saveGraph();
            } else if (event.type === 'observed') {
              reconcileHistoryRef.current?.(event.compState);
              if (diff(graph, event.compState).ops.length === 0) {
                baselineRef.current = event.compState;
                saveGraph();
              }
            } else if (event.type === 'drift') {
              if (reconcileHistoryRef.current?.(event.compState)) return;
              // Non-blocking drift is an ordinary edit in the timeline, and the
              // panel used to answer it by demanding that the user choose a
              // source of truth - which froze every control until they did, for
              // nudging a value. It is adopted instead, and only drift that
              // invalidates an identity, or that collides with unwritten graph
              // changes, is still a decision.
              if (adoptDriftRef.current?.(event)) return;
              setDrift({ report: event.report, compState: event.compState });
              setLink({ state: event.report.blocking.length ? 'blocked' : 'changed', detail: 'After Effects changed outside Node Timeline' });
            } else if (event.type === 'failed' || event.type === 'readFailed' || event.type === 'error') {
              pendingHistoryRef.current = null;
              setLink({ state: 'error', detail: event.message || 'Synchronization failed' });
            }
          });
        }

        if (Object.keys(graph.nodes).length === 0) {
          setStartup({
            state: 'empty',
            detail: compState.layers.length === 0
              ? 'The active composition is empty. Start a graph when you are ready.'
              : 'No Node Timeline layers were found. Existing AE layers will remain untouched.',
          });
        } else if (diagnostic.ops.length > 0 || baselineChanged || saved?.recovered) {
          setStartup({
            state: 'needs-decision',
            detail: `${saved ? 'Saved graph differs from AE' : 'Recovered layers are incomplete'} and would produce ${diagnostic.ops.length} AE changes. Review the graph before choosing a version.`,
          });
        } else {
          baselineRef.current = compState;
          lastSyncedGraphRef.current = cloneGraph();
          saveGraph();
          setStartup({ state: 'ready', detail: `Recovered ${Object.keys(graph.nodes).length} managed layer${Object.keys(graph.nodes).length === 1 ? '' : 's'} without pending writes.` });
        }
      } catch (e) {
        if (cancelled) return;
        const noComp = /no composition/i.test(e.message);
        setStartup({
          state: noComp ? 'no-comp' : 'error',
          detail: noComp ? 'Open a composition to use Node Timeline.' : `Startup read failed: ${e.message}`,
        });
        setLink({ state: noComp ? 'live' : 'error', detail: e.message });
        if (noComp) retryHandle = window.setTimeout(() => void inspectComp(), 1000);
      } finally {
        inspecting = false;
      }
    }

    inspectRef.current = inspectComp;
    void inspectComp();
    
    return () => {
      cancelled = true;
      inspectRef.current = null;
      activeCompRef.current = null;
      if (retryHandle !== null) window.clearTimeout(retryHandle);
      loopEventsRef.current?.();
      loopEventsRef.current = null;
      void loopRef.current?.close();
      loopRef.current = null;
    };
  }, [host, graph, redraw, cloneGraph, saveGraph, flushSave]);

  // Selecting a node selects its layer.
  //
  // After Effects' Effect Controls and Properties panels follow the layer
  // SELECTION and nothing else, so a node selected on the canvas has to become
  // a selected layer or those panels cannot know what the user is looking at -
  // which meant a node carrying effects could be selected in the graph with no
  // way to reach those effects in the application that renders them.
  //
  // Selection is view state: it takes no undo entry and does not move
  // app.project.revision, so this cannot disturb the write loop or the drift
  // guard. It is still coalesced, because arrowing through the outliner would
  // otherwise be one host round trip per keystroke.
  useEffect(() => {
    if (!host.connected || startup.state !== 'ready') return;
    const compId = activeCompRef.current?.compId;
    if (!compId) return;
    const handle = window.setTimeout(async () => {
      // Never mid-patch: the loop is holding the transport, and a selection is
      // never worth waiting behind a write for.
      const state = loopRef.current?.state;
      if (host.busy || state?.inFlight || state?.gestureDepth > 0) return;
      const tags = selectionTagsFor(graph, selected === null ? [] : [selected]);
      try {
        parseSelection(await host.evalScript(selectLayersCall(tags, { compId })));
      } catch {
        // A selection that did not land is not worth a message: the comp may
        // have changed under it, and the identity watch reports that already.
      }
    }, 80);
    return () => window.clearTimeout(handle);
  }, [host, startup.state, graph, selected, version]);

  // Opening a panel is a decision about the user's workspace, so it happens on
  // an explicit action and never as a side effect of clicking a node.
  const showEffectControls = useCallback(async () => {
    if (!host.connected) return;
    try {
      parseSelection(await host.evalScript(showEffectControlsCall()));
    } catch (e) { setMessage(e.message); }
  }, [host]);

  // The project moved, and the graph's sidecar file did not.
  //
  // `Save As` changes nothing the reconciler cares about - the comp keeps its
  // id and the graph keeps every node - but the sidecar is named after the
  // project file, so it stays next to the OLD .aep where reopening the new one
  // will never find it. The graph is already in memory, so nothing has to be
  // copied: the storage is re-pointed and saved again at the new path.
  //
  // With one refusal. A sidecar ALREADY at the new path, holding a different
  // graph, belongs to whatever was saved there before, and overwriting it
  // without being asked would destroy someone's work. The storage is still
  // re-pointed - so the Save Graph button writes there deliberately - but
  // nothing is written automatically.
  const rebindStorage = useCallback((projectPath) => {
    const compId = activeCompRef.current?.compId;
    const path = graphFilePathFor(projectPath, compId);
    if (!path) {
      storageRef.current = null;
      setSaveStatus('The project is unsaved — save it to store this graph');
      return;
    }
    const nodeRequire = window.cep_node?.require || window.require;
    if (!nodeRequire) return;
    const previous = storageRef.current;
    if (previous?.path === path) return;
    const store = previous?.store || createGraphStore(nodeRequire('fs'));
    const identity = { projectPath, compId };
    let existing = null;
    try {
      existing = store.load(path);
    } catch { /* unreadable is treated the same as occupied: do not auto-save */ }
    storageRef.current = { store, path, identity, graphId: previous?.graphId };
    const occupied = existing && existing.document.graphId !== previous?.graphId;
    if (occupied) {
      setSaveStatus('A different graph is already saved for this project — use Save Graph to replace it');
      return;
    }
    saveGraph();
  }, [storageRef, setSaveStatus, saveGraph, activeCompRef]);

  // Drift that does not invalidate an identity is the user editing their own
  // comp, and the graph adopts it rather than asking who is in charge.
  //
  // Two conditions, both necessary. The report must carry no BLOCKING change -
  // a vanished layer, a duplicated tag, an expression taken over by hand - and
  // the graph must have nothing of its own waiting to be written. A dirty graph
  // plus an AE edit is a genuine collision between two intentions, and that is
  // the one case where only the user can say which wins.
  useEffect(() => {
    adoptDriftRef.current = (event) => {
      const report = event?.report;
      const compState = event?.compState;
      const loop = loopRef.current;
      if (!loop || loop.state.gestureDepth > 0) return false;
      if (classifyDrift({ report, compState, dirty: loop.state.dirty }) !== 'adopt') return false;
      let captured;
      try {
        // Refuses rather than half-adopts: anything the graph cannot represent
        // leaves a pending write behind, and that has to become a decision.
        captured = captureCompState(graph, compState);
      } catch {
        return false;
      }
      restoreGraph(captured.graph);
      lastSyncedGraphRef.current = captured.graph;
      undoHistoryRef.current = [];
      redoHistoryRef.current = [];
      loop.adoptCompState(compState);
      baselineRef.current = compState;
      saveGraph();
      setLink({ state: 'live',
        detail: `Adopted ${report.changes.length} change${report.changes.length === 1 ? '' : 's'} from After Effects` });
      return true;
    };
    return () => { adoptDriftRef.current = null; };
  }, [graph, restoreGraph, saveGraph, baselineRef]);

  // AE undo/redo is adopted only when the comp exactly matches a graph state
  // previously written by this panel. Arbitrary AE edits still enter drift UX.
  useEffect(() => {
    const matches = (saved, compState) => saved && diff(saved, compState).ops.length === 0;
    reconcileHistoryRef.current = (compState) => {
      if (!compState) return false;
      const undo = undoHistoryRef.current;
      for (let i = undo.length - 1; i >= 0; i--) {
        if (!matches(undo[i].before, compState)) continue;
        const moved = undo.splice(i);
        redoHistoryRef.current.push(...moved.reverse());
        const restored = moved[moved.length - 1].before;
        restoreGraph(restored);
        lastSyncedGraphRef.current = restored;
        loopRef.current?.adoptCompState(compState);
        setLink({ state: 'live', detail: 'AE undo reflected in graph' });
        return true;
      }
      const redo = redoHistoryRef.current;
      for (let i = redo.length - 1; i >= 0; i--) {
        if (!matches(redo[i].after, compState)) continue;
        const entry = redo.splice(i, 1)[0];
        undoHistoryRef.current.push(entry);
        restoreGraph(entry.after);
        lastSyncedGraphRef.current = entry.after;
        loopRef.current?.adoptCompState(compState);
        setLink({ state: 'live', detail: 'AE redo reflected in graph' });
        return true;
      }
      return false;
    };
    return () => { reconcileHistoryRef.current = null; };
  }, [restoreGraph]);

  useHostMonitoring({ host, startup, loopRef, activeCompRef, loopEventsRef, inspectRef,
    setLink, setSelected, setContextMenu, setStartup, rebindStorage, storageRef });

  useEffect(() => { void ping(); }, [ping]);

  const onGestureStart = useCallback(() => {
    commands.beginGesture('Edit graph');
  }, [commands]);

  const onGestureEnd = useCallback(() => {
    void commands.endGesture().catch((e) => setMessage(e.message));
  }, [commands]);

  const addLayer = useCallback((kind, position) => {
    const node = commands.addLayer(kind, position?.position || position);
    setSelected(node.id);
  }, [commands]);

  const rename = useCallback(() => {
    document.getElementById('ntl-inspector-name')?.focus();
  }, []);

  const remove = useCallback(() => {
    document.getElementById('ntl-inspector-delete')?.click();
  }, []);

  // Focus the inspector's effect picker.
  const addFx = useCallback(() => {
    const section = document.getElementById('ntl-inspector-effects');
    if (section) { section.open = true; section.querySelector('input')?.focus(); }
  }, []);

  // Focus the inspector's blend control.
  const setBlend = useCallback(() => {
    document.getElementById('ntl-inspector-blend')?.focus();
  }, []);

  const counts = {
    nodes: Object.keys(graph.nodes).length,
    edges: Object.keys(graph.edges).length,
  };

  const startEmptyGraph = useCallback(() => {
    if (startup.state !== 'empty' || !loopRef.current) return;
    setStartup({ state: 'ready', detail: 'Empty graph ready. Existing unmanaged AE layers remain untouched.' });
  }, [startup.state]);

  const createNewComp = useCallback(async () => {
    if (!host.connected || startup.state === 'loading') return;
    setStartup({ state: 'loading', detail: 'Waiting for After Effects composition settings…' });
    // executeCommand blocks inside After Effects until the user answers, and
    // every observation that arrives meanwhile is a script AE will refuse while
    // its dialog is up. Nothing polls until the dialog is closed.
    host.beginModal();
    try {
      const result = parseNewCompDialog(await host.evalScript(newCompDialogCall()));
      if (!result.created) {
        setStartup({ state: 'no-comp', detail: 'New Composition was cancelled. Open or create a composition to continue.' });
        return;
      }
      setLink({ state: 'live', detail: `Created ${result.compName}` });
      await inspectRef.current?.();
    } catch (e) {
      setStartup({ state: 'error', detail: `Could not create composition: ${e.message}` });
      setLink({ state: 'error', detail: e.message });
    } finally {
      host.endModal();
    }
  }, [host, startup.state]);

  const inspectActiveComp = useCallback(async () => {
    if (startup.state !== 'comp-changed') return;
    setStartup({ state: 'loading', detail: 'Inspecting the selected composition…' });
    await inspectRef.current?.();
  }, [startup.state]);

  const reviewSaved = useCallback(async () => {
    try {
      const current = parseCompState(await host.evalScript(readCompCall({ compId: activeCompRef.current?.compId, includeEffects: true })));
      const report = compareSnapshots(snapshot(baselineRef.current || current), snapshot(current));
      const proposed = diff(graph, current);
      for (const op of proposed.ops) {
        report.changes.push({ kind: 'proposedWrite', node: op.node,
          message: `Pending graph change: ${op.op}${op.prop ? ` (${op.prop})` : ''}`
            + (op.from !== undefined ? ` — AE: ${JSON.stringify(op.from)}` : '')
            + (op.to !== undefined ? `; graph: ${JSON.stringify(op.to)}` : '')
            + (op.tags ? ` — order: ${op.tags.join(', ')}` : '') });
      }
      if (!report.changes.length) report.changes.push({ message: 'The saved graph contains changes not yet applied to AE.', kind: 'pendingGraph' });
      setDrift({ report, compState: current });
      setStartup({ state: 'ready', detail: 'Review saved graph' });
    } catch (e) { setMessage(e.message); }
  }, [host]);

  const keepGraph = useCallback(async () => {
    if (!drift || !loopRef.current) return;
    setDrift(null);
    setLink({ state: 'live', detail: 'Applying graph state to After Effects…' });
    const result = await loopRef.current.acceptDrift();
    if (result.status === 'failed' || result.status === 'readFailed' || result.status === 'error') {
      setMessage(result.error?.message || 'Could not apply graph state');
    }
  }, [drift]);

  const useAeChanges = useCallback(() => {
    if (!drift || !loopRef.current) return;
    try {
      const captured = captureCompState(graph, drift.compState);
      restoreGraph(captured.graph);
      lastSyncedGraphRef.current = captured.graph;
      undoHistoryRef.current = [];
      redoHistoryRef.current = [];
      loopRef.current.adoptCompState(drift.compState);
      baselineRef.current = drift.compState;
      saveGraph();
      setDrift(null);
      setLink({ state: 'live', detail: captured.warnings.length ? `AE changes captured with ${captured.warnings.length} warning(s)` : 'AE changes captured in graph' });
    } catch (e) {
      setMessage(e.message);
    }
  }, [drift, graph, restoreGraph, saveGraph]);

  return { showEffectControls, graph, version, selected, setSelected, message, setMessage, contextMenu, host, link, startup, drift, storageRef, saveStatus, saveGraph, canEdit, commands, handlePaneContextMenu, closeContextMenu, addEffectNode, addExpressionNode, ping, onGestureStart, onGestureEnd, addLayer, rename, remove, addFx, setBlend, counts, startEmptyGraph, createNewComp, inspectActiveComp, reviewSaved, keepGraph, useAeChanges };
}
