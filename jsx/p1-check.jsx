// P1 in-AE conformance pass.
//
// Everything in P1 was proved offline against a fake After Effects. This file
// asks the only question that could not be asked there: DOES AFTER EFFECTS
// BEHAVE LIKE THE FAKE? Every check below corresponds to an assumption baked
// into test/fake-ae.js or into the reader/writer themselves.
//
// Run it from After Effects: File > Scripts > Run Script File...
// It builds its own comp, works only inside it, and deletes it at the end.
// Results are written to a JSON file and the path is shown in an alert.
//
// It uses Undo three times, each immediately after one of its own writes, to
// check that a patch costs ONE undo entry. It touches nothing of yours - but
// save your project first anyway.

// The three files under test, spliced in at PARSE time.
//
// The first run of this check crashed with "Function ntlrTagFor is undefined"
// after loading the same three files with $.evalFile - the files evaluated
// (no missing-file alert fired) but their function declarations did not reach
// global scope. #include is the preprocessor directive and is not subject to
// that: the text is simply pasted in before anything runs. Paths resolve
// relative to this file.

#include "common.jsx"
#include "reader.jsx"
#include "patch.jsx"

// ---------------------------------------------------------------- harness

var NTLC = {
    checks: [],
    started: 0
};

function ntlcCheck(name, expected, got, note) {
    var pass = String(expected) === String(got);
    NTLC.checks.push({
        name: name,
        expected: String(expected),
        got: String(got),
        pass: pass,
        note: note || ''
    });
    return pass;
}

function ntlcThrows(name, fn, expectThrow) {
    var threw = false;
    var message = '';
    try {
        fn();
    } catch (e) {
        threw = true;
        message = String(e && (e.message || e));
    }
    return ntlcCheck(name, expectThrow ? 'throws' : 'does not throw',
                     threw ? 'throws' : 'does not throw', message);
}

// ---------------------------------------------------------------- the comp

var NTLC_COMP = 'NTL P1 Check';

function ntlcBuild() {
    // Clear out any comp left behind by an earlier run. The reader and the
    // writer both find comps BY NAME, so a leftover from a crashed run would be
    // found first and quietly tested instead of the fresh one - the same class
    // of bug as the stale project that crashed the S3 cost pass.
    for (var i = app.project.numItems; i >= 1; i--) {
        var it = app.project.item(i);
        if (it instanceof CompItem && it.name === NTLC_COMP) it.remove();
    }

    var comp = app.project.items.addComp(NTLC_COMP, 1920, 1080, 1, 10, 24);
    comp.openInViewer();

    var a = comp.layers.addSolid([0.2, 0.4, 0.9], 'Source', 400, 400, 1);
    a.comment = ntlrTagFor('a');

    var b = comp.layers.addSolid([0.9, 0.4, 0.2], 'OldName', 400, 400, 1);
    b.comment = ntlrTagFor('b');

    // One layer the graph must never touch, and one that looks like ours but
    // is not - a comment that merely starts with something similar.
    var mine = comp.layers.addSolid([0.1, 0.1, 0.1], 'THE USER LAYER', 400, 400, 1);
    mine.comment = 'notes about this layer';

    // A keyframed property: S6 says After Effects keeps keyframes, and the
    // writer is supposed to refuse rather than clobber one.
    var k = comp.layers.addSolid([0.5, 0.5, 0.5], 'Keyed', 400, 400, 1);
    k.comment = ntlrTagFor('k');
    var op = k.property('ADBE Transform Group').property('ADBE Opacity');
    op.setValueAtTime(0, 100);
    op.setValueAtTime(1, 0);

    return comp;
}

// ---------------------------------------------------------------- the checks

function ntlcRun() {
    var results = { when: new Date().toUTCString(), aeVersion: app.version, checks: [], timings: {} };

    app.beginUndoGroup('NTL P1 check — setup');
    var comp = ntlcBuild();
    app.endUndoGroup();

    var a = comp.layer('Source');
    var b = comp.layer('OldName');

    // ---- 1. identity, as S3 described it ---------------------------------
    var idBefore = a.id;
    app.beginUndoGroup('NTL P1 check — rename');
    a.name = 'Source Renamed';
    app.endUndoGroup();
    ntlcCheck('layer.id survives a rename', idBefore, a.id);
    ntlcCheck('layer.comment survives a rename', ntlrTagFor('a'), a.comment);

    app.beginUndoGroup('NTL P1 check — reorder');
    a.moveToEnd();
    app.endUndoGroup();
    ntlcCheck('layer.id survives a reorder', idBefore, a.id);
    a.name = 'Source';

    // ---- 2. the revision gate, S4 ----------------------------------------
    var rev0 = app.project.revision;
    app.beginUndoGroup('NTL P1 check — a write');
    b.property('ADBE Transform Group').property('ADBE Opacity').setValue(99);
    app.endUndoGroup();
    ntlcCheck('app.project.revision moves on a write', 'moved',
              app.project.revision > rev0 ? 'moved' : 'did not move',
              'before ' + rev0 + ', after ' + app.project.revision);

    // ---- 3. a keyframed property really does refuse a value --------------
    // The fake asserts this; the writer guards for it. If AE does NOT throw,
    // the guard is still right (S6) but the fake is modelling a fiction.
    var keyed = comp.layer('Keyed').property('ADBE Transform Group').property('ADBE Opacity');
    ntlcCheck('a keyframed property reports numKeys', 2, keyed.numKeys);
    app.beginUndoGroup('NTL P1 check — keyframed write');
    ntlcThrows('setValue on a keyframed property throws', function () {
        keyed.setValue(50);
    }, true);
    app.endUndoGroup();

    // ---- 4. expressions round-trip ---------------------------------------
    var pos = b.property('ADBE Transform Group').property('ADBE Position');
    var text = '// ntl:edge:e1\nthisComp.layer("Source").transform.position';
    app.beginUndoGroup('NTL P1 check — expression');
    pos.expression = text;
    app.endUndoGroup();
    ntlcCheck('an expression round-trips exactly', text, pos.expression);
    ntlcCheck('expressionEnabled is true once set', 'true', String(pos.expressionEnabled));
    ntlcCheck('the tag survives the round trip, so ownership is detectable',
              'true', String(ntlrOwnsExpression(pos.expression)));
    app.beginUndoGroup('NTL P1 check — clear expression');
    pos.expression = '';
    app.endUndoGroup();
    ntlcCheck('clearing an expression disables it', 'false', String(pos.expressionEnabled));

    // ---- 5. the reader, against a real comp ------------------------------
    $.hiresTimer;
    var stateJson = NTL_ReadComp(NTLC_COMP, false);
    results.timings.readRoundTripMs = $.hiresTimer / 1000;
    results.readerSample = stateJson.length > 4000 ? stateJson.slice(0, 4000) + '...(truncated)' : stateJson;

    // Read it back through the same emitter the panel would parse.
    ntlcCheck('the reader reports ok', 'true',
              stateJson.indexOf('"ok":true') !== -1 ? 'true' : 'false');
    // Three tagged (a, b, k) and one of the user's, four layers in all. The
    // first run expected four tagged: the reader was right and the harness was
    // wrong, which is the third time in this project that has been the answer.
    ntlcCheck('the reader found our three tagged layers', 'true',
              stateJson.indexOf('"managedLayers":3') !== -1 ? 'true' : 'false',
              'looking for managedLayers:3');
    ntlcCheck('tagged plus untagged accounts for every layer', 'true',
              stateJson.indexOf('"layerCount":4') !== -1 ? 'true' : 'false');
    ntlcCheck('the reader found the untagged layer and left it alone', 'true',
              stateJson.indexOf('"untaggedLayers":1') !== -1 ? 'true' : 'false');
    ntlcCheck('the reader reported no read errors', 'true',
              stateJson.indexOf('"readErrors":0') !== -1 ? 'true' : 'false');

    // ---- 6. one patch is ONE undo entry, S5 ------------------------------
    //
    // The strongest check here. Ten writes go in under one group; a single
    // Undo must revert all ten. If a patch cost one entry per write, nine
    // would survive - and the 99-entry stack would be gone in two seconds of
    // dragging.
    var ops = [];
    for (var i = 0; i < 10; i++) {
        ops.push({ op: 'setProp', node: 'a', prop: 'opacity', to: 10 + i });
    }
    // Read FRESH every time, by re-resolving from the comp the way the writer
    // does. The first run read everything through one handle cached before any
    // undo, and three checks disagreed with the receipts - so every read here
    // is taken both ways at the same moment, and the two are compared.
    var opacityA = a.property('ADBE Transform Group').property('ADBE Opacity');

    function ntlcFresh(tag) {
        var scan = ntlrScanTags(comp);
        var l = scan.byTag[tag];
        if (l === undefined) return null;
        return l.property('ADBE Transform Group').property('ADBE Opacity').value;
    }

    // Every step records what the cached handle says, what a fresh lookup says,
    // and where the project revision stands. If those ever disagree, the trace
    // says so outright instead of leaving it to be inferred from a failed check.
    results.undoTrace = [];
    function ntlcTrace(step) {
        var cached = null;
        try { cached = opacityA.value; } catch (e) { cached = 'THREW: ' + String(e && (e.message || e)); }
        var fresh = ntlcFresh('a');
        results.undoTrace.push({
            step: step,
            cached: String(cached),
            fresh: String(fresh),
            agree: String(cached) === String(fresh),
            revision: app.project.revision,
            layerName: a.name
        });
        return fresh;
    }

    var beforePatch = ntlcTrace('before the patch');

    $.hiresTimer;
    var receipt = NTL_ApplyPatch(NTLC_COMP, ops, 'NTL P1 check — patch', app.project.revision);
    results.timings.patchRoundTripMs = $.hiresTimer / 1000;
    results.receipt = receipt;

    ntlcCheck('the patch reports ok', 'true',
              receipt.indexOf('"ok":true') !== -1 ? 'true' : 'false');
    ntlcCheck('the patch applied every op', 'true',
              receipt.indexOf('"applied":10') !== -1 ? 'true' : 'false');
    ntlcCheck('the comp holds the patched value', 19, ntlcTrace('after the patch'));

    // ---- 6b. does Undo work AT ALL, and does it work TWICE? --------------
    //
    // The control is run FIRST and on its own, before the patch is undone. On
    // the first run it was placed after the patch undo and failed, which left
    // three possible causes tangled together: a stale cached handle, the wrong
    // command id, or a second consecutive undo not firing. Order alone
    // separates the last of those.
    //
    // app.executeCommand(16) is Undo. S5: findMenuCommandId('Undo') returns an
    // id that undoes NOTHING - that VOIDed an entire spike run once.
    app.beginUndoGroup('NTL P1 check — undo control');
    var freshLayer = ntlrScanTags(comp).byTag['a'];
    freshLayer.property('ADBE Transform Group').property('ADBE Opacity').setValue(7);
    app.endUndoGroup();
    var controlSet = ntlcTrace('control write of 7');
    ntlcCheck('CONTROL part 1: a plain write lands', 7, controlSet);

    app.executeCommand(16);
    var controlUndone = ntlcTrace('after undo #1 (the control write)');
    ntlcCheck('CONTROL part 2: undo actually undoes', 'true',
              String(controlUndone) !== '7' ? 'true' : 'false',
              'command id 16; if this fails, every undo result below is meaningless');

    // Only now undo the patch - the SECOND consecutive undo of this run.
    app.executeCommand(16);
    var afterPatchUndo = ntlcTrace('after undo #2 (the patch)');
    ntlcCheck('ONE undo reverts the WHOLE patch', beforePatch, afterPatchUndo,
              'ten writes, one undo entry - and the second undo in a row');

    // ---- 6c. a write IMMEDIATELY after an undo ---------------------------
    //
    // Run 2 reordered the undo checks and passed clean - which retired the
    // stale-handle theory but also stopped exercising the one sequence that
    // actually failed in run 1: an undo, then a write, then an undo of THAT
    // write. Fixing a harness by no longer performing the failing sequence
    // proves nothing, so the sequence is put back here on purpose.
    //
    // It is not academic. It is exactly what production does: the user presses
    // Ctrl+Z, and the panel patches again on the next gesture.
    app.beginUndoGroup('NTL P1 check — post-undo write');
    ntlrScanTags(comp).byTag['a'].property('ADBE Transform Group')
        .property('ADBE Opacity').setValue(33);
    app.endUndoGroup();
    ntlcCheck('a write lands immediately after an undo', 33,
              ntlcTrace('write of 33, straight after two undos'));

    app.executeCommand(16);
    var afterThird = ntlcTrace('after undo #3 (the post-undo write)');
    ntlcCheck('undo still works after an undo-then-write sequence', 'true',
              String(afterThird) !== '33' ? 'true' : 'false',
              'this is the sequence that failed in run 1');

    // And a patch after all that, since the reconciler will be doing exactly
    // this: the graph re-asserts itself after the user has undone something.
    var afterUndoPatch = NTL_ApplyPatch(NTLC_COMP,
        [{ op: 'setProp', node: 'a', prop: 'opacity', to: 61 }],
        'NTL P1 check — patch after undo', app.project.revision);
    results.postUndoPatchReceipt = afterUndoPatch;
    ntlcCheck('a patch applies normally after an undo', 61,
              ntlcTrace('after the post-undo patch'));

    // ---- 6d. the last difference between run 1 and runs 2-3 --------------
    //
    // Runs 2 and 3 read through cached handles freely and never disagreed with
    // a fresh lookup - but every WRITE in them goes through a fresh scan. Run 1
    // did one thing neither repeats: it WROTE through a property handle cached
    // before an undo, and that write is where it failed.
    //
    // Recorded as an observation rather than a check. If After Effects really
    // does drop such a write, that is a fact about AE, not a defect in the
    // reconciler - the writer re-resolves by scanning on every patch, so
    // production never does this. A red check here would mislead.
    app.beginUndoGroup('NTL P1 check — cached-handle write');
    var cachedWriteThrew = '';
    try {
        opacityA.setValue(77);
    } catch (e) {
        cachedWriteThrew = String(e && (e.message || e));
    }
    app.endUndoGroup();
    var afterCachedWrite = ntlcFresh('a');
    app.executeCommand(16);

    results.cachedHandleWrite = {
        note: 'run 1 wrote through a handle cached across an undo, and failed there',
        threw: cachedWriteThrew,
        landed: String(afterCachedWrite) === '77',
        freshAfterWrite: String(afterCachedWrite),
        freshAfterUndo: String(ntlcFresh('a'))
    };

    // ---- 7. the stale guard fires ----------------------------------------
    var stale = NTL_ApplyPatch(NTLC_COMP,
        [{ op: 'setProp', node: 'a', prop: 'opacity', to: 3 }],
        'NTL P1 check — stale', app.project.revision - 1);
    ntlcCheck('a stale patch is refused', 'true',
              stale.indexOf('"stale":true') !== -1 ? 'true' : 'false');
    ntlcCheck('a refused patch wrote nothing', 'true',
              String(ntlcTrace('after the refused patch')) !== '3' ? 'true' : 'false');

    // ---- 8. rollback by inverse ------------------------------------------
    var was = ntlcTrace('before the two-op patch');
    var r2 = NTL_ApplyPatch(NTLC_COMP,
        [{ op: 'setProp', node: 'a', prop: 'opacity', to: 55 },
         { op: 'setName', node: 'b', to: 'Renamed By Patch' }],
        'NTL P1 check — for rollback', -1);
    results.twoOpReceipt = r2;

    // Split into two checks. The first run tested both halves in one boolean,
    // so a failure could not say WHICH half failed - and the receipt said the
    // patch had applied both.
    ntlcCheck('the two-op patch wrote the value', 55, ntlcTrace('after the two-op patch'));
    ntlcCheck('the two-op patch wrote the name', 'Renamed By Patch',
              ntlrScanTags(comp).byTag['b'].name,
              'read fresh; the cached reference says "' + b.name + '"');

    // The receipt carries the inverse. Re-applying it is the rollback: a script
    // cannot reliably undo its own patch.
    var inv = [{ op: 'setName', node: 'b', to: 'OldName' },
               { op: 'setProp', node: 'a', prop: 'opacity', to: was }];
    NTL_ApplyPatch(NTLC_COMP, inv, 'NTL P1 check — rollback', -1);
    ntlcCheck('re-applying the inverse restores the value', was,
              ntlcTrace('after the rollback'));
    ntlcCheck('re-applying the inverse restores the name', 'OldName',
              ntlrScanTags(comp).byTag['b'].name);

    // Whether a cached layer/property reference still reads true after all of
    // the above. Not a pass/fail - a fact the reconciler needs either way,
    // since it decides whether handles may be held across a patch at all.
    var disagreements = 0;
    for (var d = 0; d < results.undoTrace.length; d++) {
        if (!results.undoTrace[d].agree) disagreements++;
    }
    results.cachedHandleDisagreements = disagreements;
    ntlcCheck('a cached property handle agrees with a fresh lookup throughout',
              0, disagreements,
              'if this fails, handles must be re-resolved after every patch');

    // ---- 9. the writer refuses what it promised to refuse ----------------
    var kBad = NTL_ApplyPatch(NTLC_COMP,
        [{ op: 'setProp', node: 'k', prop: 'opacity', to: 50 }],
        'NTL P1 check — keyframed', -1);
    ntlcCheck('the writer refuses a keyframed property', 'true',
              kBad.indexOf('is keyframed') !== -1 ? 'true' : 'false', kBad);

    var unknown = NTL_ApplyPatch(NTLC_COMP,
        [{ op: 'setProp', node: 'nobody', prop: 'opacity', to: 1 }],
        'NTL P1 check — missing', -1);
    ntlcCheck('the writer refuses an unknown tag', 'true',
              unknown.indexOf('no layer carries the tag') !== -1 ? 'true' : 'false');

    // ---- 10. the prices, re-measured here --------------------------------
    var n = 50;
    var tprop = a.property('ADBE Transform Group').property('ADBE Opacity');
    app.beginUndoGroup('NTL P1 check — write cost');
    $.hiresTimer;
    for (var w = 0; w < n; w++) tprop.setValue(50 + (w % 10));
    results.timings.perWriteUs = ($.hiresTimer) / n;
    app.endUndoGroup();
    app.executeCommand(16);

    $.hiresTimer;
    var scan = ntlrScanTags(comp);
    results.timings.scanMs = $.hiresTimer / 1000;
    ntlcCheck('the scan found every tagged layer', 3, (function () {
        var c = 0;
        for (var key in scan.byTag) { if (scan.byTag.hasOwnProperty(key)) c++; }
        return c;
    })());

    $.hiresTimer;
    for (var q = 0; q < 10; q++) app.project.layerByID(idBefore);
    results.timings.perLayerByIdUs = ($.hiresTimer) / 10;

    // ---- the harness proves it can fail ----------------------------------
    // Three-plus times in this project the instrument, not After Effects, was
    // the finding. A run of all-greens means nothing unless a red is reachable.
    ntlcCheck('CONTROL: a check that must fail', 'expected', 'deliberately wrong',
              'if this one says pass, the harness is broken and the run is void');

    results.checks = NTLC.checks;
    var passed = 0, failed = 0, control = null;
    for (var c2 = 0; c2 < NTLC.checks.length; c2++) {
        var chk = NTLC.checks[c2];
        if (chk.name === 'CONTROL: a check that must fail') { control = chk; continue; }
        if (chk.pass) passed++; else failed++;
    }
    results.passed = passed;
    results.failed = failed;
    results.harnessValid = (control !== null && control.pass === false);
    results.verdict = !results.harnessValid ? 'VOID — the harness cannot fail'
                    : (failed === 0 ? 'PASS' : 'FAIL — ' + failed + ' check(s)');

    // ---- cleanup ---------------------------------------------------------
    app.beginUndoGroup('NTL P1 check — cleanup');
    try { comp.remove(); } catch (e) { results.cleanup = String(e && (e.message || e)); }
    app.endUndoGroup();

    return results;
}

// ------------------------------------------------------------------ run it

(function () {
    // The includes above must have brought in one function from each file.
    // Checked by name rather than assumed: the previous version failed exactly
    // here, and reported it as a crash 90 lines later.
    if (typeof ntlrTagFor !== 'function' ||
        typeof NTL_ReadComp !== 'function' ||
        typeof NTL_ApplyPatch !== 'function') {
        alert('The includes did not load.\n\n' +
              'common.jsx, reader.jsx and patch.jsx must sit in the same folder ' +
              'as this script.');
        return;
    }

    var results;
    try {
        results = ntlcRun();
    } catch (e) {
        results = { verdict: 'CRASHED', message: String(e && (e.message || e)),
                    line: e && e.line, checks: NTLC.checks };
        try { app.endUndoGroup(); } catch (e2) { /* nothing further to do */ }
    }

    var out = new File(Folder.temp.fsName + '/ntl-p1-results.json');
    out.encoding = 'UTF-8';
    out.open('w');
    out.write(ntlrVal(results));
    out.close();

    var tally = (results.verdict === 'CRASHED')
        ? (results.message + '\nline ' + results.line +
           '\n(' + NTLC.checks.length + ' checks had run)')
        : ('passed ' + results.passed + ', failed ' + results.failed);

    alert('Node Timeline — P1 in-AE check\n\n' +
          results.verdict + '\n' + tally + '\n\n' +
          'Results written to:\n' + out.fsName);
})();
