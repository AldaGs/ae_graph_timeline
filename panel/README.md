# The panel

A node canvas over the reconciler's graph model, docked in After Effects.

```bash
npm install
npm run ae        # build, then install into the CEP extensions folder
```

Then restart After Effects → **Window ▸ Extensions ▸ Node Timeline**.

For canvas work, `npm run dev` is faster and does not need After Effects at all —
the panel says **browser** in the corner and the canvas behaves identically.
DevTools while the panel is open in AE: <http://localhost:8091>.

## What it does, and what it does not

It renders the graph, and canvas gestures mutate the graph:

| | |
|---|---|
| a node | a layer — its name, its kind, and one row per property the graph owns |
| a blue wire | an expression edge (S6): the source drives that input |
| an amber dashed wire | parenting — a real AE parent pointer, not an expression |
| `linked` on a row | that input is driven, so it is not a value to type into |

The M3 write loop is connected in After Effects: graph changes are diffed against
the active comp and applied through one undo group per completed gesture. The
status pill reads `app.project.revision` through the same `NTL_Revision` entry
point used by the drift guard.

On startup, the panel reconstructs basic layer nodes from tagged AE layers. This
is not yet a safe persistence substitute: it does not recover canvas positions,
expression nodes, effect-node topology, or every graph-only relationship. The
initial `touch()` can therefore reconcile an incomplete graph back into AE—for
example, clearing graph-owned expressions or parent links that hydration did
not restore. M6 is responsible for a schema-versioned graph file. Until reload
is made non-destructive, the React/CEP path has integration coverage, and the M4
manual scenarios pass, use only disposable or version-controlled AE projects.

The current panel also has an outliner for managed-layer visibility, label
colour, and relative order. Constant property values are displayed but are not
editable in the node cards yet.

If no composition is active, the panel stays read-only, offers **Create New
Comp…** using AE's native composition-settings dialog, and checks once per
second for a comp opened manually in AE. Either path automatically returns to
the safe inspection flow; it does not require closing and reopening the
extension.

While a graph is active, the panel also checks the active comp's native ID. If
the comp is deleted/closed, or another comp—including a duplicate—is activated,
the write loop is closed and editing is locked. A duplicate is never adopted
just because it carries copied `ntl:` layer tags; **Inspect Active Comp** performs
a read-only comparison before that comp can become writable.

## How it is put together

```
src/App.jsx           presentational shell and toolbar
src/hooks/            lifecycle, host monitoring and graph persistence
src/graphCommands.js  mutation commands, redraw and write-loop notifications
src/components/       inspector, outliner and sync/conflict panels
src/canvas/           React Flow, and the card that draws a layer
src/bridge/cep.js     evalScript, in the exact shape src/loop.js expects
../src/view.js        graph <-> canvas. Pure, and tested offline
../src/*.js           the reconciler, shared with the test suite - never copied
```

The graph is the source of truth and lives in `../src/graph.js`. React Flow
renders it and owns nothing: every gesture goes through `view.js` into the graph,
and the canvas is redrawn from there. Two copies of "what a node is" is the bug
this arrangement exists to prevent.

**Node positions live in the model**, in `node.ui`. The diff never reads them, so
moving a node can never emit a patch — but M6 has to persist them, and a graph
that reopened with every node stacked at the origin would have lost the thing the
user spent longest arranging.

**A drag is one gesture.** While the pointer is down, React Flow keeps the
position; the model learns the final one at drag stop. That is the same rule
P1.5 applies to After Effects — a drag is worth one write, at the end of it.

## Three things that bite

**`overflow: hidden` on a node card eats its ports.** A handle sits astride the
card's edge, and clipping takes the half the pointer lands on — so every attempt
to draw a wire drags the node instead. ExtendBlueNode documents the same trap.

**Re-deriving the canvas on every pointer move flickers the whole panel.** The
first version pushed each position change through the model and re-rendered from
it, so sixty times a second every node and edge object was rebuilt with a new
identity and every card re-rendered. Inside CEP that reads as the panel blinking.
Panning and zooming never did it, because React Flow owns the viewport and React
is not involved — and that asymmetry is what named the bug.

**An edge pointing at a handle that does not exist is dropped in silence.** No
warning, no error: the wire lands in the model and simply never appears. The
first run of this panel did exactly that, because an edge's source is stored the
way After Effects addresses it (`.transform.position`, which is what goes into
the expression body) and a port is named after the property alone. `view.js`
translates between them, and `test/view.test.js` asserts that every wire lands on
a port that is actually there.

## The build

```bash
npm run build     # vite build, THEN scripts/build-host.mjs
```

`dist/host.jsx` is `jsx/common.jsx + reader.jsx + patch.jsx` concatenated, because
CEP's `ScriptPath` takes one file and `#include` cannot resolve out of the
installed extension folder. It is generated, never edited, and it is the same
text the offline suite runs and the in-AE checks ran.

The order matters: Vite empties `dist/` on the way in, so a `host.jsx` written
first is deleted a second later. The symptom is a panel that loads, draws, and
cannot talk to After Effects, with nothing in any log.
