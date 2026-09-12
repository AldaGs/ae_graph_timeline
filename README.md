# Node Timeline

A node graph that replaces After Effects' layered timeline as the place you
compose. The graph is the source of truth; AE holds a derived comp and stays the
renderer, so every effect, plug-in and the render queue keep working.

**Working name. P0 complete, P1 in progress.** The first phase was falsification:
cheap spikes against the things most likely to kill it. All seven gates passed,
so the reconciler is now being built - offline first, then against real After
Effects.

## Read in this order

| | |
|---|---|
| [`docs/PLAN.md`](docs/PLAN.md) | the reasoning — the premise, the four walls, what is decided and why |
| [`docs/SPIKES.md`](docs/SPIKES.md) | the evidence — every measurement, and what each does *not* cover |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | the sequence — gates, POC, MVP |

## Where it stands

**P0 is complete — all seven gates green.** The measurements that mattered:
`evalScript` round trips in 1.2 ms, `app.project.revision` is a 2.3 µs drift
gate, AE's undo stack holds exactly 99 entries, and a layer costs 14.5 ms to
create against 0.13 ms to write a property — which is why this patches a comp
and never rebuilds one.

**S6 changed the scope.** A census of nine real client comps found **649
expressions against 484 animated properties**. An expression says one value is a
function of another; that is an edge. The work is *already* a dependency graph,
stored as several hundred invisible text fields. So:

> **The graph owns structure and relationships. After Effects keeps keyframes.**

**P1 is built and tested offline** — `src/` for the pure parts, `jsx/` for the
two halves that talk to AE:

| | |
|---|---|
| `src/graph.js` | the model: nodes, expression edges, and the tags that make ownership detectable |
| `src/diff.js` | graph + comp state → an ordered patch. Pure; no I/O |
| `src/reader.js` · `jsx/reader.jsx` | the read half. Read-only, revision-stamped, refuses a partial read |
| `src/patch.js` · `jsx/patch.jsx` | the write half. One undo group, stops on failure, returns an inverse for rollback |

```bash
npm test        # 44 offline tests — no After Effects required
npm run preflight   # ES3 pre-flight on the .jsx files
```

`test/fake-ae.js` runs the **real** `patch.jsx` inside a VM against a mock object
model, so the tests execute the same text After Effects will.

**The in-AE pass passed — 31/31 on AE 26.5x89.** `jsx/p1-check.jsx` asks the one
question the offline tests cannot: *does After Effects behave like the fake?* It
does. Identity, the revision gate, expression round-tripping, **one undo entry
per patch**, rollback by inverse and every refusal all hold, and a property write
costs 47.6 µs against the 130 µs budgeted.

## Spike instruments

**The current one is [`cep-spike/`](cep-spike/)** — the transport the product
will ship on:

```bash
node cep-spike/install.mjs   # then restart AE
```

Window ▸ Extensions ▸ **Node Timeline Spike** ▸ Run measurements.

The socket-agent instruments in [`spike/`](spike/) are kept for the record and
for comparison; they need After Effects open plus a resident agent panel.

```bash
node spike/run-spike.js     # S1: write-path latency      (needs the EBN agent, port 7879)
node spike/poll-sweep.js    # S2: how much of the floor is the transport
```

S2 needs its own agent first: **File ▸ Scripts ▸ Run Script File…** →
[`spike/agent-poll.jsx`](spike/agent-poll.jsx). It listens on 7880 so it can sit
beside the ExtendBlueNode agent on 7879.

Both build a scratch comp called **NTL Spike** and touch nothing else.
See [`spike/README.md`](spike/README.md) for what each measurement decides.
