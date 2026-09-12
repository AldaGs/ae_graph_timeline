# CEP transport spike

The socket-agent spikes left the transport floor undecided: S1 measured 94 ms
with AE live, S2 measured 281 ms flat across every poll setting with AE idle,
and S2b was built to find out which regime applies.

**A dockable CEP panel makes most of that question moot.** `evalScript` is
dispatched by the CEP host straight into the ExtendScript engine — there is no
resident agent, no `Socket.poll()`, and no `app.scheduleTask` interval anywhere
in the path. Every number the sweep was trying to tune is a property of the
agent architecture, not of After Effects. And a docked panel means AE holds
focus while you work, which was the entire concern behind S2b.

So this measures the same things as `../spike/run-spike.js`, over the transport
the product will actually ship on.

## Install

```bash
node install.mjs
```

Junctions this folder into `%APPDATA%/Adobe/CEP/extensions`, so edits are live —
no rebuild, no reinstall. It checks `PlayerDebugMode` first, because an unsigned
panel is otherwise ignored silently, with no error anywhere.

Then restart After Effects → **Window ▸ Extensions ▸ Node Timeline Spike** →
**Run measurements**.

DevTools while the panel is open: <http://localhost:8090> (clear of
ExtendBlueNode's 8088).

## What it measures

Deliberately the same four blocks as the socket spike, so the numbers are
directly comparable:

| | | Compare against |
|---|---|---|
| **M0** | round trip with AE doing nothing (`NTL_noop`) | socket: 94 ms live / 281 ms backgrounded |
| **M2** | 1 / 10 / 50 / 200 property writes, one undo group | socket: 115 µs per write |
| **M3** | diff pass — resolve, read, write only on change | socket: 6.8 ms for 200 clean |
| **M4** | add then remove layers | socket: 14.5 ms per layer |

M3's clean row is still the one that matters most: it is what a reconciler pays
on every interaction frame, and it is a cost that changing transport cannot
remove — only reveal.

Results are written to `%TEMP%/ntl-cep-results.json` and there is a **Copy JSON**
button. The panel builds or reuses a comp called **NTL Spike** and touches
nothing else.

## Reading the outcome

- **M0 well under 94 ms** — the socket agent was the bottleneck all along, the
  poll sweep's flatness was an artifact of it, and the CEP panel is the answer.
- **M0 around 94 ms** — that floor is After Effects itself, not the agent. Going
  native would not fix it either; expect a debounced view.
- **M0 around 281 ms even docked** — the floor follows AE's idle loop regardless
  of transport, and only Architecture C (commit on demand) survives.

## Files

| | |
|---|---|
| `index.html` | the panel: measurement runner and results, static, no build step |
| `jsx/host.jsx` | everything AE is asked to do; each entry point returns a JSON string |
| `lib/CSInterface.js` | ExtendBlueNode's minimal shim over `window.__adobe_cep__` |
| `CSXS/manifest.xml` | CEP 11, AEFT 22+, `--enable-nodejs` |
| `.debug` | unsigned-dev port mapping (8090) |
| `install.mjs` | junction into the CEP extensions folder |

## Before editing host.jsx

After Effects is the only syntax check that file gets, and a lone backslash in a
regex literal is an unterminated-regex parse error that costs a full round trip
to discover. Use `split`/`join` instead, and run:

```bash
python "../../_aePlugins/python-proto/physics_sim/jsx_check.py" jsx/host.jsx
```

It is a real guard, not a green light — fed that exact bug it reports
`newline inside a string literal` plus unclosed delimiters.
