# Node Timeline — the plan

**Working name.** Rename when it earns one.

**What it is.** A node graph that replaces After Effects' layered timeline as the
place you compose. The graph is the source of truth; After Effects holds a comp
derived from it, which the user never edits by hand. AE stays the renderer, so
every effect, every third-party plug-in and the render queue keep working.

Three documents, and they must not duplicate each other:

| | holds | read it when |
|---|---|---|
| **this file** | the reasoning: the premise, the walls, what is decided and why | deciding, or tempted to relitigate |
| `SPIKES.md` | the evidence: every measurement, and what each one does *not* cover | resuming, or doubting a number |
| `ROADMAP.md` | the sequence: status, gates, what each step owes | starting a work session |

If a fact appears here *and* in the roadmap, this file wins.

---

## The premise, stated so it can be falsified

> A graph edit reaches After Effects fast enough, and reliably enough, that the
> node view can be the place you work — not a generator you press a button in.

Two halves. The first is about speed and is **answered** (see below). The second
is about truth, and it is where the project actually lives or dies.

## Prior art

**Magic Nodes** — a node system for After Effects — already exists, so "a node
graph over AE" is not a question of possibility. It is now becoming
**IllusionFX**, a standalone compositor.

*Why did a working AE node system leave AE?* **Answered: ambition.** The new
model is a whole compositing application rather than a set of After Effects
workarounds — outgrowing the host, not retreating from it. No locked door, and
the gate is green.

What that does not license is treating the AE ceiling as imaginary. Someone with
a working product still judged the host's constraints worth leaving behind, and
the walls below are our version of those constraints. The mitigation is already
the plan: Wall 4 option (a), where the graph owns structure and After Effects
keeps time — precisely the scope that avoids the workarounds IllusionFX outgrew.
Revisit this if we ever reach for option (b).

## Architecture, decided

Considered three, chose the first:

| | Who makes the pixels | Verdict |
|---|---|---|
| **A. AE renders, graph drives it** | AE, from a comp the graph patches | **Chosen.** Keeps every effect and the render queue. Risk is sync. |
| B. Graph renders, AE hosts | our own evaluator in a C++ plug-in | Rejected for now. This is writing Nuke inside AE, and it throws away the reason to be in AE at all. |
| C. Graph commits on demand | AE, rebuilt on an explicit Bake | The fallback if A's live sync fails. Weaker product, guaranteed to work. |

A degrades gracefully into C. That is the main reason to start with A: a bad
latency result costs a button, not a rewrite.

## What the spikes settled

A 200-property patch lands in **107 ms**, of which **13 ms is AE** and the rest
is the ExtendScript socket transport. A clean diff — resolving and reading 200
properties and writing none — costs **6.8 ms**.

That last number was the one that could have killed the design outright, because
it is the cost a reconciler pays on *every* interaction frame, and it is a cost
native code would restructure rather than remove. It came in cheap.

Full numbers and caveats in `SPIKES.md`.

Then the shell moved to a dockable CEP panel, and the floor fell to **1.2 ms** —
a 50-property patch now lands in **9.9 ms**, well inside one frame at 60 fps. The
socket agent had been the entire bottleneck.

**Speed is not the wall.** It was simply the risk that could be measured in a
day, which is why it went first. It is now settled and cheap.

## The walls

### Wall 1 — structure is 125× value

Creating a layer costs **14.5 ms**. Writing a property costs **0.115 ms**.

> Layer identity must be durable. Map graph node → AE layer by a persistent id
> and patch that layer forever. Never rebuild.

A reconciler that recreates layers on graph change will feel broken. One that
keeps a stable pool and writes values will feel instant. Settled by measurement,
twice, over two transports, and not open for redesign.

**Worse: the cost grows with comp size.** Building a comp from 0→200 layers
averages 4.35 ms per layer; adding onto a comp that already holds ~200 costs
14.6–17.8 ms. Roughly linear at ~0.06 ms per existing layer, so a 500-layer comp
would pay ~30 ms per added layer. Structure is not just expensive — it gets
more expensive precisely in the big projects where a node system earns its keep.

**Settled by S3: the id lives in two places at once.**

| | role | why |
|---|---|---|
| `layer.comment` | the durable **anchor** | survives every operation tested, precompose and save/reload included; reads at 2.5 µs |
| `layer.id` (native) | the live **handle**, cached | unique, free, resolves project-wide — but **does not survive precompose** |

Neither works alone. The native id dies when a layer is precomposed; the comment
tag cannot distinguish an original from its duplicate. Together, duplicate
detection falls out for free: two layers sharing a comment tag, one still
carrying the native id the graph recorded — that one is the original, the other
is a copy and gets a new tag. Precompose is recoverable the same way: the handle
goes stale, the anchor is re-found, the handle is re-bound.

**Resolve by scanning, not by lookup.** `app.project.layerByID()` costs 71.5 µs
against 2.4 µs to read an id off a layer already in hand — 30×. Walking a
200-layer comp to build the map costs 0.48 ms; 200 lookups cost 14.3 ms, more
than twice the whole property diff. Lookup is for resolving *one* layer on
demand, never for bulk reconciliation.

The residual risk is not technical: `comment` is a visible, user-editable column,
so a user can clear it and orphan the layer. That is Wall 2 territory, and it is
where this will bite.

### Wall 1b — diff and apply are two phases

Measured: the same 200 property writes cost **130 µs each** inside one undo group
with properties resolved up front, and **294 µs each** when read and written
interleaved in a single loop with no undo group. **2.26× on the hot path.**

> Read everything and decide. Then write the whole patch inside a single
> `beginUndoGroup`, from properties resolved once and cached.

This costs nothing to adopt — it is the shape a reconciler wants anyway — and it
compounds with the atomic-undo requirement in Wall 3, which needs one undo group
per patch for correctness regardless.

### Wall 2 — truth only flows one way, and AE does not agree

If the graph is the source of truth, the comp is derived. But After Effects will
happily let the user drag a layer in the comp we generated, and **there is no
change-notification API** that tells us they did. Our options are all bad in
different ways:

- **Poll and diff the comp.** Costs a read pass; S4 prices it.
- **Lock the user out.** Guide/locked layers, or a loud "this comp is generated"
  convention. Honest, cheap, and unfriendly.
- **Accept drift** and reconcile on next patch, silently discarding their edit.

**S4 settled the detection half, and it is cheap.**

`app.project.revision` exists, increments on every operation, does not move when
nothing happens, and costs **2.3 µs** to read. That is a free gate: the snapshot
runs only when it has moved. A structural snapshot of a 200-layer comp then costs
**2.6 ms**, and comparing it to the previous one costs **1 µs** — hashing the
digest costs 4.5 ms and is simply dropped.

Crucially, **clearing a layer's comment is detected at the cheapest level**, so
the identity anchor being user-editable is a risk we can see coming.

What `revision` cannot say: *what* changed, or whether the change was ours. It
counts operations, so even rewriting an identical value ticks it. Hence:

> **The reconciler's diff and the drift snapshot are the same read.** Run one
> pass, not two. Re-baseline after every patch of ours.

**What remains is the product decision, not the detection.** When the user has
edited the generated comp, does the graph win, does the comp win, or are they
asked?

### Can the sync be two-way?

**Not symmetrically — but the architecture does not force pure one-way either.**

The obstacle is exact: `graph → comp` is **not injective**. Many different graphs
produce the same layers, so `comp → graph` has no unique inverse. You can always
recover *a* graph that yields those layers; never *the* graph that did. Full
round-tripping is therefore off the table for a real reason.

What is available is what node tools actually mean by two-way:

| | mechanism | status |
|---|---|---|
| **Layer-level ownership** | tagged layer = ours, untagged = the user's, never touched | **free** — S3 already provides it |
| **Property capture** | a detected user edit is written *back* into the owning node's input | works, with one hard boundary |
| **Structure** | the user adds or deletes layers in our comp | one-way; the graph is the only place structure can live |

The boundary on capture is sharp:

> An edit can be captured **only if the node input is a constant.** If that input
> is computed — wired from another node, an expression, a generator — the user's
> edit has nowhere to be stored, and something must give: reject the edit, or
> break the link.

That is not an After Effects limitation. Houdini, Cavalry and Blender's
modifiers all land on the same rule: a driven value cannot absorb a manual edit.

**One scope decision settles the rest.** While one node ≈ one layer — the Wall 4
option (a) MVP — capture is nearly always well defined and the system feels
two-way. The moment a node emits *many* layers procedurally, an edit to generated
layer 37 has no home, and those layers must be one-way. **Node semantics decide
the sync model, not the other way round.**

**Decision for the MVP:** capture-where-constant. Never touch untagged layers;
treat computed inputs as one-way with a visible "driven by node X" state; keep
structure one-way. There is then no global graph-wins-or-comp-wins rule to pick —
the answer is per property, and it falls out of whether that input is constant.

### Wall 3 — two undo stacks

Every patch writes into AE's undo stack. Ctrl+Z in After Effects will undo *our*
patch, leaving the comp behind the graph with nothing to tell us. Meanwhile the
graph has its own undo history.

The first spike showed one undo group per patch is both the correct shape and
**35% faster** than ungrouped writes. S5 confirmed it is also correct: **a patch
is exactly one undo entry and reverts as a unit**, so a user's Ctrl+Z can never
leave the comp in a state the graph never produced.

S5 also settled the detection half for free: **an undo moves
`app.project.revision`**, so the S4 gate already sees it. An undo is simply drift,
and needs no separate machinery.

**What is not settled is cadence.** Every patch sits on top of the user's
history, and After Effects keeps at most 99 undo levels. A reconciler writing one
patch per interaction frame would erase the user's entire undo history in under
two seconds of dragging — so:

> **Patches are coalesced into one undo group per gesture, written at the end of
> a drag.** Not one per frame.

That revises the cadence the earlier spikes assumed, though not the latency
argument: a sub-20 ms write is what makes an end-of-gesture patch feel immediate.

**The ceiling is measured: 99 entries.** 81 entries survive, 101 do not, and the
`revision` delta saturates at exactly +99 on every evicted run. At one patch per
frame, 60 fps fills the whole stack in **1.65 seconds**.

Worse than losing the history: exhausting the stack **strands the comp**. The
oldest patches stay applied because the undos run out before reaching them, so
the comp ends up in a state neither the graph nor the user authored.

The rule in its sharpest form, which follows from whose entries these are:

> An undo entry the user authored is correct — that is what undo is for. An entry
> they did not author is theft. **Write a patch when the user acts; never because
> a clock ticked.**

### Wall 4 — a graph is spatial, a timeline is temporal

This is the product question hiding inside the engineering one. A node graph
naturally expresses *structure*: this feeds that, this masks that. A timeline
expresses *time*: this value is 0 here and 100 there.

Two ways to resolve it, and the choice defines the product:

- **(a) Structure in the graph, time stays in AE.** Nodes describe what exists
  and how it composites; keyframes remain native AE keyframes on the generated
  layers. Cheap, preserves every AE animation workflow, and the graph is a
  genuine improvement on the layer stack without fighting the timeline.
- **(b) Time is an input to the graph.** Values are functions of time, the way
  Cavalry and Houdini do it. This is the real "replace the timeline" pitch, but
  it means baking curves into keyframes on every patch, and Wall 1 says baking
  is the expensive direction.

**(a) is the MVP** — and S6 measured nine of the owner's real comps to check it.
Median time:structure is **1.09:1**, seven of nine below the 3:1 line fixed in
advance, and both biases in the measurement run against structure. Option (a)
survives on the evidence, not on preference.

**But the census found a third category that outweighs the argument it was built
to settle.** Expressions were counted and deliberately scored on neither side:
there are **649 of them against 484 animated properties**, and in five of nine
comps they outnumber keyframed properties, by up to 5:1.

An expression says one value is a function of another. That is an edge. **This
work is already a dependency graph**, stored as several hundred invisible text
fields where it cannot be seen, traced or refactored. So the MVP's scope widens
by one category:

> **The graph owns structure and relationships. After Effects keeps keyframes.**

Keyframes stay in AE for two measured reasons beyond Wall 1's baking cost: much
of the volume is machine-generated (two Mocha tracking layers accounted for 72%
of one comp's 1,293 keyframes), and sequencing work inflates every time score
without being temporal complexity at all.

(b) — time as a graph input — remains a later argument, and possibly the thing
that makes a standalone renderer inevitable, which is the IllusionFX question
again.

## The shell, decided

**A dockable CEP panel inside After Effects**, not a standalone window.

ExtendBlueNode moved *out* of AE to a standalone Electron app, and for that
project it was right: an IDE that pushes scripts has no reason to live inside
the host. This project is the opposite — the node view replaces the timeline,
so it belongs where the timeline is, docked beside the comp viewer.

Two things follow, and both are gains:

- **The transport changes, rather than being tuned.** `CSInterface.evalScript`
  goes straight into the ExtendScript engine through the CEP host. No resident
  agent, no `Socket.poll()`, no `app.scheduleTask` interval — which is to say,
  none of the machinery whose floor S1 and S2 disagreed about. S2c measures what
  is left.
- **After Effects holds focus while the user works.** That was the concern
  behind S2b, and docking mostly dissolves it.

What we give up: ExtendBlueNode's Electron shell and socket bridge. The canvas,
compiler IR and persistence are unaffected — `src/cep.js` there is already a
single dispatcher with a working CEP path, which is the seam this reuses.

## What is not in scope

Not now, and saying so here to stop them creeping in:

- Our own renderer or viewport. AE's viewer is the preview.
- Expressions as a graph target. That is ExtendBlueNode's job and it already
  exists.
- Round-tripping an existing hand-built comp into a graph.
- Time remap, nested comps, 3D, masks. All MVP+1 at the earliest.

## What carries over from ExtendBlueNode

Reuse, not restart. From `_extendBlueNode`:

| Piece | Status |
|---|---|
| CEP panel path (`CSXS/manifest.xml`, `src/cep.js` dispatcher, install scripts) | **Take it.** This is the shipping transport now. |
| Electron shell + TCP socket + resident AE agent | **Leave it.** Superseded by the panel decision; kept only as spike instruments. |
| ReactFlow canvas, node aesthetic, add-node cascade, gestures | Take it. Product-agnostic. |
| Splittable Blender-style workspace, properties panel | Take it. |
| Schema-versioned `.ebn` persistence | Take the pattern, new schema. |
| Compiler IR + emitters | Take the shape, new backend. Emitting a *patch* is not emitting a *script*. |
| The 1,566 auto-generated AE DOM nodes | **Leave them.** Wrong abstraction here — this project's nodes are layers and effects, not DOM calls. |

The semantics do not carry over. ExtendBlueNode compiles a graph into one script
you run once. This compiles a graph into a *continuous reconciliation* against
live comp state. That is closer to a virtual DOM than to a compiler.
