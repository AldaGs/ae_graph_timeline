# The panel

M1: a node canvas over the P1 graph model, docked in After Effects.

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

**It does not write to After Effects yet.** That is M3. The status pill proves
the transport is live by reading `app.project.revision` through the same
`NTL_Revision` the drift guard uses, and the footer says plainly when a change
has not been written — a panel that looked connected while silently doing
nothing would be the worst of both.

## How it is put together

```
src/App.jsx           the shell: the graph object, the toolbar, the handshake
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

## Two things that bite

**`overflow: hidden` on a node card eats its ports.** A handle sits astride the
card's edge, and clipping takes the half the pointer lands on — so every attempt
to draw a wire drags the node instead. ExtendBlueNode documents the same trap.

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
