# Node Timeline — spikes

**The evidence.** Every measurement, what it settled, and what it does *not*
cover. A spike exists to falsify something cheaply; one that cannot fail is not
a spike, it is a demo.

Host for all results: After Effects **26.3x87**, Windows 11, comp `NTL Spike`
(1920×1080, 200 solids). Instruments in `../spike/`.

| | Spike | Status |
|---|---|---|
| S1 | Write-path latency | **PASS** — 2026-09-10 |
| S2 | Poll sweep: how much of the floor is the transport | **INCONCLUSIVE** — confounded, 2026-09-10 |
| S2b | Focus: does the floor depend on AE being frontmost? | built; **largely superseded by S2c** |
| S2c | CEP panel transport (`evalScript`, no agent) | **PASS** — 2026-09-10 |
| S3 | Durable node ↔ layer identity | **PASS** — 2026-09-10, with a hybrid scheme |
| S4 | Drift detection: has the user edited the comp? | **PASS** — 2026-09-11, with a free gate |
| S5 | Undo coexistence | **PASS** — 2026-09-11; the ceiling is 99 entries |
| S6 | Time model: structure-only vs baked curves | **PASS** — 2026-09-11, on 9 real comps |
| S7 | Why did IllusionFX leave AE? | **ANSWERED** — ambition, not a wall |

---

## S1 — Write-path latency

**Premise to falsify:** *a patch is too slow to be a live view, and/or a clean
diff is expensive enough that the design needs dirty-tracking instead.*

Instrument: `../spike/run-spike.js`, over ExtendBlueNode's resident socket agent
(`jsx/agent.jsx`, port 7879, 8-hex length prefix, one connection per request).
Payloads time themselves in-AE with `$.hiresTimer` and drop a JSON breakdown in
a temp file; round trip is measured client-side.

### Results

| Measurement | Result | In AE | Transport |
|---|---|---|---|
| Transport floor (ping) | **94 ms** median, 50 ms best | 0 | all of it |
| 1 property write | 125 ms RTT | 1.6 ms | ~93 ms |
| 50 property writes | 125 ms RTT | 6.4 ms | ~93 ms |
| 200 property writes | 112 ms RTT | 22.9 ms | ~89 ms |
| **Clean diff, 200 props** | 100 ms RTT | **6.8 ms** | ~93 ms |
| Diff + 200 writes | 107 ms RTT | 42.8 ms | ~64 ms |
| Layer create | — | **14.5 ms each** | — |
| Layer remove | — | 2.7–13.2 ms each | — |

Per-unit costs, in AE, excluding transport:

- **property write — 115 µs** (inside one undo group, at n=200)
- **property read — 34 µs**
- **layer create — 14,500 µs**

### What it settled

1. **The clean diff is cheap.** 200 properties resolved and read, none written,
   in 6.8 ms. A reconciler can diff on every interaction frame without a
   dirty-tracking layer. This was the outcome that could have forced a redesign.
2. **AE is not the bottleneck — the transport is.** For a 200-property patch, AE
   is 13 ms of a 107 ms round trip. 87% of the latency is the ExtendScript
   socket, which is the most replaceable component in the stack.
3. **One undo group per patch is faster, not just more correct.** At n=200:
   114.7 µs/write grouped vs 176.9 µs ungrouped. Same direction at n=50
   (127.1 vs 156.0). Batching wins ~35%. Ungrouped writes appear to each incur
   their own implicit undo entry.
4. **Structure costs 125× value.** 14.5 ms to create a layer against 0.115 ms to
   write a property. Never rebuild; patch a stable layer pool. → Wall 1 in
   `PLAN.md`.

### The M0 artifact — read this before trusting the raw file

The first run reported a **282 ms** median ping. A ping does no AE work at all,
so it cannot be slower than a 200-property write at 112 ms. **A measurement
wrong in an impossible direction is an instrument fault, not a finding.**

Re-run, interleaving ping and run in the same loop:

```
ping  min 50.3  median 93.7  max 141.5 ms
run   min 91.5  median 94.5  max 142.4 ms
```

Identical. The 282 ms was AE's event loop idling: `app.scheduleTask` fires lazily
when After Effects has nothing to do, and tightens once a comp exists and is open
in the viewer. The M0 block in `../spike/results.json` is invalid; the floor is
94 ms.

**Second-order finding, not yet priced:** transport latency depends on how busy
AE is. An idle AE answers *slower*. Any latency budget must be quoted for a live,
in-use AE — which, conveniently, is the only state that matters.

### What S1 does NOT cover

- **Only opacity was written.** A float on a Transform Group. Nothing about
  shape paths, text documents, effect parameters, masks, or expressions, which
  may be much more expensive per write.
- **Nothing was rendered.** The comp was open in the viewer, but the spike never
  measured how long AE takes to *redraw* after a patch, nor whether a patch
  invalidates the render cache proportionally. A patch that lands in 100 ms and
  then triggers a 2 s re-render is not a 100 ms patch.
- **No user interaction ran concurrently.** Every number was taken with AE
  otherwise idle. The agent polls on `scheduleTask`, which only fires when AE is
  between things — behaviour while the user is dragging is unmeasured and could
  be much worse.
- **One comp, one project, 200 solids.** Solids are the cheapest possible layer.
  Precomps, footage and shape layers are unpriced.
- **The temp-file report write is inside every measured round trip.** It inflates
  the RTT figures by an unknown amount. S2 drops it.
- **Undo stack growth was not measured** over a long session of patches.

## S2 — Poll sweep

**Premise to falsify:** *the 94 ms floor is irreducible without writing C++.*

Instrument: `../spike/agent-poll.jsx` (port 7880, coexists with the EBN agent) +
`../spike/poll-sweep.js`. Two knobs, varied at runtime over the socket:

- `pollMs` — the `app.scheduleTask` interval. `jsx/agent.jsx` hardcodes **60**.
- `ui` — whether the panel redraws its status inside every request. The stock
  agent calls `refresh()` in `handle()`'s `finally` block, putting a ScriptUI
  redraw inside the measured round trip.

Also samples AE's idle CPU per configuration, because a tight poll is not free
and the tax needs to be visible next to the gain.

**If the floor drops to ~25 ms**, a 200-property patch lands in ~35 ms and live
dragging works with no port at all. **If it does not move**, the floor is
something else — ExtendScript's blocking `Socket`, most likely — and the native
AEGP transport moves up the roadmap.

### Result: flat, and therefore not yet a result

Ten configurations — poll ∈ {60, 30, 16, 8, 4} ms × ui ∈ {on, off} — and every
single one landed at **~281 ms** median for both ping and a 50-property patch.
Total spread across all ten: under 2 ms.

**`idleCpuPct` read 0.0 in all ten because the probe was broken**, not because AE
was idle. It summed `TotalProcessorTime` with `Measure-Object -Sum`, which cannot
sum a `TimeSpan`: PowerShell errors and the result is 0. Confirmed later, by
accident, while diagnosing a wedged AE. **Ignore every `idleCpuPct` in
`results-poll.json`** — the instrument is fixed, the recorded numbers are not.

A knob varied 15× that moves nothing is not a weak effect. Either the knob is
disconnected, or something else entirely sets the floor.

**281 ms is also the exact figure from S1's M0 artifact** — the ping median taken
before the comp existed, which then fell to 94 ms once AE was live. The same
number has now appeared twice, in the two runs where After Effects was sitting
idle, and never in the run where it was busy.

### Two hypotheses, not yet separated

| | Hypothesis | If true |
|---|---|---|
| **H1** | the `cfg` op never took effect, so all ten cells ran at one interval | the sweep measured nothing; rebuild the instrument and re-run |
| **H2** | the interval is irrelevant — AE services its idle loop at ~280 ms while **backgrounded**, and at ~94 ms when live | live sync is capped at ~281 ms in ExtendScript regardless of tuning |

H1 is the more mundane explanation and is favoured by how *extreme* the flatness
is: a real 60 ms poll should show a wider min-to-max spread than a real 4 ms
poll, and the observed spreads are identical (31 ms vs 32 ms). But S1's warm
regime showed a 91 ms spread (50–142 ms), which is a different regime altogether,
so H2 is not dismissible either.

**Do not quote a transport floor until this is settled.** S1's 94 ms and S2's
281 ms are both real measurements of *something*; which one applies to the
product depends on which hypothesis survives.

### Why H2 would matter far more than a tuning result

The node editor is planned as a **separate Electron window** (inherited from
ExtendBlueNode's standalone bridge). If AE only services its socket at ~280 ms
while backgrounded, then **AE is backgrounded exactly when the user is working**,
and no amount of poll tuning reaches it. That would put three options on the
table, and it is an architecture decision, not an optimisation:

1. Put the editor back **inside AE** as a panel, so AE holds focus while you
   work — reversing ExtendBlueNode's move to standalone.
2. **Native AEGP** transport with its own socket thread, marshalling to the main
   thread only for the DOM writes — not subject to AE's idle loop at all.
3. Accept ~281 ms and ship the **commit-on-demand** model (Architecture C).

## S2b — Focus

**Premise to falsify:** *the transport floor is independent of whether After
Effects is the foreground window.*

Instrument: `../spike/focus-test.js`. Runs three things in order:

- **H1 check** — sets `cfg(4, false)`, reads it back through the `stats` op, and
  reports whether the agent actually changed. If it did not, S2 measured nothing
  and H2 is untested.
- **CPU probe control** — every S2 row read 0.0%, and a probe that only ever
  reads zero is broken until proven otherwise. Makes AE spin for 2 s and checks
  the number moves. If it does not, every `idleCpuPct` in `results-poll.json` is
  meaningless.
- **H2 test** — 30 pings with AE backgrounded, 30 with AE pulled to the
  foreground via `WScript.Shell.AppActivate`, at poll 60 and poll 4. Confirms
  through `user32!GetForegroundWindow` that AE genuinely came forward, and voids
  the row if it did not.

_Awaiting a run — needs AE open with `agent-poll.jsx` loaded._

## S2c — CEP panel transport

**Premise to falsify:** *the transport floor is a property of After Effects, so
changing how we reach it will not help.*

The product is now a **dockable CEP panel** (see `PLAN.md`), which changes the
transport rather than tuning it. `CSInterface.evalScript` is dispatched by the
CEP host directly into the ExtendScript engine: no resident agent, no
`Socket.poll()`, no `app.scheduleTask` interval. Every knob S2 tried to turn
belongs to the socket-agent architecture and simply is not in this path. Docking
also means AE holds focus while the user works, which was S2b's whole concern.

Instrument: `../cep-spike/`. Static HTML, no build step — a spike with a build
step measures the build step too. Runs the same four blocks as S1 so the numbers
are directly comparable, writes `%TEMP%/ntl-cep-results.json`.

Verified before it ever reached AE: the panel renders, throws no console errors,
correctly detects it is outside CEP, and its failure path degrades to a visible
error rather than a hang.

### What each outcome would mean

| M0 (round trip, AE doing nothing) | Reading |
|---|---|
| well under 94 ms | the socket agent was the bottleneck; S2's flatness was its artifact; CEP is the answer |
| around 94 ms | the floor is After Effects itself. Native would not fix it either — expect a debounced view |
| around 281 ms even docked | the floor follows AE's idle loop regardless of transport; only Architecture C survives |

### Results

**The floor collapsed from 94 ms to 1.2 ms.** The socket agent was the entire
bottleneck, and S2's flatness was its artifact.

| Measurement | Socket agent | **CEP panel** |
|---|---|---|
| Floor, AE doing nothing | 94 ms live / 281 ms bg | **1.2 ms** median (0.2 min, 10.7 p90) |
| 1 property | 125 ms | **1.8 ms** |
| 10 properties | 116 ms | **3.1 ms** |
| 50 properties | 125 ms | **17.3 ms** |
| 200 properties | 112 ms | **55 ms** |

**A 50-property patch at 17.3 ms is about one frame at 60 fps.** Drag a value and
watch After Effects track it — not merely a debounced view.

### Why the result is trustworthy: the AE-side costs reproduced

The numbers that are properties of *After Effects* came back nearly identical
across two entirely different transports, while only the transport-dependent
numbers moved. That is the right signature, and it is what says neither run was
measuring its own instrument:

| Cost | Socket | CEP | |
|---|---|---|---|
| property write | 115 µs | 126 µs | agrees |
| layer create | 14.5 ms | 14.3 ms | agrees |
| **clean diff, per property** | **34 µs** | **105 µs** | **disagrees 3×** |

### The clean diff, resolved

Re-run with M3 repeated 8×: **6.33 ms median, 31.7 µs per property**, against the
socket spike's 6.8 ms / 34 µs. The two transports agree after all. Samples ran
5.79–7.08 ms — tight enough to trust.

The 21.0 ms was a single high sample, exactly as suspected. The instrument was
the fault, not After Effects.

**The clean diff is cheap and confirmed.** A reconciler can resolve and read 200
properties for ~6 ms on every interaction frame. Diffing beats dirty-tracking,
and now it is measured twice by two different means.

### What repetition exposed: the diff's write path costs 2.26×

| | in AE | per property |
|---|---|---|
| plain 200-property patch (one undo group) | 26.1 ms | **130 µs** |
| diff pass writing all 200 | 58.8 ms | **294 µs** |

Same 200 writes, 2.26× the cost. Three causes, all avoidable:

- **`NTL_diff` wraps nothing in an undo group.** S1 already measured ungrouped
  writes at ~35% more expensive, and this reproduces it.
- It re-resolves each property (`layer.property(...).property(...)`) inside the
  loop instead of resolving once.
- It reads and writes interleaved rather than in two passes.

> **Rule for the reconciler:** diff and apply are two phases, not one loop. Read
> everything, decide, then write the whole patch inside a single
> `beginUndoGroup`, from properties resolved once and cached.

That is not a micro-optimisation — it is 2.26× on the hot path, and it falls out
for free from a design that was already the correct shape.

### The bulk-creation number, explained

S2c's first run built 200 solids in 863 ms; the re-run, 870 ms. It reproduces, so
it is not noise — and it is **3.4× cheaper per layer than M4's incremental adds**:

| | per layer |
|---|---|
| bulk, building a comp from 0 → 200 layers | **4.35 ms** |
| incremental, adding onto an existing ~200 | **14.6 – 17.8 ms** |

The difference is not bulk versus incremental. It is **how many layers the comp
already holds**: M4 always adds onto a comp that already has 200, while `ensure`
averages over a comp growing from empty. **Layer creation cost grows with comp
size.**

Rough shape: ~4.35 ms averaged across 0→200 implies near-zero at the start and
~9 ms at 200, and measurement at ~200–250 gives ~15 ms. Call it roughly linear at
~0.06 ms per existing layer. A 500-layer comp would cost ~30 ms per added layer.

**This sharpens Wall 1 rather than softening it.** Structure is not merely
expensive, it gets more expensive as the comp grows — so a reconciler that
churns layers degrades superlinearly in exactly the projects that matter most.
Not measured beyond 250 layers; if comp size becomes a design question, measure
the curve properly first.

### What S2c will NOT settle

- **S2b's question survives in reduced form.** A docked panel usually has focus,
  but AE can still be backgrounded (the user alt-tabs to a browser). If the floor
  turns out to be focus-dependent, that still bites — just less often.
- It says nothing about the walls. Identity (S3), drift (S4) and undo (S5) are
  untouched by the transport choice, and they are now the top risks.

## S7 — Why IllusionFX left After Effects

**Premise to falsify:** *a working AE node system left AE because of a wall that
would also block us.*

**Answered by the project owner: ambition, not a wall.** The new model is a whole
compositing application rather than a set of After Effects workarounds — a
decision to outgrow the host, not a retreat from it.

**Falsified, and the gate is green.** Nothing in their departure is evidence
against building inside AE. Magic Nodes stands as proof the concept works there.

What it does *not* license: treating the AE ceiling as imaginary. Someone with a
working product still judged the host's constraints worth leaving behind, and the
walls in `PLAN.md` are our version of the same constraints. The mitigation is
already in the plan — Wall 4 option (a), the graph owns structure and After
Effects keeps time — which is precisely the scope that avoids the workarounds
IllusionFX outgrew. Revisit if we ever reach for option (b).

## S3 — Durable node ↔ layer identity

**Premise to falsify:** *a graph node cannot keep a stable handle on an
After Effects layer across the things a user actually does to it.*

Instrument: the **Identity** tab of `../cep-spike/`.

### It probes before it builds

The first thing it asks is whether we need a carrier at all: does this AE expose
a native `layer.id`, is it unique per layer, and can anything *resolve* one?
**If AE assigns durable ids itself and can look them up, most of this spike is
moot** — the panel says so in place of burying it under the matrix.

**The lookup lives on the project, not the comp.** `comp.layerByID()` does not
exist; `app.project.layerByID(id)` and `app.project.itemByID(id)` do. That is not
a naming detail — a project-wide lookup needs no comp to search in, so the
reconciler resolves a layer directly and infers its comp from
`layer.containingComp`. **It never scans.** The first version of this spike
re-found layers by scanning, which is the correct fallback for a stamped carrier
and badly understates a native id; the matrix now runs the real path for each.

The probe round-trips rather than trusting that a function merely exists: id →
layer → `containingComp` → `itemByID` and back. It also asks the question that
matters more than any of them — **what a deleted layer's id resolves to.** A
lookup that returns `null` is correct; one that throws is acceptable; one that
returns a live layer would be worse than having no lookup at all, because the
reconciler would confidently patch the wrong layer.

That distinction matters because the two schemes are not the same shape:

| | who owns the id | duplicate behaviour | resolve path | what must persist |
|---|---|---|---|---|
| **we stamp the layer** (comment / marker / effect) | us | both copies carry it — a collision | scan every layer | nothing extra; the id rides the layer |
| **AE assigns it** (native `layer.id`) | AE | copy gets a new id, unknown to the graph | `app.project.layerByID()`, direct | a node → id map, in our project file |

Native looks the stronger option now that the lookup is known to exist: AE owns
uniqueness, resolution is direct rather than a scan, and a duplicated layer is
simply unknown to the graph rather than a collision to arbitrate. Its cost is
that we carry a node → id map which must itself survive a save/reload — the
stamped carriers have no such map because the id rides the layer.

The measurement that decides it is **per lookup**, not per read. Reading an id
off a layer you already hold is not the same operation as finding one you do
not, and only the second is the reconciler's real resolve path.

### The matrix

Four carriers — `native` (if present), `comment`, `marker`, `effect` (a renamed
Slider Control) — against six operations: `baseline`, `reorder`, `rename`,
`duplicate`, `undo`, `precompose`.

Each test tags layer 1 of a throwaway comp, performs one operation, then
**re-finds the layer by scanning for the id** — never by index, since index is
exactly what a durable id is supposed to replace. It reports how many layers
matched, so a collision is visible rather than silently resolved to the first
hit.

**A duplicate collision is reported as `collides ×2`, not as a failure.** For a
stamped carrier that is the expected outcome and arguably the useful one: the
reconciler can see two layers claiming one id and reassign. The failure mode
worth fearing is being unable to tell.

### Honesty features

- **Undo is reported, not assumed.** After Effects has no `app.undo()`, and the
  menu item reads "Undo &lt;action&gt;" so a name lookup usually misses. The
  instrument tries `findMenuCommandId('Undo')` then command id 16, and if
  neither fires the column reads **untested, not passed**, naming which method
  worked.
- The undo test performs an *unrelated* later edit and undoes that — the real
  risk is the user pressing Ctrl+Z during normal work, not undoing the tag.
- **Read cost and lookup cost are measured separately**, because they are
  different operations: reading an id off a layer you already hold, versus
  `app.project.layerByID()` finding one you do not. Reported against the 31.7 µs
  a plain property read already costs, so an expensive carrier shows up as a
  share of the per-frame budget rather than an abstract number.
- **The save/reload test is destructive and gated behind its own button.** It
  saves the current project to a temp file, closes it and reopens it — the only
  way to actually prove persistence — so anything unsaved in the open project is
  lost. It is never part of the default run.

### Results

Host: AE **26.5x89** (note: the transport spikes ran on 26.3x87 — AE updated between
runs, so the two sets are not strictly same-build).

**Native ids exist and are strong.** `layer.id` is present and unique,
`app.project.layerByID()` and `itemByID()` both resolve, `layer.containingComp`
gives the comp back, a duplicate gets its own fresh id, and — the safety
property that mattered most — **a deleted layer's id resolves to `null`, not to
some other live layer.** A lookup that confidently returned the wrong layer would
have been worse than no lookup at all.

### The survival matrix

| carrier | reorder | rename | duplicate | undo | **precompose** | save/reload |
|---|---|---|---|---|---|---|
| **native** | kept | kept | copy gets its own id | kept | **LOST** | kept |
| **comment** | kept | kept | collides ×2 | kept | kept | kept |
| **marker** | kept | kept | collides ×2 | kept | kept | kept |
| **effect** | kept | kept | collides ×2 | kept | kept | kept |

**Precompose destroys the native id.** After `precompose`, neither
`layerByID(2405)` nor a full scan found the layer — AE does not move the layer
into the new comp, it creates a new one, and the id does not come with it. Every
stamped carrier survived, because the tag is layer *data* and gets copied.

That single cell is the whole reason this spike had a precompose column.

### Costs, n = 200

| carrier | per read | per lookup | per write |
|---|---|---|---|
| native | **2.4 µs** | **71.5 µs** | — (AE assigns) |
| comment | **2.5 µs** | — | 86 µs |
| marker | 14.2 µs | — | 778 µs |
| effect | 28.9 µs | — | 1,654 µs |

### A claim of mine this falsified

I wrote, on discovering `app.project.layerByID`, that "the reconciler never
scans". **That is wrong, and the measurement says so:** a lookup costs 71.5 µs
against 2.4 µs to read the id off a layer you already hold — about **30×**. For a
whole-comp pass, walking 200 layers and building an id → layer map costs
**0.48 ms**; resolving the same 200 by lookup costs **14.3 ms**, more than twice
the entire 6.3 ms clean property diff.

`layerByID` earns its keep for resolving *one* layer on demand — a node clicked
in the graph, a cross-comp reference — not for bulk reconciliation. Scanning is
the fast path.

### The scheme this points to: comment as anchor, native id as handle

Neither carrier wins alone. Native dies on precompose; comment cannot tell an
original from its duplicate. Together they cover each other, and the combination
costs almost nothing:

- **`comment` is the durable anchor.** It survives every operation tested,
  including precompose and save/reload, and reads at 2.5 µs — statistically the
  same as the native id, and 6× cheaper than a marker.
- **`layer.id` is the live handle**, cached in the node → layer map and refreshed
  whenever it goes stale.
- **Duplicate detection falls out of the pair.** Two layers sharing a comment tag,
  one of which still carries the native id the graph recorded: that one is the
  original, the other is the copy, and gets a new tag. Neither carrier can do
  this alone.
- **Precompose is recoverable.** The native id goes stale, the comment tag is
  re-found by scan, and the handle is re-bound.

Marker and effect are viable fallbacks but cost 6× and 12× more to read and 9×
and 19× more to write, for no additional survival.

**The open cost is a product one, not a technical one:** `comment` is a visible,
user-editable column in the timeline. A user can clear it, and then the layer is
orphaned. That is a Wall 2 problem (the user editing generated state), not an S3
one — but it is where it will bite.

### What S3 will NOT settle

- **Copy/paste between comps and between projects** is not automated here, and
  is a real user action. Untested. Given that precompose already breaks the
  native id, cross-comp paste is likely to as well — assume it does until
  measured.
- **The undo column is weaker than it looks.** The test issued an undo via
  `findMenuCommandId('Undo')` and confirmed the tag survived, but never checked
  that the undo *did* anything — an undo that silently no-ops would also show
  every carrier surviving. The instrument now verifies the unrelated edit
  actually reverted; **the undo row above predates that fix and should be re-run
  before it is trusted.**
- Only layer 1 of a three-layer comp is tagged; nothing about behaviour at scale
  or with nested precomps beyond one level.
- Whether a carrier is *acceptable to the user* — `comment` is a visible,
  user-editable column, and a stamped Slider Control shows up in Effect Controls.
  That is a product judgement the matrix cannot make.

## S4 — Drift detection

**Premise to falsify:** *we cannot tell, cheaply enough to do it on every diff,
that the user edited the comp we generated.*

Instrument: the **Drift** tab of `../cep-spike/`.

S3 sharpened this one. The identity anchor is `layer.comment` — a visible,
user-editable timeline column — so "did the user touch our comp" is no longer a
tidiness question. It is how we find out that a layer was orphaned.

### Snapshots are keyed by layer id, never by index

An index-keyed snapshot reports a one-layer reorder as *everything changed* —
true, and useless. Keying by `layer.id` makes **added / removed / changed** three
distinct answers, and a reorder shows up as what it is. This is the same
structure the reconciler needs anyway.

### What it measures

1. **Any native change signal?** Probes `app.project.dirty` / `.modified` /
   `.revision` / `.timeChanged`, `comp.revision` / `.modified`,
   `layer.revision` / `.modified`. **Carries a control** (`app.project.numItems`,
   which certainly exists), so that "AE offers nothing" cannot be concluded from
   a broken probe.

   **First run, against expectation: `app.project.dirty` and
   `app.project.revision` both exist.** Everything else is absent.

   Existing is not the same as being usable, so a second test asks whether the
   signal actually tracks edits — it could fail in either of two directions.
   `dirty` may simply mean "unsaved changes" and latch true forever; `revision`
   may count saves rather than edits. The test reads the pair after: reads only
   (it must **not** move), a real edit (it must), rewriting the *same* value, and
   a second distinct edit (does it increment, or merely latch?). It also prices
   the read.

   **If it ticks per edit and stays still otherwise, it is a free gate** — run
   the snapshot only when it has moved. That is worth considerably more than
   making the snapshot faster. It still cannot say *what* changed or whether the
   change was ours, so the snapshot remains the answer to those.
2. **Snapshot cost at three levels** on the 200-layer comp — `structural`
   (index, name, enabled, parent, in/out, comment), `transform` (+ the five
   transform values), `effects` (+ every effect parameter). You only pay for what
   you need to detect. Compared against the 6.3 ms a clean property diff already
   costs, since both would run on every pass.
3. **Hash versus compare, as alternatives not additions.** Either keep the
   previous snapshot and compare it, or keep a hash and compare that. Hashing a
   long digest character by character in ExtendScript is not obviously cheap, so
   all three are timed: hash, whole-string compare, and id-map compare.
4. **Fidelity — eleven mutations × three levels.** rename, reorder, move,
   opacity, disable, delete, addLayer, **clearComment**, addEffect, parent — and
   `none` as a control, because a level that reports drift when nothing happened
   would make every other row meaningless. A cheap snapshot that misses the drift
   that matters is worthless, and `clearComment` is the one S3 says will hurt.
5. **Does our own patch look like drift?** It must — unless we re-snapshot after
   patching. This prices the protocol: snapshot-after-patch is part of the patch
   budget, not free.

### Results

**`app.project.revision` is a usable gate, and it is free.**

| | dirty/revision | |
|---|---|---|
| at start | true/12587 | |
| after reads only | true/12587 | did not move — correct |
| after a real edit | true/12588 | moved |
| after rewriting the **same** value | true/12589 | **moved anyway** |
| after a second edit | true/12590 | increments, does not latch |
| cost to read | **2.3 µs** | |

It increments per operation, stays still when nothing happens, and costs
essentially nothing to read. **So the snapshot only runs when this has moved** —
worth far more than any snapshot optimisation.

One caveat the test caught: **rewriting an identical value still ticks it.** It
counts *operations*, not semantic changes, so it answers "has anything happened
since I last looked" and never "did anything actually change" or "was it me".
Re-baseline after every patch of ours.

### Snapshot cost — linear, and the level is the whole decision

Per-layer cost is flat from n=25 to n=200, so nothing here is quadratic and the
earlier freeze was not this.

| level | n=200 total | per layer | vs structural |
|---|---|---|---|
| structural | **2.6 ms** | 13 µs | — |
| transform | **18.8 ms** | 94 µs | 7× |
| effects | **27.9 ms** | 140 µs | 11× |

### Hashing is dead

Not close, and the reason to have measured it rather than assumed:

| n=200 | structural | transform | effects |
|---|---|---|---|
| hash the digest | 4.5 ms | 10.5 ms | 14.4 ms |
| **compare two digest strings** | **1 µs** | **3 µs** | **3 µs** |
| compare the id maps | 0.36 ms | 0.34 ms | 0.35 ms |

A whole-string compare is **three orders of magnitude** cheaper than hashing the
same string. Keep the previous digest, compare it directly; use the map compare
(~0.35 ms) only when you need to know *which* layers moved. The hash goes.

### Fidelity — the level decides what you can see

Six-layer comp. Numbers are layers touched.

| user does this | structural | transform | effects |
|---|---|---|---|
| **nothing** (control) | quiet | quiet | quiet |
| rename | ~1 | ~1 | ~1 |
| reorder | ~4 | ~4 | ~4 |
| move position | **missed** | ~1 | ~1 |
| change opacity | **missed** | ~1 | ~1 |
| disable | ~1 | ~1 | ~1 |
| delete a layer | −1 ~3 | −1 ~3 | −1 ~3 |
| add a layer | +1 ~6 | +1 ~6 | +1 ~6 |
| **clear the comment** | ~1 | ~1 | ~1 |
| add an effect | **missed** | **missed** | ~1 |
| re-parent | ~1 | ~1 | ~1 |

**No false positives:** the `none` control is quiet at every level.

**The S3 residual risk is caught at the cheapest level.** Clearing a layer's
comment — the user wiping the identity anchor and orphaning the layer — shows up
in a 2.6 ms structural snapshot. That was the failure S3 handed forward, and it
is detectable for almost nothing.

Reorder touching 4 layers and add touching 7 are honest: those operations really
do shift several layer indices. That is why the count is reported instead of a
bare tick.

### What this makes the protocol

One read pass serves two purposes — **the reconciler's diff and the drift
snapshot are the same read**, so they should never both run.

1. **Idle tick:** read `app.project.revision` — 2.3 µs. Unchanged → nothing has
   happened, stop.
2. **It moved:** structural snapshot (2.6 ms) + string compare (1 µs). That
   catches structure, naming, parenting, enable state and the identity anchor.
3. **Need values too:** escalate to transform (18.8 ms). Too expensive for every
   frame on a 200-layer comp, and it does not need to be — the gate means it
   runs only after something actually happened.
4. **After our own patch:** re-snapshot to re-baseline. Costs 1.8 ms structural,
   18.2 ms transform, 28.3 ms effects.

### The self-patch test was wrong, and its result is void

It reported `ownPatchLooksLikeDrift: false` at every level — which would mean our
own writes are invisible to drift detection. That is not a finding, it is a bug:
**the test always wrote opacity 60.** The structural pass set all 50 layers to
60, then the transform and effects passes wrote 60 over 60, changed nothing, and
duly detected nothing.

The structural row was never evidence either — opacity is not in a structural
snapshot, so "not detected" there is correct by construction, not a result.

Fixed: it now reads the current value and writes a different one, reports both,
and the panel labels out-of-scope levels `n/a` rather than letting them read as
passes. **Re-run before trusting that table.** The expected answer is *yes, our
patch looks exactly like drift* — which is why step 4 above exists.

### What S4 will NOT settle

- **What to do about drift.** Detecting it is a measurement; deciding whether the
  graph wins, the comp wins, or the user is asked is Wall 2, and a product call.
- **Polling cadence.** This measures the cost of one check, not how often to run
  it, nor what it costs to run while the user is dragging something.
- Keyframes, masks, expressions and text are not in any snapshot level. A user
  keyframing a property we own would go undetected.
- Six-layer comp for fidelity, 200 for cost. Nothing about detection at scale.
- **Whether `revision` moves for things other than comp edits** — a render-queue
  change, a preference, an import. If it ticks for unrelated activity the gate
  still works, it just opens more often than it needs to.
- Whether the gate holds while the user is mid-drag, when AE is coalescing
  updates.

### Instrument bugs found on the first run

Both fixed; recorded because the first is the more instructive.

- **The broken-control guard was itself broken.** It tested
  `found[0].indexOf('numItems') === 0`, but the label begins `app.project.`, so
  the match sat at index 12 and every healthy run was reported as a broken
  probe. The check that exists to catch a faulty instrument was the faulty part.
  It now sets a flag at the point of the check rather than string-matching a
  label afterwards.
- **A stale project crashed the cost pass.** The identity save/reload test
  replaces the open project, which has no `NTL Spike` comp — so the cost pass
  divided by zero layers, and ExtendScript raises *"invalid numeric result
  (divide by zero?)"* rather than yielding `Infinity`. Every per-unit figure in
  the host now goes through a guard that returns `-1` for an empty denominator,
  and the drift and identity tabs build the comp themselves instead of assuming
  another tab ran in whatever project happens to be open.

### The session wedged during the first S4 run

Running the cost pass at `transform` level, After Effects stopped responding.
Measured rather than assumed: **0.0% CPU over four seconds, `Responding: False`,
2.6 GB working set.** A slow ExtendScript loop pegs one core; this was doing
nothing at all. That is a block, not a long computation, and it does not recover.

Two candidate causes, and the evidence does not yet separate them:

1. **The `transform` snapshot is pathological** at 200 layers — a quadratic
   `comp.layer(i)` resolve, or a property read that forces evaluation.
2. **The save/reload test poisoned the session.** It calls `app.project.save()`,
   `close()` and `open()` from inside `evalScript`, i.e. it tears down the
   project out from under the CEP bridge. Everything run after it in the same
   session is suspect.

(2) is the more suspicious, because the wedge showed no CPU at all — a bad loop
would burn a core.

**What the instrument now does about it**, so the next run distinguishes them:

- Cost is measured as a **curve** — n = 25, 50, 100, 200 — instead of one
  200-layer sample. A pass that is quadratic looks fine at 25 and hangs at 200;
  only the curve tells them apart.
- Each level gets a **4-second budget**: if it is already past that at a small n,
  the larger sizes are skipped rather than freezing AE.
- The snapshot is **phase-timed**: resolving layer objects, reading fields, and
  joining the digest are timed separately, so "resolving layers is the expensive
  part" is a readable result rather than a guess.
- `evalScript` now **reports when a call has been outstanding for 20 s** instead
  of leaving a dead-looking panel. The call still cannot be cancelled — AE owns
  that thread — but the panel stops pretending everything is fine.

**Re-run S4 in a fresh AE session, before the save/reload test**, and the two
hypotheses come apart on the first two rows.

### The divide-by-zero, and what is still not known about it

It is gone, and the run is clean — but **two changes shipped together and it was
never isolated**:

1. the hash was rewritten to keep every intermediate inside int32, and
2. the transform reads were changed from implicit array-to-string coercion in a
   long `+` chain to an explicit `String(p.value)` in a try/catch.

The phase marker pointed at `read fields`, not `hash`, which argues for (2) — an
implicit `Array` coercion inside a `+` chain being the thing that raised
*"invalid numeric result (divide by zero?)"*. Supporting that: `readErrors` came
back **0** everywhere, so nothing throws on the new path at all.

That is a plausible account, not a demonstrated one. Isolating it would cost one
more run with the old coercion restored, and nothing downstream depends on the
answer — so it is recorded as unresolved rather than written up as a finding.

**The lesson that does transfer:** three rounds were spent patching guesses
(guarding divisions that were already guarded), and the phase marker found it in
one. Instrument the location before theorising about the cause.

## S5 — Undo coexistence

**Premise to falsify:** *After Effects' undo stack and the graph's own history
cannot be kept in agreement.*

Instrument: the **Undo** tab of `../cep-spike/`.

Every patch enters an undo stack the user owns and we do not. Four questions, in
rising order of how badly a bad answer hurts.

| | Question | A bad answer means |
|---|---|---|
| **U1** | is one patch exactly one undo entry? | a user's Ctrl+Z half-reverts a patch, leaving the comp in a state the graph never produced |
| **U2** | can we tell an undo happened? | the comp silently falls behind the graph |
| **U3** | after our patch, whose work does Ctrl+Z undo? | we steal the user's next undo |
| **U4** | **does continuous patching evict the user's history?** | **live sync is not shippable at any transport speed** |

### U4 is the one that could sink live sync

After Effects keeps a bounded number of undo levels. A reconciler that writes a
patch per interaction frame produces an undo entry per frame — and would burn
through the user's entire history in a second or two of dragging. Losing your
undo history because a panel was watching you is not a performance problem that
a faster transport fixes; it is a design constraint on when a patch may be
written at all.

The test plants an edit the user would care about (a layer rename), buries it
under *k* patches, then undoes *k+1* times and checks whether that edit is still
reachable. Depths 5, 20, 40, 80. If the name is still `USER-EDIT` after undoing
everything, that edit fell off the bottom of the stack and can never be recovered.

It also reads AE's configured undo-levels preference — trying several plausible
keys and **reporting which one answered** rather than asserting one, since the
key is not consistent across versions. If none answer, U4 measures the limit
empirically instead.

### Honesty features

- **The probe carries a control**, as in S4, so "AE offers nothing" cannot be
  concluded from a broken probe.
- **U1 reports `UNTESTED` rather than a verdict** when the undo could not be
  triggered — the same trap S3's undo column fell into, where issuing a command
  that silently no-ops looks exactly like everything surviving.
- **A pass at the tested depths is reported as "the limit is beyond what was
  tested"**, not as "there is no limit".

### First run: void

Every test reported a failure, and all five were **one artefact — the undo never
fired**:

| reported | actually |
|---|---|
| `revertedByOneUndo: 0` — "NOT atomic" | nothing was undone |
| `valueAfterUndo: 23` — "undo undetectable" | the patched value was still there |
| `revision` unchanged across the undo | no operation occurred |
| `nameAfterUndo: "USER-EDIT"` | not reverted |
| **"evicted at depth 5"** | the user edit was never undone in the first place |

`undoMethod: "findMenuCommandId"` meant only that `findMenuCommandId` returned a
non-zero id and `executeCommand` did not throw. **Neither is evidence that an
undo happened.** The `evicted` flag was `name === 'USER-EDIT'`, which is
precisely what a no-op undo produces.

This is the same trap S3's undo column fell into. It was identified there, fixed
there with an `undoEffective` check — and then not carried into S5.

**The alarming headline was false.** "Live patching destroys the user's undo
history" was never measured.

### Suspected cause, and the rebuild

After Effects dispatches menu commands through its own queue, so an undo
requested inside `evalScript` plausibly only runs **after the script returns**.
Every post-undo read in that same script would then see pre-undo state — exactly
the pattern observed.

The instrument is rebuilt around that:

- **Split across script boundaries.** `NTL_undoBegin` → `NTL_undoFire` →
  `NTL_undoInspect` are three separate `evalScript` calls with a pause between
  the fire and the read, so AE gets a turn to run whatever it queued.
- **A positive control gates everything.** Set a known value, fire, read back in
  a later call, and check it actually reverted. Three methods are tried —
  `findMenuCommandId('Undo')`, command id 16, command id 2 — and the first that
  demonstrably reverts a known edit is the one used for the real tests.
- **If no method works, the panel reports S5 as UNTESTED** and says so in those
  words, rather than converting a dead trigger into four findings.

### What the failure already establishes

One real result survives, independent of whether any method eventually works:

> **A script cannot reliably roll back its own patch through the undo stack.**

That matters for error recovery. A patch that fails halfway has to be reverted by
writing the previous values back — the reconciler must keep them — not by asking
After Effects to undo.

### Results, once the control gated them

The control immediately earned its place: **`findMenuCommandId('Undo')` returns
id 2371, and executing it undoes nothing.** The method that works is
`app.executeCommand(16)`. A non-zero-but-inert menu id is precisely what poisoned
the first run — the old helper tried the menu path first, got a plausible id, and
called it success.

The queued-command hypothesis was wrong, incidentally: the split protocol was not
what fixed this. The menu id simply was not undo.

| | Question | Answer |
|---|---|---|
| **U1** | is one patch exactly one undo entry? | **Yes.** 4 properties in one group, one undo, all 4 reverted. `stillPatched: 0` at n=1 and n=4 |
| **U2** | can we tell an undo happened? | **Yes.** `revision` moves every time — and by the *number of properties reverted* (+1 at n=1, +4 at n=4), so S4's gate sees an undo and roughly how large it was |
| **U3** | whose work does Ctrl+Z undo? | **Ours.** After a user rename plus our patch, one undo took the opacity 11→100 and left the name `USER-EDIT` |
| **U4** | does patching evict the user's history? | **Not at 5, 20, 40 or 80 patches** — the edit stayed reachable and all 81 undos fired |

### U4, with the depths extended: the ceiling is 99

| patches | entries | user's edit |
|---|---|---|
| 5 | 6 | reachable |
| 40 | 41 | reachable |
| **80** | **81** | **reachable** |
| **100** | **101** | **EVICTED** |
| 140 | 141 | evicted |
| 200 | 201 | evicted |

The boundary sits between 81 and 101 entries — and the `revision` deltas pin it
exactly. On every evicted run the delta across the undo burst was **+99, to the
digit**, at 100, 140 and 200 patches alike; on the runs that passed it tracked
the number fired (+7 at 5, +42 at 40, +82 at 80). **After Effects performs at
most 99 undos because it keeps at most 99 entries.** Measured, not inferred from
documentation.

### Eviction does not merely lose history — it strands the comp

The evicted runs did not come back clean. Layer 1 was left at opacity **21** (and
**61** at depth 140) with the name still `USER-EDIT`: the oldest patches remain
applied, because the undos ran out before reaching them.

So exhausting the stack leaves the comp in a state that is **neither the graph's
nor the user's original** — a partially-undone hybrid that nothing in the system
authored. The reconciler would see it as drift and patch over it, which is
survivable; the user's lost work is not.

### The arithmetic that decides the cadence

99 entries, shared between the user's edits and ours. One patch per interaction
frame at 60 fps fills all 99 in **1.65 seconds**. That is no longer a
hypothesis — the ceiling is measured and the division is arithmetic.

> **Patches are coalesced into one undo group per gesture. Never one per frame,
> and never on a timer.**

The sharper form of the rule, which falls out of *whose* entries these are: an
undo entry the user authored is correct — that is what undo is for. An entry they
did not author is theft. So a patch may be written when the user acts, and must
not be written because a clock ticked or a reconciliation pass felt like running.

### Superseded: U4 passed, but did not find the limit

*(Kept as a record of the reasoning.)* The first extended run stopped at 80
patches and reported no eviction. That was *"the limit is above 80"*, not *"there
is no limit"* — 81 entries simply fit under a ceiling nobody had measured yet. A
test that never reaches the failure it was built to find has not passed it, so
the depths were pushed out rather than the result banked. The ceiling turned out
to be exactly where the guess pointed, which does not make banking it the right
call.

### What this already constrains

1. **One undo group per patch is mandatory**, and U1 says it works: the whole
   patch reverts as a unit, so a user's Ctrl+Z can never leave the comp in a
   state the graph never produced.
2. **An undo is drift**, and S4's gate already detects it — no separate
   machinery needed. The comp falling behind the graph because the user undid our
   work is just another `revision` move to reconcile.
3. **We steal the user's next undo.** Every patch sits on top of their history.
   Tolerable once; at one patch per frame it makes Ctrl+Z useless to them, which
   is the same argument U4 is measuring from the other direction.
4. **A script cannot roll back its own patch through the undo stack reliably** —
   the working method is a bare command id, not something to build error recovery
   on. A failed patch must be reverted by writing the previous values back, so
   the reconciler has to keep them.

**The design consequence, ahead of U4's boundary:** patches cannot be written per
interaction frame. They must be coalesced — one undo group per gesture, written
at the end of a drag — or the user's history is collateral damage regardless of
where exactly the ceiling sits.

### What S5 will NOT settle

- **The graph's own undo history.** This measures AE's stack only. Keeping two
  histories in agreement — user undoes in AE, does the graph roll back too? and
  vice versa — is a design question that S5 only supplies constraints for.
- **Whether a patch can avoid the undo stack entirely.** The probe records what
  the scripting surface offers, but a genuine no-undo write path, if one exists,
  is likely a C++ AEGP matter rather than an ExtendScript one.
- **Redo.** Untested throughout. Note the probe found no `Redo` menu command id
  at all, while `Undo` resolved to one.
- **Whether the queued-command hypothesis is correct.** The rebuild is designed
  so the answer does not matter — if the split protocol works, the cause was
  queueing; if it still does not, no scriptable undo exists and S5's remaining
  questions need a human pressing Ctrl+Z or a native AEGP.
- Coalescing patches into one undo group per gesture is the obvious mitigation
  if U4 fails, but its cost and its effect on the S4 drift baseline are not
  measured here.

## S6 — The time model

**Premise to falsify:** *a graph that owns structure but not time is not an
improvement on the layer stack.*

This is the one design question in P0, and it decides the MVP's shape. Wall 4
option (a) gives the graph structure and leaves keyframes to After Effects.
Option (b) makes time an input to the graph, and would force baking curves —
which Wall 1 says is the expensive direction.

Instrument: the **Time model** tab of `../cep-spike/`.

### The measurement inside the judgement

Taste comes last. One number comes first: **how much of a real shot is structure,
and how much is time?**

- **Structure** — parent links, precomp layers, effects, masks, track mattes,
  non-normal blend modes. What a graph would draw as nodes and edges.
- **Time** — animated properties, time-remapped layers, trimmed layers,
  time-stretched layers. What option (a) leaves in the timeline.

The census walks **the comp the user currently has open** — their own real work,
read-only, nothing written — recursing into precomps to depth 3 and the property
tree to depth 6, counting both sides.

### The threshold, fixed before any comp was measured

> If animated properties outnumber structural relationships by more than
> **3:1**, a structure-only graph is showing the minority of the work, and
> option (b) comes forward.

Stated up front and written into the panel so the verdict cannot be fitted to the
number afterwards. That has been the failure mode worth guarding against
throughout this project — three spikes have already turned out to be measuring
their own instruments.

### Also: the comp-state reader, early

The **Dump structure** button emits one row per layer — index, name, kind,
parent, effect count, mask count, animated properties, keyframes, expressions,
effect names. That is the same read **P1.1** needs for its comp-state reader, and
it is the input for sketching a real shot as a node graph to look at beside the
timeline.

### How to run it

Open a real shot, click into the comp, press **Census the active comp**. Repeat
across genuinely different kinds of work — a character rig, a title sequence, a
UI animation, a compositing-heavy shot. Each run appends to the saved JSON.

**One comp is one data point.** The ratio will vary enormously by kind of work,
and the answer that matters is the shape across several, not the first number.

### Results — nine real comps

| comp | structure | time | time:structure |
|---|---|---|---|
| AESPA — PANTALLAS | 101 | 33 | 0.33:1 |
| SF06-ARRE-ESCENARIO2 | 155 | 112 | 0.72:1 |
| MEXAV26 — CORTINILLA | 101 | 78 | 0.77:1 |
| 01 | 159 | 141 | 0.89:1 |
| INDRIVE JULIO — ENGLISH | 111 | 121 | 1.09:1 |
| MEXAV26 — BREAK COMIDA | 100 | 110 | 1.10:1 |
| INDRIVE — SUPERSTICIOSO | 68 | 158 | 2.32:1 |
| MEXAV26 — WARM UP | 44 | 135 | 3.07:1 |
| SF02-ARRE-ESCENARIO2 | 2 | 28 | 14.00:1 |

**Median 1.09:1. Seven of nine sit below the 3:1 line fixed in advance.**

The two that do not are both explicable rather than contrary:

- **SF02 at 14:1** has a structure score of **2** — 17 layers, no parenting, no
  precomps, no effects. A tiny denominator, not a temporal shot. It is a flat
  stack of footage driven by 24 expressions.
- **WARM UP at 3.07:1** is marginal, a hair over the line.

**Verdict on the stated test: option (a) survives.** A graph that owns structure
would be showing a real share of this work, not a minority of it.

### Two reasons the result is conservative

Both biases run *against* structure, so the true margin is wider than the table
shows.

1. **`trimmedLayers` inflates the time score.** It counts any layer whose in/out
   is not the full comp duration — which, in a 600-second comp like BREAK COMIDA,
   is nearly every layer trivially. That is sequencing, not temporal complexity,
   and it is a large part of every time score here.
2. **Keyframe counts overstate hand-authored time work.** INDRIVE — SUPERSTICIOSO
   reports 1,293 keyframes, but its structure dump shows two Mocha tracking
   layers carrying **464 keyframes each — 928 of the 1,293, or 72%**. That is
   machine-generated tracking data, not animation a graph would ever want to own.
   Leaving it in After Effects is exactly right.

### The finding the test was not looking for

Expressions were deliberately counted but scored on **neither** side, on the
grounds that an expression is both a relationship and a function of time.

Across the nine comps: **649 expressions against 484 animated properties — 1.34
expressions for every keyframed property.**

| comp | expressions | animated properties |
|---|---|---|
| SF06-ARRE-ESCENARIO2 | **178** | 54 |
| 01 | **104** | 64 |
| INDRIVE — ENGLISH | **91** | 61 |
| WARM UP | **85** | 77 |
| AESPA — PANTALLAS | **79** | 16 |
| SUPERSTICIOSO | 69 | 94 |

In five of nine comps expressions *outnumber* keyframed properties, by up to 5:1.

An expression is a statement that one value is a function of another — which is
precisely what an edge in a node graph is. **This work is already a dependency
graph.** It is simply stored as several hundred invisible text fields scattered
through the timeline, where it cannot be seen, traced, or refactored.

That is a stronger argument for the node view than the structure/time ratio ever
was, and it arrived from a column excluded from the test. It is recorded here as
a **hypothesis to test next**, not as a result the test produced: the census
counted expressions, it did not evaluate whether they would be better as edges.

### A third observation: reuse

`reusedPrecomps` runs high — 62 of AESPA's 91 layers are repeat references to
comps already walked, and 16-19 is typical elsewhere. A graph shows reuse
natively as one node with many consumers. A timeline shows it as duplicated
layers with no indication they are the same thing.

### What this makes the MVP

Option (a) stands, with its scope widened by one category:

> **The graph owns structure and relationships. After Effects keeps keyframes.**

Structure because the ratio holds; relationships because they are the largest
hidden category in real work and the thing a graph is uniquely good at; keyframes
stay in AE because much of that volume is machine-generated tracking and because
Wall 1 says baking curves is the expensive direction.

### What S6 will NOT settle

- **Whether the node view is nicer to work in.** The census bounds the question;
  it cannot answer it. That needs a real shot expressed as a graph and a human
  looking at both.
- **Whether expressions are better as edges.** The census counted them and found
  they dominate; it did not test whether drawing them as graph edges is an
  improvement. That is the obvious next question, and ExtendBlueNode is a
  working precedent for exactly that idea — it already turns expression logic
  into nodes.
- Keyframe *interpolation* and easing, which is much of the craft in a temporal
  shot and is invisible to a count of keyframes.
- Comps deeper than 3 levels of nesting, or property trees deeper than 6. Both
  report `depthCapped`, and the counts are then a floor rather than a total.

---

## P1 in-AE pass — run 1 (2026-09-11, AE 26.5x89)

`jsx/p1-check.jsx`, run from File > Scripts > Run Script File. It builds its own
comp, tests, and deletes it. **Verdict: FAIL — 4 of 27**, harness control valid.

### Run 0 was VOID, and not because of After Effects

The first attempt crashed: *"Function ntlrTagFor is undefined"*. `$.evalFile`
loaded all three files — the missing-file guard never fired — but their function
declarations never reached global scope. Replaced with `#include`, which splices
the text in at parse time, plus a by-name load check so a load failure is
reported as one instead of surfacing as a crash 90 lines later.

The pre-flight passed that file both times, correctly: the source *parsed*. No
static check would have caught a load-time scoping failure.

### What After Effects confirmed

| assumption | result |
|---|---|
| `layer.id` survives rename and reorder | **yes** (1513 throughout) |
| `layer.comment` survives a rename | **yes** |
| `app.project.revision` moves on a write | **yes** (13443 → 13444) |
| `setValue` on a keyframed property throws | **yes** — *"Can not call setValue() on a property with keyframes"* |
| an expression round-trips byte-exact, tag intact | **yes** |
| clearing an expression disables it | **yes** |
| the writer refuses keyframed / unknown tag / stale | **yes**, each with its sentence |
| the reader's output is the shape the diff consumes | **yes**, `readErrors: 0` |

### Prices, re-measured in the real pipeline

| | this run | P0 said |
|---|---|---|
| per property write | **48.8 µs** | 130 µs |
| full read round trip (4 layers) | 0.95 ms | — |
| patch round trip (10 ops) | 0.75 ms | — |
| `app.project.layerByID` | **3.3 µs** | 71.5 µs (S3) |

**The `layerByID` figure contradicts S3 by 20×** and is recorded as an open
question, not a correction: this ran on a 4-layer comp against S3's 200, and it
is 10 calls against S3's larger sample. The decision to scan does not depend on
it — the reader needs every layer anyway — but the *ratio* quoted in the reader's
header should not be repeated until it is re-measured at size.

### Two of the four failures were the harness

The comp has **three tagged layers and one untagged**, four in all. The check
expected four tagged. The reader reported `managedLayers: 3` and was right; the
same arithmetic error was in the scan check. Fixed.

That is the fourth time in this project the instrument, not After Effects, was
the finding.

### The other two are real, and were entangled

`CONTROL: undo actually undoes` failed, and `a two-op patch applies` failed while
its own receipt reported `applied: 2`. Both read through a property handle cached
before an undo.

That also casts doubt on a check that **passed**: *"ONE undo reverts the WHOLE
patch"* expected 100 and got 100 — but a stale handle would read 100 whether or
not undo did anything. Exactly the S5 trap, which is why it is not being counted
as evidence.

Three candidate causes remain tangled: a cached handle reading stale after an
undo, `executeCommand(16)` not being Undo on 26.5, or a second consecutive undo
not firing because the group is not yet committed. **Run 2 separates them** by:

- taking every read **twice at the same moment** — through the cached handle and
  through a fresh scan — and recording both in `undoTrace`, so a disagreement is
  stated rather than inferred;
- running the undo control **first and alone**, before the patch undo, so "does
  Undo work at all" is answered before "does a second undo in a row work";
- splitting the control into *a plain write lands* and *undo reverts it*, so a
  failure says which half broke;
- splitting the two-op check into value and name.

Nothing about P1's design changes yet — none of this is evidence against the
reconciler. It is evidence that the undo checks could not tell us what they were
being asked.