// P1.4 / P1.5 in-AE conformance pass.
//
// jsx/p1-check.jsx asked whether After Effects behaves like the fake for the
// reader and the writer. This one asks the two questions the drift guard and the
// coalesced write loop rest on, and which no offline test can reach:
//
//   1. does app.project.revision move when and only when we assume? The guard's
//      cheap tier is worth nothing if a property edit leaves the revision alone
//      (drift we would never notice), and the expensive tier exists precisely
//      because the revision is PROJECT-wide - an edit in another comp moves it.
//   2. is one patch really one undo entry, at fifteen ops rather than two? S5
//      measured the stack at 99 entries; P1.5 spends one per gesture on that
//      basis, so the claim is tested at the size a gesture actually is.
//
// Run it from After Effects: File > Scripts > Run Script File...
// It builds its own two comps, works only inside them, and deletes them at the
// end. It touches nothing of yours - but save your project first anyway.
//
// ES3 only. No regex literals containing backslashes; prefer split/join.

#include "common.jsx"
#include "reader.jsx"
#include "patch.jsx"

// ---------------------------------------------------------------- harness

var NTLB = { checks: [] };

function ntlbCheck(name, expected, got, note) {
    var pass = String(expected) === String(got);
    NTLB.checks.push({ name: name, expected: String(expected), got: String(got),
                       pass: pass, note: note || '' });
    return pass;
}

// Some of what this pass wants to know has no pass condition fixed in advance -
// whether selecting a layer moves the revision, for instance. Those are recorded
// as OBSERVATIONS. A check whose expected value was decided after seeing the
// result would be decoration, and this project has been bitten by its own
// instruments often enough to keep the two apart.
function ntlbObserve(results, name, value, note) {
    results.observations.push({ name: name, value: String(value), note: note || '' });
}

// Did app.project.revision move across fn()? Returns 'moved' or 'did not move',
// which is what ntlbCheck compares, so a failure reads as a sentence.
function ntlbMoves(fn) {
    var before = app.project.revision;
    fn();
    return app.project.revision > before ? 'moved' : 'did not move';
}

// --------------------------------------------------------------- the comps

var NTLB_COMP = 'NTL P1b Check';
var NTLB_OTHER = 'NTL P1b Elsewhere';

function ntlbRemoveOld() {
    // A comp left behind by a crashed run would be found by name FIRST and
    // quietly tested instead of the fresh one.
    for (var i = app.project.numItems; i >= 1; i--) {
        var it = app.project.item(i);
        if (it instanceof CompItem && (it.name === NTLB_COMP || it.name === NTLB_OTHER)) {
            it.remove();
        }
    }
}

function ntlbBuild() {
    var comp = app.project.items.addComp(NTLB_COMP, 1920, 1080, 1, 10, 24);
    comp.openInViewer();

    // Three layers we own, plus one of the user's that must never be touched.
    var names = ['One', 'Two', 'Three'];
    var tags = ['n1', 'n2', 'n3'];
    for (var i = 0; i < 3; i++) {
        var l = comp.layers.addSolid([0.2, 0.4, 0.9], names[i], 400, 400, 1);
        l.comment = ntlrTagFor(tags[i]);
    }
    var mine = comp.layers.addSolid([0.1, 0.1, 0.1], 'THE USER LAYER', 400, 400, 1);
    mine.comment = 'notes about this layer';

    // A second comp, so "an edit somewhere else in the project" can be tested.
    // This is the case the digest tier exists for: the revision will move, and
    // the comp under reconciliation will not have changed at all.
    var other = app.project.items.addComp(NTLB_OTHER, 320, 240, 1, 2, 24);
    other.layers.addSolid([0.5, 0.5, 0.5], 'Elsewhere', 320, 240, 1);

    return { comp: comp, other: other };
}

function ntlbByTag(comp, tag) {
    return ntlrScanTags(comp).byTag[tag];
}

function ntlbOpacity(comp, tag) {
    return ntlbByTag(comp, tag).property('ADBE Transform Group').property('ADBE Opacity').value;
}

// ---------------------------------------------------------------- the pass

function ntlbRun() {
    var results = { when: new Date().toUTCString(), aeVersion: app.version,
                    checks: [], observations: [], timings: {} };

    app.beginUndoGroup('NTL P1b - setup');
    ntlbRemoveOld();
    var built = ntlbBuild();
    app.endUndoGroup();

    var comp = built.comp;
    var other = built.other;
    var one = ntlbByTag(comp, 'n1');

    // ---- 1. what moves the revision -------------------------------------
    //
    // The guard's cheap tier is a claim about this and nothing else: if any of
    // these say "did not move", drift of that kind is invisible to us and the
    // guard would have to poll the full read instead.

    ntlbCheck('a property write moves the revision', 'moved', ntlbMoves(function () {
        app.beginUndoGroup('NTL P1b - property');
        one.property('ADBE Transform Group').property('ADBE Opacity').setValue(44);
        app.endUndoGroup();
    }));

    ntlbCheck('a rename moves the revision', 'moved', ntlbMoves(function () {
        app.beginUndoGroup('NTL P1b - rename');
        one.name = 'One Renamed';
        app.endUndoGroup();
    }));

    ntlbCheck('a comment write moves the revision', 'moved', ntlbMoves(function () {
        // The comment is our identity anchor (S3). A change to one that did not
        // move the revision would be a layer silently leaving or joining the
        // graph's ownership.
        app.beginUndoGroup('NTL P1b - comment');
        one.comment = ntlrTagFor('n1') + ' ';
        app.endUndoGroup();
    }));

    ntlbCheck('an expression write moves the revision', 'moved', ntlbMoves(function () {
        app.beginUndoGroup('NTL P1b - expression');
        ntlbByTag(comp, 'n2').property('ADBE Transform Group')
            .property('ADBE Position').expression = '// ntl:edge:probe\nvalue';
        app.endUndoGroup();
    }));

    ntlbCheck('a parent change moves the revision', 'moved', ntlbMoves(function () {
        app.beginUndoGroup('NTL P1b - parent');
        ntlbByTag(comp, 'n3').parent = ntlbByTag(comp, 'n1');
        app.endUndoGroup();
    }));

    ntlbCheck('creating a layer moves the revision', 'moved', ntlbMoves(function () {
        app.beginUndoGroup('NTL P1b - create');
        var t = comp.layers.addSolid([0.3, 0.3, 0.3], 'Temp', 100, 100, 1);
        t.comment = ntlrTagFor('tmp');
        app.endUndoGroup();
    }));

    ntlbCheck('deleting a layer moves the revision', 'moved', ntlbMoves(function () {
        app.beginUndoGroup('NTL P1b - delete');
        ntlbByTag(comp, 'tmp').remove();
        app.endUndoGroup();
    }));

    ntlbCheck('an undo moves the revision', 'moved', ntlbMoves(function () {
        // If undo did not move it, the user pressing Ctrl+Z would be invisible to
        // the guard - and P1 already proved a patch can follow an undo.
        app.executeCommand(16);
    }));

    // The one that justifies the second tier. The revision is PROJECT-wide, so
    // an edit in a comp we are not reconciling moves it while our comp has not
    // changed at all. If the guard reported that as drift it would stop the
    // reconciler every few seconds in ordinary use.
    ntlbCheck('an edit in ANOTHER comp still moves the revision', 'moved', ntlbMoves(function () {
        app.beginUndoGroup('NTL P1b - elsewhere');
        other.layer(1).property('ADBE Transform Group').property('ADBE Opacity').setValue(11);
        app.endUndoGroup();
    }), 'this is why a moved revision is not yet drift');

    // No pass condition was fixed for these in advance, so they are observations.
    // Either answer is survivable: a selection that moves the revision costs one
    // extra read and is then classified as spurious.
    ntlbObserve(results, 'selecting a layer', ntlbMoves(function () {
        comp.layer(1).selected = true;
    }), 'if it moves, the guard sees a spurious revision and adopts it');

    ntlbObserve(results, 'moving the time indicator', ntlbMoves(function () {
        comp.time = comp.time + comp.frameDuration;
    }));

    ntlbObserve(results, 'reading the revision twice with nothing in between',
        ntlbMoves(function () { /* deliberately nothing */ }),
        'must not move, or the gate would fire constantly');
    ntlbCheck('an idle gate does not move', 'did not move',
        ntlbMoves(function () { /* deliberately nothing */ }));

    // ---- 2. what a read costs, and whether it is stable ------------------

    var json1 = NTL_ReadComp(NTLB_COMP, false);
    var json2 = NTL_ReadComp(NTLB_COMP, false);
    // The digest is computed panel-side over exactly this text. If two reads of
    // an untouched comp differ - a float that does not round-trip, a key order
    // that varies - then every idle pass would digest differently and the guard
    // would report drift forever.
    ntlbCheck('two reads of an untouched comp are byte-identical', 'true',
              json1 === json2 ? 'true' : 'false',
              'the digest is only as stable as the read under it');

    var state = eval('(' + json1 + ')');
    ntlbCheck('the read reports no errors', 0, state.readErrors, state.firstError || '');
    ntlbCheck('the read found our three layers', 3, state.managedLayers);
    ntlbCheck("the read left the user's layer unmanaged", 1, state.untaggedLayers);
    results.timings.readMs = state.elapsedMs;
    // S4's premise: a full structural read fits inside one patch budget (400 ms,
    // S1), which is what makes tier 2 affordable at all.
    ntlbCheck('a full read costs less than one patch budget', 'true',
              state.elapsedMs < 400 ? 'true' : 'false', state.elapsedMs + ' ms');

    // The gate's own price, re-measured here rather than quoted from S4.
    var n = 2000;
    $.hiresTimer;
    var sink = 0;
    for (var g = 0; g < n; g++) sink += app.project.revision;
    results.timings.perRevisionReadUs = $.hiresTimer / n;
    results.timings.revisionSink = sink;   // so the loop cannot be optimised away
    ntlbCheck('the gate costs under 100 µs', 'true',
              results.timings.perRevisionReadUs < 100 ? 'true' : 'false',
              results.timings.perRevisionReadUs + ' µs');

    // ---- 3. one patch is one undo entry, at gesture size -----------------
    //
    // P1 proved it for two ops. A gesture is bigger than that, and the cost of
    // being wrong is the user's history: at 99 entries, a patch that cost one
    // entry per OP would evict everything inside a few drags.

    var ops = [];
    var props = ['opacity', 'rotation'];
    var tags = ['n1', 'n2', 'n3'];
    for (var t = 0; t < tags.length; t++) {
        for (var q = 0; q < props.length; q++) {
            ops.push({ op: 'setProp', node: tags[t], prop: props[q], to: 5 + t });
        }
        ops.push({ op: 'setName', node: tags[t], to: 'Patched ' + tags[t] });
    }
    ops.push({ op: 'setProp', node: 'n1', prop: 'scale', to: [50, 50] });
    ops.push({ op: 'setProp', node: 'n2', prop: 'scale', to: [60, 60] });
    ops.push({ op: 'setProp', node: 'n3', prop: 'scale', to: [70, 70] });

    var beforeOpacity = ntlbOpacity(comp, 'n1');
    var beforeName = ntlbByTag(comp, 'n3').name;

    var receiptText = NTL_ApplyPatch(NTLB_COMP, ops, 'NTL P1b - one gesture', -1);
    var receipt = eval('(' + receiptText + ')');
    results.gestureReceipt = receipt;
    ntlbCheck('a 12-op patch applies every op', ops.length, receipt.applied, receiptText);
    ntlbCheck('the patch wrote the last value', 70,
              ntlbByTag(comp, 'n3').property('ADBE Transform Group').property('ADBE Scale').value[0]);

    // ONE undo. If a patch cost one entry per op, this would put back only the
    // last one and the checks below would fail.
    app.executeCommand(16);
    ntlbCheck('ONE undo puts back the whole patch - value', beforeOpacity, ntlbOpacity(comp, 'n1'),
              'if this fails, a patch costs more than one of the 99 entries');
    ntlbCheck('ONE undo puts back the whole patch - name', beforeName, ntlbByTag(comp, 'n3').name);

    // ---- 4. the user's layer, after all of that --------------------------
    var theirs = null;
    for (var u = 1; u <= comp.numLayers; u++) {
        if (comp.layer(u).name === 'THE USER LAYER') theirs = comp.layer(u);
    }
    ntlbCheck("the user's layer is still there", 'true', theirs !== null ? 'true' : 'false');
    if (theirs) {
        ntlbCheck("the user's layer was never written to", 100,
                  theirs.property('ADBE Transform Group').property('ADBE Opacity').value);
        ntlbCheck("the user's comment was never rewritten", 'notes about this layer', theirs.comment);
    }

    // ---- the harness proves it can fail ----------------------------------
    // Five times in this project the instrument, not After Effects, was the
    // finding. A run of all-greens means nothing unless a red is reachable.
    ntlbCheck('CONTROL: a check that must fail', 'expected', 'deliberately wrong',
              'if this one says pass, the harness is broken and the run is void');

    results.checks = NTLB.checks;
    var passed = 0, failed = 0, control = null;
    for (var c = 0; c < NTLB.checks.length; c++) {
        var chk = NTLB.checks[c];
        if (chk.name === 'CONTROL: a check that must fail') { control = chk; continue; }
        if (chk.pass) passed++; else failed++;
    }
    results.passed = passed;
    results.failed = failed;
    results.harnessValid = (control !== null && control.pass === false);
    results.verdict = !results.harnessValid ? 'VOID - the harness cannot fail'
                    : (failed === 0 ? 'PASS' : 'FAIL - ' + failed + ' check(s)');

    app.beginUndoGroup('NTL P1b - cleanup');
    try {
        comp.remove();
        other.remove();
    } catch (e) {
        results.cleanup = String(e && (e.message || e));
    }
    app.endUndoGroup();

    return results;
}

// ------------------------------------------------------------------ run it

(function () {
    if (typeof ntlrTagFor !== 'function' ||
        typeof NTL_ReadComp !== 'function' ||
        typeof NTL_ApplyPatch !== 'function' ||
        typeof NTL_Revision !== 'function') {
        alert('The includes did not load.\n\n' +
              'common.jsx, reader.jsx and patch.jsx must sit in the same folder ' +
              'as this script.');
        return;
    }

    var results;
    try {
        results = ntlbRun();
    } catch (e) {
        results = { verdict: 'CRASHED', message: String(e && (e.message || e)),
                    line: e && e.line, checks: NTLB.checks };
        try { app.endUndoGroup(); } catch (e2) { /* nothing further to do */ }
    }

    var out = new File(Folder.temp.fsName + '/ntl-p1b-results.json');
    out.encoding = 'UTF-8';
    out.open('w');
    out.write(ntlrVal(results));
    out.close();

    var tally = (results.verdict === 'CRASHED')
        ? (results.message + '\nline ' + results.line +
           '\n(' + NTLB.checks.length + ' checks had run)')
        : ('passed ' + results.passed + ', failed ' + results.failed);

    alert('Node Timeline - P1.4 / P1.5 in-AE check\n\n' +
          results.verdict + '\n' + tally + '\n\n' +
          'Results written to:\n' + out.fsName);
})();
