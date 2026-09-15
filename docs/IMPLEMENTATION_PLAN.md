# Node Timeline — Product Hardening Implementation Plan

**Status: M4.13 LIVE FUNCTIONAL MATRIX PASSED; SCALE GATE OPEN. M4.6 REMAINING UX IS STILL OPEN.**

The consolidated host matrix, fixtures, evidence format, and closeout rules now
live in [`M4.13.md`](M4.13.md). Earlier phase checklists remain the source for
the behavior they introduced; M4.13 is the single record of the live run.

This plan turns the 2026-09-14 product review into a safe sequence of changes.
Its first goal is preventing accidental After Effects mutations; its second is
making every visible panel action reliable and understandable; its third is
improving the editing experience and scaling the diff path.

The plan deliberately finishes M3/M4 before adding broader M5/M6 product work.
Each phase must leave the panel safer and independently testable.

---

## Definition of done

The hardening work is complete when:

1. Opening or reopening the panel never writes to AE without a complete graph or
   an explicit user action.
2. Every user-visible edit goes through one command path, redraws immediately,
   and reaches AE in one correctly labelled undo entry.
3. Flow, expression, property, and parenting connections are distinguishable and
   invalid connections are rejected before they mutate the graph.
4. The panel polls for drift, explains conflicts, and lets the user choose which
   state wins.
5. The graph persists and reopens without losing layout or graph-only topology.
6. Core, React integration, build, and manual AE checks are green.

---

## M4.1 — Safety stop

**Outcome:** merely opening the extension is read-only.

### Progress

- [x] Live AE sessions no longer seed demo layers.
- [x] Startup no longer calls `touch()` or applies a patch.
- [x] Startup distinguishes loading, empty, incomplete recovery, ready, no-comp,
  and error states.
- [x] Mutating canvas, toolbar, context-menu, and outliner controls are disabled
  until startup is ready.
- [x] Hydration is followed by a read-only diagnostic diff; a non-empty result
  leaves the panel locked and explains how many writes it would have produced.
- [x] Empty graphs require an explicit “Start an empty graph” action.
- [x] The no-comp state offers “Create New Comp…” and opens AE's native New
  Composition dialog so the user can choose presets and every composition
  parameter; a confirmed comp is inspected immediately and cancel is harmless.
- [x] While no comp is active, the panel checks once per second and transitions
  automatically when the user opens or creates one in AE.
- [x] Active-comp identity is watched independently of project revision. Deleting
  the tracked comp or activating another comp (including a duplicate) closes the
  write loop, retains the graph read-only, and requires explicit inspection.
- [x] Core tests, ExtendScript preflight, and production build pass.
- [ ] Add automated React startup tests with an instrumented fake host.
- [ ] Run and record the manual AE startup matrix.

### Implementation

- Remove the live-host `seedGraph()` fallback. Keep sample data only in browser
  development, behind an explicit fixture or query flag.
- Do not call `loop.touch()` after hydration.
- Add a startup state machine:
  `loading → empty | recovered | needs-decision | ready | error`.
- Run a pure diff after hydration as a diagnostic, but never apply it. If it is
  non-empty, show what would change and remain read-only.
- Disable mutating controls until startup reaches `ready`.
- Treat “no active comp” as a normal empty state, not as a generic error.

### Tests

- Opening with no active comp performs zero writes.
- Opening an empty comp performs zero writes and creates no demo layers.
- Opening a comp containing only unmanaged layers performs zero writes.
- Opening a previously managed comp with expressions and parenting performs zero
  writes even when hydration is incomplete.
- A startup read failure leaves all editing controls disabled.

### Acceptance gate

Instrument `host.evalScript`: startup may call revision/read functions, but must
never call `NTL_ApplyPatch`.

---

## M4.2 — Unified command path and gesture repair

**Outcome:** every edit behaves the same regardless of where it originated.

### Progress

- [x] Added `panel/src/graphCommands.js` as the single panel mutation boundary.
- [x] Toolbar, context-menu, canvas, expression, and outliner edits use commands
  that redraw and call `touch(label)` consistently.
- [x] Canvas-only node movement redraws without writing AE.
- [x] Replaced the invalid zero-argument `gesture()` call with paired
  `beginGesture()` / `endGesture()` handling; a no-movement drag still closes.
- [x] Added loop lifecycle events for reading and patching and connected panel
  status text to loop events.
- [x] Added focused command and lifecycle tests.
- [x] Selection is controlled by the panel: toolbar focus no longer clears it,
  blank-canvas clicks clear intentionally, and redraws preserve the highlight.
- [ ] Add DOM-level React tests for focus, pointer, keyboard, and unmount paths.
- [ ] Run and record the manual AE interaction matrix.

### Implementation

- Add a panel command layer, preferably `panel/src/useGraphCommands.js`.
- Each command owns four responsibilities:
  1. mutate the graph through a model function;
  2. request the required redraw;
  3. call `loop.touch(label)` when the comp is affected;
  4. return a user-facing result or error.
- Move add, rename, delete, blend, effect, expression, visibility, label, order,
  connect, and disconnect actions behind these commands.
- Replace `loop.gesture()` in focus/drag callbacks with paired
  `beginGesture(label)` and `endGesture()` calls.
- Ensure drag-stop always closes a gesture, including click-without-movement,
  cancellation, unmount, and error paths.
- Do not touch the loop for canvas-position-only changes.
- Subscribe to loop events for `reading`, `patching`, `patched`, `held`, and
  `error`. Remove the unused `onSync` constructor option.

### Tests

- Add React tests with a fake host and fake timers.
- For every command, assert graph mutation, redraw behavior, patch scheduling,
  and undo label.
- Assert position-only dragging creates no AE patch.
- Assert expression focus/change/blur produces one patch and no unhandled
  rejection.
- Assert visibility and label controls repaint immediately.

### Acceptance gate

Run an interaction matrix in AE: toolbar, context menu, canvas wiring, keyboard
delete, expression edit, and outliner actions must each produce the expected
single undo entry.

---

## M4.3 — Typed connections and safe effect traversal

**Outcome:** users can actually create the node relationships shown by the UI.

### Progress

- [x] Handle IDs carry explicit `flow`, `expression`, `property`, or `parent`
  metadata, including direction and property name where applicable.
- [x] Flow, expression, and parent connections have separate atomic validators
  and panel commands.
- [x] Layer → effect → effect is a supported linear flow; branching, cycles,
  cross-type connections, missing nodes, and effects without a match name are
  rejected before the graph changes.
- [x] Expression nodes and layer property outputs can drive layer transform
  property inputs. Effect-parameter expressions remain explicitly unsupported
  until the host reader/writer can address them safely.
- [x] Flow, expression, and parent edges use different colours, shapes, paths,
  and accessible labels.
- [x] The diff constructs one validated effect-flow index per pass. Traversal
  uses visited state and reports malformed persisted graphs as warnings instead
  of silently selecting one branch or looping.
- [x] Automated coverage includes typed routing, atomic refusal, a two-effect
  chain, malformed graphs, and a 1,000-effect synthetic chain.
- [ ] Run and record the manual AE acceptance check, including undo/redo.

### Implementation

- Define explicit handle metadata for `flow`, `expression`, `property`, and
  `parent` connections rather than inferring all non-parent wires as expressions.
- Add `connectFlow`, `connectExpression`, and `connectParent` model/view commands.
- Render each edge type with a distinct colour, shape, and accessible label.
- Reject incompatible handles, missing effect match names, fan-out that the
  current backend cannot represent, and cycles before changing the graph.
- Replace `getFlattenedEffects()` with a validated traversal that has a visited
  set and reports branching/cycles as graph errors.
- Build the flow adjacency map once per diff rather than once per layer.
- Add stable ordering semantics when multiple outgoing connections eventually
  become supported.

### Tests

- Layer → effect → effect creates `kind: "flow"` edges and the correct AE stack.
- Expression → property creates an expression edge.
- Parent ports create only a parent relation.
- Cross-type connections, cycles, and unsupported branching are rejected without
  partially mutating the graph.
- Large synthetic graphs demonstrate near-linear adjacency construction.

### Acceptance gate

Build a two-effect chain and one expression relationship entirely through the
panel; inspect both the graph and resulting AE comp after undo/redo.

---

## M4.4 — Active drift UX (original M5 outcome)

**Outcome:** AE-side changes are detected and resolved visibly.

### Progress

- [x] Ready panels run a serialized 750 ms revision-gated poll, paused during
  writes and gestures.
- [x] Successful Node Timeline patches retain bounded before/after graph
  snapshots. AE undo/redo is reflected automatically only when the current comp
  exactly matches one of those known states, including undo of destructive
  graph deletion.
- [x] First observations after non-projectable create/reorder patches are
  exposed to the panel, so a fast undo is not missed before a baseline exists.
- [x] Arbitrary AE drift is grouped by layer in a blocking review with explicit
  “Keep Graph — update AE” and “Use AE Changes — update graph” actions.
- [x] Comp-wins capture is transactional and verified by a zero-op diff. It
  adopts constants, names, parenting, visibility, labels, blend modes, ordering,
  supported effects, managed creation/deletion, and removed expression edges;
  duplicate identities and unrepresentable states remain blocked.
- [x] Sync states distinguish Synced, Reading, Writing, AE changed, Blocked,
  Offline, and Error. Polling pauses while hidden and backs off after errors.
- [ ] Run and record the manual AE drift acceptance matrix.

### Implementation

- Start a bounded idle poll while the panel is ready and visible. Pause it while
  a patch is in flight, a gesture is open, the panel is hidden, or no comp exists.
- Prevent overlapping polls and back off after host errors.
- Add explicit sync states: `Synced`, `Reading`, `Writing`, `AE changed`,
  `Blocked`, `Offline`, and `Error`.
- Present drift grouped by layer and field.
- Wire actions to `acceptDrift()` and `discardPending()` with language that says
  which side wins.
- Implement capture-where-constant: AE edits to graph-owned constant values can
  be adopted into the graph; driven values continue to show their source.
- Detect active-comp changes and return to the startup decision flow instead of
  applying the previous graph to a different comp.

### Tests

- Polling is idle-cheap, serialized, and stops on unmount.
- Changes in another comp remain spurious.
- Constant changes can be adopted; identity-invalidating drift blocks writes.
- Both conflict actions lead to a defined, tested state.
- Switching active comps cannot write the old graph into the new comp.

### Acceptance gate

In AE, edit a constant, rename a managed layer, duplicate one, precompose one,
and switch comps. The panel must explain and safely resolve every case.

---

## M4.5 — Persistence and lossless reopen (M6)

**Outcome:** graph-only work survives closing the panel and reopening the project.

### Progress

- [x] Schema 1 sidecar format and complete graph round-trip.
- [x] Temporary-file replacement and previous-valid backup recovery.
- [x] Save Graph and command-triggered saving, including canvas-only edits.
- [x] Startup loading, identity checks, baseline comparison, and explicit review.
- [ ] Real AE close/reopen acceptance matrix.
- [ ] Save As / relocated-project identity migration.

Storage behavior and current limits are documented in [PERSISTENCE.md](PERSISTENCE.md).

### Storage decision

Before implementation, choose and record one primary store:

- schema-versioned `.ntl` sidecar file; or
- project-embedded metadata with an exportable sidecar backup.

The format must not rely on AE layer comments for anything beyond identity.

### Schema

Persist at least:

- schema version and graph ID;
- project/comp identity and last known revision;
- every node, native ID cache, kind, properties, effect metadata, and enabled,
  label, blend, and ordering state;
- every typed edge and parent relation;
- canvas positions and future viewport metadata;
- migration history or minimum reader version.

### Implementation

- Add pure `serializeGraph`, `parseGraph`, `migrateGraph`, and validation paths.
- Write atomically and keep the last valid backup.
- Load persistence before reading AE, then perform a three-way comparison between
  persisted graph, current comp, and recorded baseline.
- Never silently select an authority when persisted graph and comp disagree.
- Keep comp hydration as a recovery/import tool, not the normal reopen path.

### Tests

- Round-trip every supported node and edge type.
- Reject corrupt or future-version files without writing AE.
- Test migrations from every committed schema version.
- Simulate interrupted writes and recover the previous valid graph.
- Reopen produces an empty diff when neither side changed.

### Acceptance gate

Create a graph with layout, effects, expressions, parents, labels, visibility,
blend modes, and order; close AE; reopen; verify byte-equivalent graph data and
an empty reconciliation patch.

---

## M4.6 — Editing UX

**Outcome:** routine work no longer depends on browser prompts or hidden rules.

### Progress

- [x] Selection-linked inspector and keyboard-accessible outliner selection.
- [x] Numeric/vector constant controls with validation and driven-input locks.
- [x] In-panel name, blend and effect controls; searchable starter catalogue
  (Blur, Fill, Tint) with advanced match-name entry.
- [x] Confirmed node deletion through toolbar and keyboard.
- [x] Context-menu creation coordinates account for pan and zoom.
- [x] Collapsible/resizable outliner, theme tokens and visible focus styles.
- [ ] Full installed-effect catalogue, unmanaged-layer Import/Ignore workflow.
- [ ] Keyboard connection authoring and real AE usability acceptance matrix.

Validation: 151 automated tests pass, including inspector finite-number, range,
vector-dimension and linked-property refusal tests. Production panel/host build
passes. Keyboard focus, selection, deletion confirmation and pan/zoom placement
still require interactive AE acceptance; this milestone is not yet complete.

### Implementation

- Add a selection-synchronized inspector shared by canvas and outliner.
- Edit constant property values with numeric/vector controls and validation.
- Replace effect `matchName` prompts with a searchable effect catalogue; retain
  an advanced raw-match-name entry.
- Replace blend-mode prompts with a grouped select.
- Add an explicit, contextual empty state and onboarding action.
- Convert context-menu screen coordinates with React Flow's
  `screenToFlowPosition()`.
- Make the outliner collapsible/resizable and repair its CSS variables to use the
  existing `--ntl-*` theme tokens.
- Add selection sync, keyboard focus styles, tooltips, and non-colour-only edge
  identification.
- Confirm destructive deletion and show an undoable result message.
- Surface unmanaged-layer count with explicit `Import` and `Ignore` choices.

### Tests

- Keyboard-only selection, editing, connection, and deletion paths.
- Invalid numeric/effect inputs never mutate the graph.
- Context-menu placement remains correct after pan and zoom.
- Outliner/canvas selection and values remain synchronized.

### Acceptance gate

A first-time tester can create and edit a small shot without knowing AE scripting
match names or consulting the repository documentation.

---

## M4.7 — Readability and performance

### Progress

- [x] Split shell, lifecycle, monitoring, persistence, commands and sync panels.
- [x] Export model property/field/reorder/recovery mutations; remove UI assignments.
- [x] Share label palette; clean obsolete comments and redundant dynamic import.
- [x] Index driven edges, reconciliation flow membership and host native handles.
- [x] Linear reorder membership and iterative flow cycle validation.
- [x] Retain unchanged card data; collapse outliner; gate minimap at 200 nodes.
- [x] Coalesce typing/layout autosaves; omit production source maps by default.
- [x] Add architecture documentation and reproducible offline size benchmarks.
- [ ] Measure DOM/interaction/live AE timings; calibrate minimap threshold.
- [ ] Resolve R1/R2 from [the review](M4.7_REVIEW.md) before release.

156 tests pass; JSX preflight and production build pass. See
[architecture](ARCHITECTURE.md) and [performance results](PERFORMANCE.md).
The implementation pass is delivered; the full acceptance gate is not complete.

**Outcome:** the code has clear ownership boundaries and remains responsive on
realistic comps.

### Readability

- Split `App.jsx` into lifecycle, commands, sync status, and presentational
  components.
- Move all graph mutations into exported model functions; UI components should
  not assign directly to node fields.
- Establish one label-colour source (implemented; both use indices 0–16).
- Remove milestone-era comments that contradict current behavior and unused
  imports such as `addEdge`.
- Add a short architecture document covering data ownership, startup, mutation,
  drift, persistence, and failure states.

### Performance

- Index comp layers and graph edges once per read/diff.
- Replace nested scans in reorder/duplicate paths where AE APIs allow stable
  handles.
- Avoid rebuilding every React Flow node when only one node's display changes.
- Virtualize or collapse outliner/node detail for large graphs.
- Lazy-load the minimap or disable it above a measured graph-size threshold.
- Keep source maps out of the installed production bundle if they are not needed.
- Benchmark 50, 200, and 1,000 managed nodes; record read, diff, render, patch,
  and interaction latency separately.

### Budgets

- Pointer interaction: sustain 60 fps on the agreed reference machine.
- UI feedback after a command: under 50 ms.
- Diff of 1,000 nodes with no changes: under 16 ms in the panel runtime.
- Idle polling: no overlapping work and negligible CPU when revision is stable.

---

## Verification matrix for every phase

Run the relevant subset on each change and the complete matrix at phase gates:

```bash
npm test
npm run preflight
cd panel
npm run build
```

Add these project scripts as the test infrastructure lands:

```bash
npm run test:panel       # React integration tests
npm run test:all         # core + panel + preflight + build
npm run benchmark        # fixed synthetic graph sizes
```

Manual AE runs must record AE version, OS, project fixture, expected writes,
actual writes, undo count, and whether the harness control behaved correctly.

---

## Recommended delivery slices

| slice | phases | release meaning |
|---|---|---|
| Safety build | M4.1–M4.2 | Safe to open on test projects; all commands synchronize. |
| Functional graph build | M4.3 | Effect and relationship authoring works through the UI. |
| Reconciliation build | M4.4 | AE-side changes are detected and resolvable. |
| Durable alpha | M4.5 | Closing/reopening preserves the complete graph. |
| Usability beta | M4.6 | A user can build a shot without prompt-driven expert knowledge. |
| Scale candidate | M4.7 | Architecture and performance are measured at target sizes. |

Do not call a build production-safe before the durable alpha gate. Do not call
the MVP validated before M7's real-shot trial.
