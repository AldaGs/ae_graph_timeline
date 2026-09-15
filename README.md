# Node Timeline

A node graph that replaces After Effects' layered timeline as the place you
compose. The graph is the source of truth; AE holds a derived comp and stays the
renderer, so every effect, plug-in and the render queue keep working.

**Working name. P0 and P1 complete.** The first phase was falsification:
cheap spikes against the things most likely to kill it. All seven gates passed,
so the reconciler was built - offline first, then verified against real After
Effects.

## Read in this order

| | |
|---|---|
| [`docs/PLAN.md`](docs/PLAN.md) | the reasoning — the premise, the four walls, what is decided and why |
| [`docs/SPIKES.md`](docs/SPIKES.md) | the evidence — every measurement, and what each does *not* cover |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | the sequence — gates, POC, MVP |
| [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) | the current hardening plan — safety, integration, persistence, UX, and performance |

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
| `src/scrub.js` | After Effects' numeric fields as arithmetic: how far a pixel moves a value, what Shift and Ctrl do, and how a number is printed without lying |
| `src/outline.js` | the outliner's rows: every layer a child of the comp, in the AE stacking order, with its effects under it |
| `src/select.js` · `jsx/select.jsx` | the selection bridge: a node selects its layer, so AE's own Effect Controls and Properties panels follow. View state only — no undo entry, no revision movement |
| `src/drift.js` | the drift guard: a 2.3 µs gate, then a digest, then a compare that says *where* |
| `src/loop.js` | the write loop: mutate the graph, and AE follows — one undo entry per gesture |

```bash
npm test        # 215 offline tests — no After Effects required
npm run preflight   # ES3 pre-flight on the .jsx files
```

`test/fake-ae.js` runs the **real** `patch.jsx` inside a VM against a mock object
model, so the tests execute the same text After Effects will.

**The in-AE pass passed — 34/34 on AE 26.5x89, so P1.1 and P1.3 are closed.**
`jsx/p1-check.jsx` asks the one question the offline tests cannot: *does After
Effects behave like the fake?* It does. Identity, the revision gate, expression
round-tripping, **one undo entry per patch**, rollback by inverse, a patch
applied straight after the user's Ctrl+Z, and every refusal all hold — and a
property write costs ~47 µs against the 130 µs budgeted.

```bash
# the in-AE pass: File > Scripts > Run Script File... > jsx/p1-check.jsx
```

It builds its own comp, deletes it afterwards, and carries two controls: a
positive one proving Undo really undoes, and a check **designed to fail** — if
that one ever passes the run is marked VOID rather than PASS. Five times in this
project the instrument, not After Effects, turned out to be the finding.

**P1.4 and P1.5 are built and green offline.** The drift guard asks three
questions in order of what they cost: `app.project.revision` (2.3 µs, the only
thing that runs while idle), then a digest of a structural read, then a compare
that names what moved. A moved revision is **not yet drift** — it is project-wide,
so a selection or an edit in another comp moves it — and the digest is what turns
that into "spurious" instead of a false alarm. Five changes block a write, because
each means an identity the graph was holding is no longer what it thought;
everything else is reported and corrected by the next diff.

The write loop spends the undo stack the way S5's 99-entry measurement demands:
**a gesture is a hold, not a debounce.** Nothing is written while one is open, and
forty mutations inside it cost one undo entry. One patch is ever in flight; a
stale patch is re-read and re-diffed rather than re-sent; a failed one is rolled
back by its inverse; blocking drift holds the loop until the user accepts or
discards. A pass with nothing to write opens no undo group at all.

**Their in-AE pass passed too — 25/25 on AE 26.5x89, so P1 is done.**
`app.project.revision` moves on every edit the guard must notice, **and on an
edit in another comp** — the measurement the digest tier exists for. Two reads of
an untouched comp are byte-identical, so the digest has something stable to sit
on. A **twelve-op patch is one undo entry**: one Ctrl+Z put back every value and
every name. The gate measured **0.678 µs**, 3.4× cheaper than S4 — an idle
reconciler polling at 10 Hz spends under 7 µs a second noticing nothing happened.

Two things turned out better than assumed: selecting a layer does not move the
revision, and neither does moving the time indicator — the two likeliest sources
of false wake-ups.

```bash
# the P1.4/P1.5 in-AE pass: File > Scripts > Run Script File... > jsx/p1b-check.jsx
```

## The panel

**M1–M3 are implemented** — [`panel/`](panel/) is a React Flow canvas over the P1
graph model, with the reconciler connected to After Effects. A layer is a node;
effect and expression nodes add compositing and relationships; blue wires carry
flow/expression relationships and amber dashed wires carry parenting.

**M2 is complete** — expanding the vocabulary of the graph to be able to build a
simple shot. The model, diff, patch, and canvas now understand AE's effect stack,
blend modes, and label colours. See [`docs/M2.md`](docs/M2.md) for the tracking document.

**M4 code exists but is not yet safe to call complete.** Native
layer IDs are captured after creation, duplicate tags are disambiguated, unique
precompose replacements can re-bind, and the panel hydrates tagged layers on
startup. Hydration is lossy until M6 and the current initial flush can clear
graph-owned expressions or parenting that hydration did not reconstruct. See
[`docs/M4.md`](docs/M4.md) and use only disposable or version-controlled project
files until reload is made non-destructive and manually verified.

The current UI also includes an outliner for visibility, label colour, and
managed-layer order. The core reconciler is well covered, but the React/CEP
integration is not yet covered by automated component tests; treat the panel as
an in-development prototype rather than a production-safe editor.

```bash
cd panel && npm install
npm run ae      # build, then install into the CEP extensions folder
```

Then restart AE → Window ▸ Extensions ▸ **Node Timeline**. `npm run dev` runs the
same canvas in a browser, without After Effects, which is faster for canvas work.

The graph is the source of truth: [`src/view.js`](src/view.js) is the only file
that knows both the model and React Flow, and it is pure, so it is tested with
everything else.

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
