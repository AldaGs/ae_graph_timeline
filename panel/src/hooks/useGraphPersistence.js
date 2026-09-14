import { useCallback, useEffect, useRef, useState } from 'react';
import { serializeGraph } from '../../../src/persistence.js';

// Explicit saves/checkpoints are immediate. Coalesce typing and layout changes.
export function useGraphPersistence(graph) {
  const storageRef = useRef(null);
  const baselineRef = useRef(null);
  const [saveStatus, setSaveStatus] = useState('Graph not saved');
  const timerRef = useRef(null);
  const saveGraph = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    const storage = storageRef.current;
    if (!storage) return;
    try {
      const text = serializeGraph(graph, storage.identity, baselineRef.current, storage.graphId);
      storage.store.save(storage.path, text);
      storage.graphId = JSON.parse(text).graphId;
      setSaveStatus('Graph saved');
    } catch (e) { setSaveStatus(`Graph save failed: ${e.message}`); }
  }, [graph]);

  const scheduleSave = useCallback(() => {
    if (!storageRef.current) return;
    setSaveStatus('Graph changes pending save');
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(saveGraph, 250);
  }, [saveGraph]);
  const flushSave = useCallback(() => {
    if (timerRef.current !== null) saveGraph();
  }, [saveGraph]);
  useEffect(() => {
    window.addEventListener('beforeunload', flushSave);
    return () => {
      window.removeEventListener('beforeunload', flushSave);
      flushSave();
    };
  }, [flushSave]);
  return { storageRef, baselineRef, saveStatus, setSaveStatus, saveGraph, scheduleSave, flushSave };
}
