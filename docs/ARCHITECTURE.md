# Panel architecture

## Ownership

The mutable graph is the desired state, not a copy of React Flow. The panel holds
one graph object; model functions replace its contents during recovery. React
owns selection, local editor drafts, viewport and in-progress drag positions.
Changes to AE go through the serialized write loop, never directly from a card.

| Module | Responsibility |
| --- | --- |
| `panel/src/App.jsx` | Presentational shell, toolbar and canvas composition |
| `hooks/usePanelLifecycle.js` | Startup, host events, undo history and conflict decisions |
| `hooks/useHostMonitoring.js` | Revision polling, active-comp watch and cleanup |
| `hooks/useGraphPersistence.js` | Sidecar status, immediate saves and coalesced autosaves |
| `components/SyncPanels.jsx` | Read-only/startup and conflict presentation |
| `panel/src/graphCommands.js` | Command labels, redraw, loop touch and save scheduling |
| `src/graph.js`, `src/view.js` | Exported model mutations and graph/flow translation |
| `src/diff.js`, `src/loop.js` | Desired-vs-observed changes, write sequencing and drift gate |
| `jsx/reader.jsx`, `jsx/patch.jsx` | Host reads and guarded writes in one undo group |
| `src/outline.js` | The outliner's tree, and the drag that turns it back into a flat AE order |
| `jsx/select.jsx`, `src/select.js` | Layer selection, so AE's Effect Controls and Properties panels follow the graph. No undo entry and no revision movement |

## Startup and failures

Startup reads project/comp identity, sidecar and host state before enabling edits.
Unique durable tags can rebind native IDs after reopening. Differences and backup
recovery require a decision; a missing or changed comp makes the panel read-only.
The browser demo is never seeded into a live composition.

Commands update the model, increment the view version and touch the loop. A gesture
holds writes until its end. The loop reads, diffs, verifies identity/revision and
patches. Post-patch observation captures AE parenting compensation and saves a
checkpoint. Partial reads and patch failures surface errors, not fabricated state.
An AE change matching recorded graph history can restore undo/redo; other changes
require a Keep Graph / Use AE Changes decision.

## Persistence

`.aep.comp-ID.ntl` stores graph, identity and last observed baseline. Saves retain
a backup and replace the main file using a temporary-file rename. Explicit Save
Graph and sync checkpoints save immediately. Typing/layout autosaves coalesce
for 250 ms; normal unload and inspecting another comp flush pending work. A process
crash can lose the pending interval. These are synchronous disk operations and
slow/network-backed storage can still stall the UI.

## Scale

Flow translation indexes driven inputs once. Display-data signatures detect
in-place model edits while retaining unchanged data identities for memoized cards.
This avoids unnecessary card renders; it does not eliminate linear view preparation.
Effect cycle detection is iterative, avoiding recursive stack limits and copied
trails. Reconciliation indexes flow membership once. Host scans include native IDs;
reorder membership is indexed instead of scanning every requested tag per layer.

The outliner is collapsible. Minimap rendering is disabled above 200 nodes as a
conservative provisional limit, not a measured CEP threshold. The shared display
palette supports indices 0–16; it does not read customized AE label preferences.
Production maps are omitted; set `NTL_SOURCEMAPS=1` for a diagnostic build.

See [performance measurements](PERFORMANCE.md) and the [open review findings](M4.7_REVIEW.md).
