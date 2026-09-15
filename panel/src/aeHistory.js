import { compareSnapshots, snapshot } from '../../src/drift.js';

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

function matchesComp(expected, current) {
  if (!expected) return false;
  const report = compareSnapshots(snapshot(expected), snapshot(current));
  return !report.drifted;
}

/**
 * History of patches authored by the panel, paired with the AE observations on
 * both sides of each undo entry.
 *
 * A graph snapshot alone is not enough to recognize an AE undo: creation fills
 * native ids and host-defaulted properties only in the post-patch observation,
 * and shared effects contain host-only expression-capability facts. Committing
 * history at `patched` therefore captured a state that had never existed. This
 * history commits only at `checkpoint`, when both sides are real.
 */
export function createAeHistory({ limit = 50 } = {}) {
  const undo = [];
  const redo = [];
  let pending = null;

  return {
    begin({ beforeGraph, afterGraph, beforeComp }) {
      pending = {
        beforeGraph: clone(beforeGraph),
        afterGraph: clone(afterGraph),
        beforeComp: clone(beforeComp),
        afterComp: null,
      };
    },

    checkpoint({ afterGraph, afterComp }) {
      if (!pending) return false;
      pending.afterGraph = clone(afterGraph);
      pending.afterComp = clone(afterComp);
      undo.push(pending);
      if (undo.length > limit) undo.shift();
      redo.length = 0;
      pending = null;
      return true;
    },

    cancel() { pending = null; },

    reset() {
      pending = null;
      undo.length = 0;
      redo.length = 0;
    },

    reconcile(compState) {
      if (!compState) return null;
      for (let i = undo.length - 1; i >= 0; i--) {
        const entry = undo[i];
        if (!matchesComp(entry.beforeComp, compState)) continue;
        const moved = undo.splice(i);
        redo.push(...moved.slice().reverse());
        return { direction: 'undo', graph: clone(moved[0].beforeGraph) };
      }
      for (let i = redo.length - 1; i >= 0; i--) {
        const entry = redo[i];
        if (!matchesComp(entry.afterComp, compState)) continue;
        redo.splice(i, 1);
        undo.push(entry);
        return { direction: 'redo', graph: clone(entry.afterGraph) };
      }
      return null;
    },

    get state() {
      return { undo: undo.length, redo: redo.length, pending: pending !== null };
    },
  };
}
