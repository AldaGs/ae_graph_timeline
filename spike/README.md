# Write-path spike

The node-graph-replaces-the-timeline idea rests on one architecture: **the graph
is the source of truth and continuously patches a real AE comp.** AE stays the
renderer, so every effect, plugin and the render queue come for free. The only
thing that can kill it is latency — how long a graph edit takes to become
visible in AE.

This spike measures exactly that, and nothing else. No node UI is involved.

## Running it

1. After Effects open.
2. **Window ▸ agent** — the resident socket agent from ExtendBlueNode. It starts
   listening on `127.0.0.1:7879` by itself.
3. `node run-spike.js`

It builds a scratch comp called **NTL Spike** (200 solids) and leaves it in the
viewer. Delete it when you're done; nothing else in the project is touched.

`NTL_LAYERS=500 node run-spike.js` to change the comp size.

## Before running anything in AE

`agent-poll.jsx` is ExtendScript, and After Effects is otherwise the only syntax
check it gets — a lone backslash in a regex literal already cost one round trip
here. Run the physics-sim checker first:

```bash
python "../../_aePlugins/python-proto/physics_sim/jsx_check.py" agent-poll.jsx
```

It is a real guard, not a green light: fed the exact bug above it reports
`newline inside a string literal` plus unclosed braces, and it passes the fix.

## What each number means

| | Measures | Why it decides something |
| --- | --- | --- |
| **M0** | Ping round trip, zero AE work | The floor. `agent.jsx` polls on `app.scheduleTask(…, 60 ms)` and only ticks when AE is idle, so no patch can ever beat this. If M0 alone blows the budget, the transport is the problem, not the writes. |
| **M1** | Empty script round trip | Separates `eval` + report-file cost from real AE work. M2 minus M1 is the honest write cost. |
| **M2** | *n* opacity writes, batched | Per-write cost, and what an undo group costs. Run with and without `beginUndoGroup` because undo is a known tax and a reconciler may want one group per patch, not per write. |
| **M3** | A real diff pass: resolve, read, write only on change | This is the shape of an actual reconciler. The `clean graph` row is the one that matters most — an idle diff over unchanged properties is what runs on *every* frame of interaction, and if that isn't nearly free the whole design needs a dirty-tracking layer instead of a diff. |
| **M4** | Add + remove layers | Structural patches (a node added or deleted) are far more expensive than value patches. Budget them separately. |

## Reading the verdict

- **< 100 ms for a 50-property patch** — live sync works on ExtendScript. Build
  the reconciler and move on.
- **100–400 ms** — good enough for a debounced view, not for dragging a value
  and watching it track. Upgrade path is a native AEGP transport with an idle
  hook, where writes are ~28× faster (measured previously in the physics sim:
  131 µs/key native vs ExtendScript).
- **> 400 ms** — the graph cannot be a live view over this transport. Either go
  native, or drop to an explicit commit model.

The upgrade path matters: a bad result here does **not** kill the idea, it just
moves the transport into C++. What would kill it is M3's clean-diff row being
expensive *in AE* — that's a cost native code doesn't remove, only restructures.
