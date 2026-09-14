# Node Timeline — roadmap

**What to do next, in order.** The reasoning lives in `PLAN.md`, the evidence in
`SPIKES.md`. This file goes stale fastest; it is the one to distrust.

---

## Status

**P0 is complete: S1, S2c, S3, S4, S5, S6 and S7 all pass; S2/S2b are moot.** S1 (write-path latency) **passed** on
2026-09-10, and passed on the number that mattered most: a clean 200-property
diff costs 6.8 ms in AE, so a reconciler can run every interaction frame without
dirty-tracking.

**S2 (poll sweep) came back flat and is inconclusive.** Ten configurations, poll
varied 15×, all within 2 ms of each other at ~281 ms. Either the instrument's
`cfg` op is disconnected, or the poll interval was never the floor and AE's
*background* idle loop is. S2b exists to separate those, and until it runs
**there is no quotable transport floor** — S1 says 94 ms, S2 says 281 ms, and
they were taken with AE in different states.

**S2c passed, decisively.** The dockable CEP panel dropped the floor from 94 ms
to **1.2 ms**, and a 50-property patch from 125 ms to **17.3 ms** — about one
frame at 60 fps. The socket agent was the whole bottleneck and S2's flat sweep
was its artifact. Live sync is viable; S2 and S2b are closed as moot.

**The clean diff is confirmed at 6.33 ms / 31.7 µs per property**, matching the
socket spike's 6.8 ms once M3 was repeated properly. The 21.0 ms was a single
high sample. Diffing beats dirty-tracking, measured twice by two different means.

Repetition also bought two findings a single sample had hidden:

- **Diff and apply must be separate phases** (`PLAN.md`, Wall 1b). Interleaved
  read/write with no undo group costs **2.26×** — 294 µs per property against
  130 µs. Free to avoid; it is the shape a reconciler wants anyway.
- **Layer creation cost grows with comp size** — 4.35 ms per layer building
  0→200, 14.6–17.8 ms adding onto an existing 200. Wall 1 is sharper than it
  looked: structure degrades superlinearly in exactly the big projects a node
  system is for.

**S7 is answered: IllusionFX left out of ambition, not because of a wall.** The
gate is green, and MVP scope can now be fixed.

**S3 passed** with a hybrid scheme: `layer.comment` as the durable anchor,
native `layer.id` as a cached handle. Neither works alone — the native id does
not survive precompose, and a comment tag cannot tell an original from its
duplicate — but together duplicate detection and precompose recovery both fall
out for free. See `PLAN.md`, Wall 1.

It also falsified a claim made here: **resolve by scanning, not by
`layerByID()`** — a lookup costs 30× a direct id read, so a whole-comp scan is
0.48 ms against 14.3 ms of lookups.

**S4 passed, and better than the gate it was asked for.** `app.project.revision`
increments on every operation and costs **2.3 µs** to read, so the snapshot only
runs when something has happened. A structural snapshot is 2.6 ms for 200 layers
and a digest compare is 1 µs — hashing was measured at 4.5 ms and dropped
outright. Clearing a layer comment, the risk S3 handed forward, is caught at the
cheapest level.

Two things it did not settle, one of them mine: **the self-patch test was buggy**
(it wrote the same value every time, so it reported that our own patches are
invisible to drift detection — they are not), and **what to do about drift** is a
product decision, not a measurement.

**Transport, identity and drift-detection are closed. S5 (undo) is the last
technical wall**, plus the S6 time-model design question.

**Wall 2's sync question is answered** (`PLAN.md`): symmetric two-way sync is
impossible — `graph → comp` is not injective, so there is no inverse — but
**capture-where-constant** gives what two-way means in practice. Layer ownership
is free from S3; a user edit to a *constant* node input is written back; a
*computed* input cannot absorb one and stays one-way. No global
graph-wins-vs-comp-wins rule is needed: it is decided per property.

**S5: U1–U3 pass.** A patch is exactly one undo entry and reverts as a unit; an
undo moves `revision`, so S4's gate already detects it and no separate machinery
is needed; and our patches sit on top of the user's history, so their Ctrl+Z
takes our work first.

**U4 found its limit: 99 entries.** 81 survive, 101 do not, and the `revision`
delta saturates at exactly +99 on every evicted run. Eviction also **strands the
comp** — the oldest patches stay applied, leaving a state neither the graph nor
the user authored.

**So the cadence changes, not the speed.** At 60 fps, one patch per frame fills
all 99 entries in **1.65 seconds**. Patches are coalesced into **one undo group
per gesture**, written when the user acts — never on a timer. Latency is still
what makes that end-of-gesture write feel instant, which is why S1–S4 still
matter; only the per-frame model they were measured against is retired.

**P0 IS COMPLETE. Every gate is green.** S1, S2c, S3, S4, S5, S6 and S7 all pass;
S2/S2b are moot.

**S6 passed on nine of the owner's real comps** — median time:structure 1.09:1,
seven of nine under the 3:1 line fixed in advance, with both measurement biases
running against structure. Option (a) survives on evidence.

**And the census found something it was not looking for: 649 expressions against
484 animated properties.** In five of nine comps expressions outnumber keyframed
properties, by up to 5:1. An expression is an edge — this work is already a
dependency graph, stored as invisible text fields. **The MVP's scope widens
accordingly: the graph owns structure *and relationships*; After Effects keeps
keyframes.**

**P1 is underway.** `src/diff.js` is the reconciler's read half: pure, no After
Effects, **15/15 tests green offline** — and the suite was falsified against a
deliberately broken control (a reconciler that adopts untagged layers), which
failed exactly the one test that guards the user's own work.

Expression edges are folded in from the start, as decided: an edge writes a
tagged expression onto the target property, which After Effects then maintains
itself. That makes the relationship self-sustaining — it cannot drift, and costs
nothing per frame.

Rules the diff now enforces, each traceable to the spike that paid for it:

| rule | from |
|---|---|
| untagged layers are never read from, written to, or deleted | S3 / Wall 2 |
| diff is read-only; writes are a separate batched phase | Wall 1b, measured at 2.26× |
| a duplicated layer is detected by tag + native id, and the copy is left alone | S3 |
| an expression the user wrote is never overwritten | ownership by tag comment |
| a property driven by an edge is not also written as a value | — |
| floats compare with tolerance | AE round-trip noise |
| ops are ordered clear → create → name → prop → parent → expression → reorder → delete | expressions address layers by name |

### P1.1 — the reader (done offline, owed an in-AE pass)

Two files, one on each side of `evalScript`:

- **`jsx/reader.jsx`** reads a comp into `compState`. Strictly read-only: it
  opens no undo group, because it writes nothing. It **scans** (S3: 0.48 ms for
  200 layers against 71.5 µs per `layerByID` call), resolves each property once
  and reads value *and* expression through the same handle, and stamps the read
  with `app.project.revision` so a later pass can tell whether the state is
  still current.
- **`src/reader.js`** validates the payload and hands the diff a `compState`, or
  refuses. It refuses on: a host failure, a duplicate native id (which means the
  read is wrong, not that a layer was duplicated), and **any partial read**.

That last rule is the one worth stating. The host counts unreadable properties
rather than swallowing them, and the panel will not diff a read with a non-zero
count — because a property that could not be read looks *absent*, and the
reconciler would then emit ops to "correct" values it never actually saw. The
drift gate may opt into a best-effort read explicitly; the write path may not.

**12 offline tests, and the suite was falsified**: accepting partial reads
failed exactly one test — *"a PARTIAL read is refused"* — and nothing else.
27/27 green across both suites.

**Still owed: the in-AE pass.** Nothing here proves After Effects returns these
shapes; it proves the two halves agree about them.

#### The pre-flight was not checking the thing it was adopted for

`jsx_check.py`, carried over from physics-sim, checks brace balance and
unterminated strings. Fed the *exact* break that cost this project a round trip —
`s.replace(/\/g, "x")`, the line-46 bug — it reported **clean**. It has no
notion of a regex literal.

`tools/jsx_check.py` now tracks regex literals, rejects any regex containing a
backslash (the house rule is split/join), and flags ES5+ constructs that parse in
Node and fail in ExtendScript. Verified against four controls: the line-46 break,
an unclosed brace, and `Object.keys(...).map(...)` all caught; ordinary division
not flagged.

That is the third time the instrument, not After Effects, was the finding.

### P1.3 — the patch emitter (done offline, owed an in-AE pass)

`jsx/patch.jsx` is the only file in the project that writes to the user's
project. Four measured facts are built into it:

| it does this | because |
|---|---|
| **one undo group per patch**, never per op | S5: the stack is exactly 99 entries |
| resolves each property once, writes through the handle | Wall 1b: 130 µs against 294 µs |
| patches, never rebuilds | create 14.5 ms against write 0.13 ms |
| finds layers by one scan | S3: 0.48 ms / 200 layers against 71.5 µs per lookup |

**A failed op stops the patch; it is never skipped.** Skipping would leave the
comp in a state that is neither the old one nor the one the graph asked for, and
the next diff would compute against that lie.

**Rollback is re-applying an inverse, not pressing undo.** A script cannot
reliably undo its own patch, and the user's history is interleaved with ours in
the same 99-entry stack — so every op that can be inverted returns its inverse,
built back to front. A patch containing a delete reports `invertible: false`
rather than pretending: re-creating a solid is not restoring the layer that was
there, with its masks, effects and keyframes.

The writer refuses, with a sentence rather than an AE exception: a keyframed
property (S6's boundary — AE keeps keyframes), a hand-written expression, an
ambiguous tag (S3's duplicate — refusing to guess, where the diff only warns), a
layer parented to one of the user's own, and a **stale patch**, checked against
S4's revision gate before a single write.

#### It is tested by execution, not by description

ExtendScript is ES3, and ES3 is valid JavaScript — so `test/fake-ae.js` loads the
**real** `patch.jsx` into a VM against a mock object model. The code under test
is the same text After Effects will run. 17 tests, including the whole pipeline:
graph → diff → patch → comp, **and a second diff that comes back clean**. A
reconciler that did not converge would re-apply its patch forever and burn the
99-entry stack in seconds.

Escaping is treated as a boundary rather than formatting, because the ops travel
as an ES3 **array literal inside the call** — there is no JSON parser in
ExtendScript. A hostile expression body would not be bad data, it would be
source. That test asserts on a **side effect**, not on a substring: my first
version checked that the payload did not appear in the literal, which fails on
escaped text that can never run.

**Falsified twice.** An undo group per op instead of per patch failed exactly the
two undo-discipline tests; dropping the keyframe guard failed exactly the
keyframed-property test.

**The in-AE pass PASSED — 31/31 on AE 26.5x89** (`docs/SPIKES.md`). Identity, the
revision gate, expression round-tripping, one-undo-per-patch, rollback by inverse
and every refusal all behave as the fake predicted; cached handles agree with
fresh lookups throughout. Writes measured 47.6 µs against the 130 µs budgeted.

Run 3 put the *undo → write → undo* sequence back and **it passes (34/34)**,
including a patch applied straight after an undo — so the graph can re-assert
itself after the user presses Ctrl+Z. Run 1's failure is narrowed to one
operation the product never performs: a WRITE through a handle cached across an
undo. Recorded as an observation, since `patch.jsx` re-resolves by scanning on
every patch.

**P1.1, P1.2 and P1.3 are closed.**

### P1.4 — the drift guard (done offline, owed an in-AE pass)

`src/drift.js`. After Effects has no event that says the user edited the comp
behind our back (Wall 2), so drift is detected by comparison — and the only
reason that is affordable is S4's 2.3 µs revision read. Three tiers, cheapest
first:

| tier | what it costs | what it answers |
|---|---|---|
| the **gate** — `app.project.revision` | 2.3 µs, and it is the only thing that runs while idle | did anything in the project move? |
| the **snapshot** — a full structural read, digested | one read, well inside a patch budget | what does the comp hold now? |
| the **compare** — digest against digest | pure JS | did *our* comp move, and where? |

**A moved revision is not yet drift, and that distinction is the point.** The
revision is project-wide: a selection, a view change, or an edit in another comp
moves it while the comp under reconciliation has not changed at all. A guard that
stopped there would cry wolf every few seconds. The digest is what turns that
into `spurious` — the revision is adopted, and nothing is reported.

Managed and unmanaged layers are digested **separately**, so the user
rearranging their own layers is reported and never blocking. Five changes *are*
blocking, because each means an identity the graph was holding is no longer the
thing it thought: the comp changed, a tagged layer vanished, a tag moved to a
different native id (what precompose does, per S3), a tag became ambiguous, or an
edge we authored came back hand-written. Everything else — a nudged value, a
rename — the next diff simply corrects, because the graph is the source of truth.

**Our own patch is not drift.** The baseline is projected forward through the ops
we just sent, so the next compare means "someone *else* changed something". A
patch that created a layer is deliberately not projectable — the native id and
the out point are AE's to decide — and earns one fresh read instead of a guess.

The layer `index` is deliberately **not** digested: an index is a position, and
including it would report every layer in the comp as drifted the moment one was
inserted. Values are canonicalised at the same 1e-6 tolerance the diff uses, or
the guard would report drift the diff then found nothing to correct — a loop that
reads, reports and writes forever.

### P1.5 — the coalesced write loop (done offline, owed an in-AE pass)

`src/loop.js`. Mutate the graph, call `touch()`, and After Effects follows. One
measurement shapes the whole file: S5 put the undo stack at exactly 99 entries,
so a patch per frame would evict the user's entire history in under two seconds
of dragging.

- **While a gesture is open, nothing is written at all.** A gesture is a hold,
  not a debounce: the comp is patched once, when the gesture ends, and costs one
  undo entry however many times the graph was mutated inside it.
- A mutation with no gesture around it is **debounced**, and the window restarts
  on each further mutation.
- **Only one patch is ever in flight.** A mutation arriving mid-patch marks the
  loop dirty again and gets its own pass, rather than racing a patch computed
  from a comp state that is already stale.
- A pass with nothing to write opens **no undo group at all** — an empty one
  would still cost one of the 99.

Each pass is read → guard → diff → patch, in that order. A stale patch is
re-read and re-diffed, never re-sent. A patch that failed partway is rolled back
by re-applying its inverse. A read that cannot be trusted is not written from,
and leaves the loop dirty so nothing is lost.

Drift that blocks **holds** the loop: the pending change is not written, the
panel is told what moved, and the user chooses `acceptDrift()` or
`discardPending()`. That is P1's "refuses or reports", wired to a decision.

**46 further offline tests, 90 in all.** `test/fake-ae.js` now loads the real
`reader.jsx` as well as the real `patch.jsx`, so the loop tests drive the whole
reconciler end to end: mutate a plain JS graph, and a comp changes. Each file
carries a control that must fail — a guard that skips the compare, and a loop
that patches per touch (40 mutations, 40 undo entries: the behaviour P1.5 exists
to prevent).

Extending the fake found a fourth instrument bug, of the same family as the other
three: a VM context is a second JavaScript realm, and `value instanceof Array` is
false across the boundary — so every array-valued property (position, scale,
anchor point) silently vanished from the read. After Effects is one realm and
would never have shown it.

**The in-AE pass PASSED — 25/25 on AE 26.5x89** (`jsx/p1b-check.jsx`,
`docs/SPIKES.md`). `app.project.revision` moves on every edit the guard must
notice — property, rename, comment, expression, parent, create, delete, undo —
**and on an edit in another comp**, which is the measurement the digest tier
exists for. Two reads of an untouched comp are byte-identical, so the digest has
something stable to sit on. A **twelve-op** patch across three layers is **one
undo entry**: one Ctrl+Z put back every value and every name.

The gate measured **0.678 µs**, 3.4× cheaper than S4 — an idle reconciler
polling at 10 Hz spends under 7 µs a second on drift detection. A full
structural read costs 1.34 ms against a 400 ms patch budget.

Two observations with no pass condition fixed in advance: **selecting a layer
does not move the revision, and neither does moving the time indicator** — the
two likeliest sources of spurious wake-ups, and neither costs a read.

Run 1 was 21/23, and both reds were the instrument: a stability check that
compared the read's own stopwatch, and an undo that ran one check too late and
resurrected the layer the delete check had removed. Fifth and sixth times in this
project that the instrument, not After Effects, was the finding.

**P1.4 and P1.5 are closed. P1 is done.**

**Speed is no longer the top risk.** S1 promoted a different question: with the
graph as the source of truth, After Effects has no way to tell us the user edited
the comp behind our back, and its undo stack is a second history we do not own.
Walls 2 and 3 in `PLAN.md`. S3–S5 exist to price them.

**Nothing is being built yet, on purpose.** P0 is falsification. The first line
of product code waits for the gate.

---

## P0 — the gates

Each spike states a premise to falsify, owes an artifact, and has a pass
condition fixed *before* it runs.

| | Spike | Premise to falsify | Pass condition | Status |
|---|---|---|---|---|
| S1 | Write-path latency | a patch is too slow, or a clean diff too expensive, for a live view | patch < 400 ms, clean diff cheap enough to run per frame | **PASS** |
| S2 | Poll sweep | the 94 ms floor needs C++ to move | either the floor drops, or we learn it is not the poll loop | **INCONCLUSIVE** |
| S2b | Focus | the floor is independent of AE being frontmost | a clean yes/no, with the instrument's own controls passing | parked — superseded |
| S2c | CEP panel transport | the floor is AE's, so changing transport will not help | M0 under 94 ms, or a clear statement of which regime we are in | **PASS** — 1.2 ms |
| S3 | Durable identity | a graph node cannot keep a stable handle on an AE layer | an id survives save/reload, undo, rename, duplicate, and reorder | **PASS** — comment + native id |
| S4 | Drift detection | we cannot tell, cheaply, that the user edited the comp | a full-comp state read + hash costs less than one patch budget | **PASS** — a 2.3 µs gate |
| S5 | Undo coexistence | AE's undo and the graph's undo cannot be kept in agreement | Ctrl+Z in AE is either detectable or preventable, one patch is exactly one undo unit, and our patching does not evict the user's history | **PASS** — ceiling measured at 99 |
| S6 | Time model | structure-only is not enough to be useful | the structure:time ratio across several real shots, against a 3:1 line fixed in advance | **PASS** — median 1.09:1 over 9 comps |
| S7 | IllusionFX | a working AE node system left AE for a reason that also blocks us | we can name why, and say whether it applies | **PASS** — ambition, not a wall |

### What each owes

- **S3** — a script that tags a layer, then survives: project save + reload, an
  undo past the tag, a user rename, a user duplicate (two layers, one id — what
  then?), and a reorder. Candidate carriers: layer marker, layer comment, a
  tagging effect. Report which survive what. **Duplicate is the interesting
  case** and the most likely to have no clean answer.
- **S4** — read the full structural state of a 200-layer comp (names, order,
  parents, transform values, effect params) and hash it. Report the cost. If it
  is under ~50 ms it can ride along with every patch and drift becomes solvable
  rather than accepted.
- **S5** — patch, then Ctrl+Z by hand in AE, then ask the comp what it holds.
  Determine whether an `app.beginUndoGroup` patch can be made invisible to the
  user's undo stack, or failing that, detectable.
- **S6** — the only spike that is a *design* question, not a measurement. Take
  one real shot, express it as structure-plus-native-keyframes, and judge whether
  the node view is an improvement on the layer stack when it does not own time.
  If it is not, the MVP is the wrong product and (b) in Wall 4 comes forward.
- **S7** — an afternoon. See `PLAN.md`, "Prior art". **Do this before fixing MVP
  scope**, not after.

### Gate

**All gates green → build P1.** Every spike passed; S2/S2b are moot. Any of S3/S4/S5 red → the graph
cannot be the sole source of truth, and the project falls back to **Architecture
C** (commit on demand) from `PLAN.md`, which is a weaker product but still real.

---

## P1 — POC: close the loop

**No node UI.** The point is to prove the reconciler, and a canvas would only
hide which half is broken.

A plain JS module holds a graph object in memory. A reconciler diffs it against
the live comp and emits a patch. Mutating the object updates After Effects.

| | Step | Owes |
|---|---|---|
| P1.1 | Graph model + a comp state reader | **DONE offline** — `src/graph.js`, `jsx/reader.jsx` (scans; read-only; revision-stamped), `src/reader.js` (validates, refuses partial reads). 12 tests, falsified. **VERIFIED IN AE** (run 2, 31/31). |
| P1.2 | Reconciler: diff graph vs comp state → patch | **DONE** (`src/diff.js`) — pure, read-only, 15/15 offline tests green and falsified against a broken control |
| P1.3 | Patch emitter: one undo group, properties resolved once, stable ids | **DONE offline** — `jsx/patch.jsx` + `src/patch.js`. Stops on failure, returns an inverse for rollback, refuses stale/keyframed/ambiguous/user-owned. 17 tests run the real JSX in a VM; falsified twice. **VERIFIED IN AE** (run 2, 31/31). |
| P1.4 | Drift guard, using S4: revision gate → structural snapshot → digest compare | **DONE** — `src/drift.js`. Three tiers; a moved revision is classified before it is called drift; five changes block, everything else is reported and corrected. 23 tests, falsified against a blind control. **VERIFIED IN AE** (run 2, 25/25); the gate measured 0.678 µs. |
| P1.5 | Coalesced write loop — one undo group per gesture, not per frame (S5) | **DONE** — `src/loop.js`. A gesture is a hold, not a debounce; one patch in flight; stale re-read, failure rolled back, drift held for the user. 23 tests driving the real reader and writer end to end. **VERIFIED IN AE**: a twelve-op patch is one undo entry. |

**P1 is done when** a hand-written mutation of the graph object — add a layer,
retarget a parent, change an effect parameter, delete a layer — reaches AE
correctly, atomically, and inside the S2 latency budget, with drift detected.

**P1 is done.** Add, reparent, change and delete each reach the comp in one patch
and one undo entry, proved end to end offline against the real reader and writer,
and every assumption underneath verified inside After Effects (34/34 for the
reader and writer, 25/25 for the guard and the loop). Effect parameters are the
one item deferred: `setEffect` is refused with a sentence rather than
half-implemented, and belongs to M2's node set.

**Current focus: finish and verify the P2 panel integration.**

### M1 — the canvas (implemented)

**The canvas is transplanted, not the codebase.** ExtendBlueNode compiles a DAG
*into* ExtendScript; here the graph *is* the comp. Its exec/data port semantics,
its node library and its Monaco mirror are the wrong abstraction for this — as
the MVP's exclusion of its 1,566 auto-generated DOM nodes already said. What
transplants is React Flow itself, the visual language, and the CEP plumbing.

**A build step arrives, deliberately.** `cep-spike/` is static HTML on purpose —
a spike with a build step measures the build step too. A node canvas is not a
spike, so `panel/` is Vite + React + React Flow. The reconciler is imported from
`src/`, never copied: two copies of `graph.js` would be two definitions of what a
node is.

**The direction of authority is fixed.** `src/view.js` is the only file that
knows both models, and it is pure — no React, no reactflow import, no DOM, so it
is tested offline with everything else. React Flow renders the graph and owns
nothing; a canvas gesture is a mutation of the graph, or it is nothing.

**Node positions live in the model** (`node.ui`), not in the panel. The diff never
reads them, so moving a node cannot emit a patch — but M6 has to persist them,
and a graph that reopened with every node stacked at the origin would have lost
the arrangement the user spent longest on.

**A drag is one gesture, on the canvas as in AE.** React Flow holds the position
while the pointer is down; the model learns the final one at drag stop. P1.5's
rule, applied one layer up.

**Three failures worth recording**, all found by driving the real panel rather
than by reading it:

- `overflow: hidden` on a node card **clips its ports** — a handle sits astride
  the card's edge, and the half that gets clipped is the half the pointer lands
  on, so every attempt to draw a wire drags the node instead.
- Re-deriving the canvas from the model on **every pointer move** made the whole
  CEP panel flicker: each move rebuilt every node and edge object with a new
  identity, so every card re-rendered, sixty times a second. Pan and zoom never
  flickered, because React Flow owns the viewport and React is not in that path —
  which is the observation that named the bug.
- React Flow **discards an edge whose handle does not exist, in silence**. The
  wire landed in the model and never appeared, because an edge's source is stored
  the way After Effects addresses it (`.transform.position`, what goes into the
  expression body) and a port is named after the property alone. `view.js` now
  translates; a test asserts every wire lands on a port that is actually there,
  and it fails against the old code.

**Still owed before product use:** editing constant values in node cards,
React/CEP integration tests, and a manual pass showing every panel action reaches
After Effects. The panel has run docked in AE, but build/load success alone does
not verify its interaction wiring.

---

## P2 — MVP

The narrowest version that a real person could use for a real shot.

The active execution order and acceptance gates are maintained in
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md). That plan resolves the open
M3/M4 integration and safety work before continuing through M5 and M6.

**Scope.** Wall 4 option (a): **the graph owns structure, After Effects keeps
time.** Keyframes stay native keyframes on generated layers. The graph is an
improvement on the layer stack; it does not yet replace the curve editor.

| | Step | Owes |
|---|---|---|
| M1 | Canvas transplant from ExtendBlueNode, into the CEP panel | **DONE** — `panel/`. React Flow over the P1 graph model, `src/view.js` translating between them (pure, 23 tests). Confirmed docked in AE. |
| M2 | Node set: Source, Transform, Effect, Composite, **Relationship** (expressions as edges, per S6) | **DONE** — see `docs/M2.md`. Generic effects by matchName; blend mode as the composite node; AE label colours on cards. |
| M3 | Reconciler wired to the canvas, debounced. Effect chaining & Expression nodes. | **CORE DONE; PANEL REPAIR/VERIFICATION OPEN** — see `docs/M3.md`. |
| M4 | Durable identity per S3: comment anchor + cached native id | **IMPLEMENTED; MANUAL AE PASS OPEN** — creation receipts, duplicate cleanup, rebind, and startup hydration exist; persistence remains lossy. See `docs/M4.md`. |
| M5 | Drift UX + capture-where-constant | **NOT DONE.** An outliner (visibility, labels, managed-layer order) was added, but it does not satisfy this milestone's drift-resolution and constant-capture outcome. |
| M6 | Persistence: `.ntl`, schema-versioned | save, reload, reconcile against the existing comp without rebuilding |
| M7 | One real shot, start to finish | the honest verdict on whether this beats the timeline |

**M7 is the real gate.** Everything before it is machinery.

### Not in the MVP

Named here so they stop creeping in: time remap, nested comps, 3D, masks,
our own renderer or viewport, round-tripping a hand-built
comp into a graph, and the 1,566 auto-generated AE DOM nodes from
ExtendBlueNode (wrong abstraction — see `PLAN.md`).

---

## Open questions, parked

- ~~Does `evalScript` from a panel clear the bar?~~ **Settled: yes, 1.2 ms floor.**
  A native AEGP is not needed for the transport, and the port is well-understood work
  (the physics sim measured native apply at 131 µs/key, 28.6× ExtendScript).
- What is the generated comp called, and how does the user know not to touch it?
- Does a node map to one layer, or can one node emit several?
