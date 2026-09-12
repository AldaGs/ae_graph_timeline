// Node Timeline — CEP spike host.
//
// Everything the panel can ask After Effects to do. Each entry point returns a
// JSON *string*; CEP's evalScript can only hand back a string.
//
// In-AE timings use $.hiresTimer, which reports microseconds elapsed since the
// previous read - so reading it once is how you reset it.
//
// ES3 only. No regex literals containing backslashes (an unterminated regex is
// a parse error and After Effects is the only syntax check this file gets;
// prefer split/join).

var NTL_COMP = 'NTL Spike';

function ntlEscape(v) {
    var s = String(v);
    s = s.split('\\').join('\\\\');
    s = s.split('"').join('\\"');
    s = s.split('\r').join(' ');
    s = s.split('\n').join(' ');
    s = s.split('\t').join(' ');
    return s;
}

function ntlJson(obj) {
    var parts = [];
    for (var k in obj) {
        if (!obj.hasOwnProperty(k)) continue;
        var v = obj[k];
        if (v === undefined) continue;
        var out;
        if (v === null) out = 'null';
        else if (typeof v === 'number') out = isFinite(v) ? String(v) : '0';
        else if (typeof v === 'boolean') out = v ? 'true' : 'false';
        else out = '"' + ntlEscape(v) + '"';
        parts.push('"' + k + '":' + out);
    }
    return '{' + parts.join(',') + '}';
}

function ntlFail(err) {
    return ntlJson({ ok: false, message: String(err && (err.message || err)) });
}

// Guard every per-unit figure: ExtendScript raises "invalid numeric result
// (divide by zero?)" rather than yielding Infinity, which turns an empty comp
// into a crash instead of a readable result.
function ntlPer(total, n) {
    if (!n || n <= 0) return -1;
    return total / n;
}

function ntlFindComp() {
    var proj = app.project;
    for (var i = 1; i <= proj.numItems; i++) {
        var it = proj.item(i);
        if (it instanceof CompItem && it.name === NTL_COMP) return it;
    }
    return null;
}

function ntlOpacity(layer) {
    return layer.property('ADBE Transform Group').property('ADBE Opacity');
}

// ---------------------------------------------------------------- entry points

function NTL_info() {
    try {
        var comp = ntlFindComp();
        return ntlJson({
            ok: true,
            version: app.version,
            project: app.project.file ? app.project.file.name : '(unsaved)',
            comp: comp ? comp.name : '',
            layers: comp ? comp.numLayers : 0
        });
    } catch (e) { return ntlFail(e); }
}

// The floor: how long a round trip costs when AE does nothing at all.
function NTL_noop() {
    return '{"ok":true}';
}

function NTL_ensure(n) {
    try {
        var comp = ntlFindComp();
        if (comp === null) {
            comp = app.project.items.addComp(NTL_COMP, 1920, 1080, 1, 10, 24);
        }
        app.beginUndoGroup('NTL spike setup');
        while (comp.numLayers < n) {
            comp.layers.addSolid([0.2, 0.4, 0.9], 's' + (comp.numLayers + 1), 200, 200, 1);
        }
        app.endUndoGroup();
        comp.openInViewer();
        return ntlJson({ ok: true, layers: comp.numLayers });
    } catch (e) { return ntlFail(e); }
}

// n opacity writes inside one undo group - the shape the first spike found to be
// both correct and ~35% faster than ungrouped writes.
function NTL_patch(n, value) {
    try {
        var comp = ntlFindComp();
        if (comp === null) return ntlFail('comp ' + NTL_COMP + ' missing');
        var count = Math.min(n, comp.numLayers);
        var props = [];
        for (var i = 1; i <= count; i++) props.push(ntlOpacity(comp.layer(i)));
        $.hiresTimer;
        app.beginUndoGroup('NTL spike patch');
        for (var j = 0; j < count; j++) props[j].setValue(value);
        app.endUndoGroup();
        var us = $.hiresTimer;
        return ntlJson({ ok: true, n: count, us: us, usPer: ntlPer(us, count) });
    } catch (e) { return ntlFail(e); }
}

// What a reconciler actually does: resolve, read, write only on change.
// changed=false is the idle pass over a clean graph.
function NTL_diff(n, changed) {
    try {
        var comp = ntlFindComp();
        if (comp === null) return ntlFail('comp ' + NTL_COMP + ' missing');
        var count = Math.min(n, comp.numLayers);
        $.hiresTimer;
        var writes = 0;
        for (var i = 1; i <= count; i++) {
            var p = ntlOpacity(comp.layer(i));
            var current = p.value;
            var desired = changed ? (current === 50 ? 75 : 50) : current;
            if (current !== desired) { p.setValue(desired); writes++; }
        }
        var us = $.hiresTimer;
        return ntlJson({ ok: true, n: count, writes: writes, us: us, usPer: ntlPer(us, count) });
    } catch (e) { return ntlFail(e); }
}

// Structural churn, priced separately: the first spike measured layer creation
// at ~125x the cost of a property write.
function NTL_structural(n) {
    try {
        var comp = ntlFindComp();
        if (comp === null) return ntlFail('comp ' + NTL_COMP + ' missing');
        app.beginUndoGroup('NTL spike structural');
        $.hiresTimer;
        var made = [];
        for (var i = 0; i < n; i++) made.push(comp.layers.addSolid([1, 0, 0], 'tmp' + i, 100, 100, 1));
        var addUs = $.hiresTimer;
        for (var j = 0; j < made.length; j++) made[j].remove();
        var removeUs = $.hiresTimer;
        app.endUndoGroup();
        return ntlJson({ ok: true, n: n, addUs: addUs, usPerAdd: ntlPer(addUs, n), removeUs: removeUs, usPerRemove: ntlPer(removeUs, n) });
    } catch (e) { return ntlFail(e); }
}

// The panel hands back its results as a URI-encoded string so nothing has to be
// escaped through two layers of quoting.
function ntlWriteResults(name, encoded) {
    var f = new File(Folder.temp.fsName + '/' + name);
    f.encoding = 'UTF-8';
    f.open('w');
    f.write(decodeURIComponent(encoded));
    f.close();
    return f.fsName;
}

function NTL_save(encoded) {
    try {
        return ntlJson({ ok: true, path: ntlWriteResults('ntl-cep-results.json', encoded) });
    } catch (e) { return ntlFail(e); }
}

// Written after every identity phase, not just at the end. The save/reload
// results cost a project to reproduce, so they do not get to live only in the
// panel's memory.
function NTL_saveIdentity(encoded) {
    try {
        return ntlJson({ ok: true, path: ntlWriteResults('ntl-identity-results.json', encoded) });
    } catch (e) { return ntlFail(e); }
}

// ---------------------------------------------------------------- S3: identity
//
// Can a graph node keep a durable handle on an AE layer? Four candidate
// carriers, each tested against operations a user actually performs.
//
// Two fundamentally different schemes, and the spike has to tell them apart:
//
//   we stamp the layer   (comment / marker / effect) — the id travels with the
//                        layer, WE choose the value, and a duplicate collides
//                        (which is detectable, and arguably what we want)
//   AE assigns the id    (native) — unique by construction, never collides, but
//                        we must persist a node -> id map ourselves, and a
//                        duplicated layer is simply unknown to the graph
//
// A collision is therefore not automatically a failure. Being unable to tell is.

var NTL_ID_COMP = 'NTL Identity';

// Does this After Effects expose a native per-layer id? Probed, never assumed —
// if it does, most of this spike is moot.
function NTL_idProbe() {
    try {
        var comp = app.project.items.addComp('NTL Probe', 128, 128, 1, 1, 24);
        var a = comp.layers.addSolid([1, 0, 0], 'probe-a', 64, 64, 1);
        var b = comp.layers.addSolid([0, 1, 0], 'probe-b', 64, 64, 1);

        var hasLayerId = false, idA = '', idB = '', unique = false;
        try {
            if (typeof a.id !== 'undefined' && a.id !== null) {
                hasLayerId = true;
                idA = String(a.id);
                idB = String(b.id);
                unique = idA !== idB;
            }
        } catch (e) { hasLayerId = false; }

        // The lookup lives on the PROJECT, not the comp — comp.layerByID does
        // not exist. That distinction matters: a project-wide lookup needs no
        // comp to search in, so the reconciler never has to scan at all.
        var hasCompLayerByID = false, hasProjectLayerByID = false, hasProjectItemByID = false;
        try { hasCompLayerByID = (typeof comp.layerByID === 'function'); } catch (e) {}
        try { hasProjectLayerByID = (typeof app.project.layerByID === 'function'); } catch (e) {}
        try { hasProjectItemByID = (typeof app.project.itemByID === 'function'); } catch (e) {}

        // Round-trip it rather than trusting that the function merely exists.
        var roundTrip = false, containingComp = '', compIdOk = false;
        if (hasProjectLayerByID && hasLayerId) {
            try {
                var back = app.project.layerByID(a.id);
                roundTrip = (back !== null && typeof back !== 'undefined' && String(back.id) === idA);
                if (roundTrip && back.containingComp) {
                    containingComp = String(back.containingComp.name);
                    if (hasProjectItemByID) {
                        try {
                            var backComp = app.project.itemByID(back.containingComp.id);
                            compIdOk = (backComp !== null && String(backComp.name) === containingComp);
                        } catch (e2) {}
                    }
                }
            } catch (e) {}
        }

        var dupId = '';
        try { if (hasLayerId) dupId = String(a.duplicate().id); } catch (e) {}

        comp.remove();

        // After the comp is gone, a dead id must not resolve to something else.
        // A lookup that returns a stale or wrong layer is worse than no lookup.
        var deletedResolvesTo = 'error';
        if (hasProjectLayerByID && idB !== '') {
            try {
                var gone = app.project.layerByID(Number(idB));
                deletedResolvesTo = (gone === null || typeof gone === 'undefined')
                    ? 'null (correct)'
                    : 'a layer named ' + String(gone.name);
            } catch (e) { deletedResolvesTo = 'throws (acceptable)'; }
        }

        return ntlJson({
            ok: true,
            version: app.version,
            hasLayerId: hasLayerId,
            hasCompLayerByID: hasCompLayerByID,
            hasProjectLayerByID: hasProjectLayerByID,
            hasProjectItemByID: hasProjectItemByID,
            idRoundTrip: roundTrip,
            containingComp: containingComp,
            compIdRoundTrip: compIdOk,
            deletedResolvesTo: deletedResolvesTo,
            idA: idA, idB: idB,
            uniquePerLayer: unique,
            duplicateGetsNewId: hasLayerId ? (dupId !== '' && dupId !== idA) : false,
            dupId: dupId
        });
    } catch (e) { return ntlFail(e); }
}

// ---- carriers ----

function ntlTagWrite(layer, carrier, id) {
    if (carrier === 'comment') { layer.comment = id; return true; }
    if (carrier === 'marker') {
        layer.property('ADBE Marker').setValueAtTime(0, new MarkerValue(id));
        return true;
    }
    if (carrier === 'effect') {
        var fx = layer.property('ADBE Effect Parade').addProperty('ADBE Slider Control');
        fx.name = 'NTL_ID';
        fx.property(1).setValue(Number(id));
        return true;
    }
    return false;   // native: AE assigns it, we cannot write one
}

function ntlTagRead(layer, carrier) {
    try {
        if (carrier === 'comment') return String(layer.comment);
        if (carrier === 'marker') {
            var m = layer.property('ADBE Marker');
            if (m.numKeys < 1) return '';
            return String(m.keyValue(1).comment);
        }
        if (carrier === 'effect') {
            var parade = layer.property('ADBE Effect Parade');
            for (var i = 1; i <= parade.numProperties; i++) {
                var fx = parade.property(i);
                if (fx.name === 'NTL_ID') return String(fx.property(1).value);
            }
            return '';
        }
        if (carrier === 'native') {
            if (typeof layer.id === 'undefined' || layer.id === null) return '';
            return String(layer.id);
        }
    } catch (e) { return ''; }
    return '';
}

// After Effects has no app.undo(). The menu item reads "Undo <action>", so a
// name lookup usually misses; 16 is the historical command id. Try both and
// REPORT which worked — a test that could not undo must say so, not pass.
function ntlUndo() {
    try {
        var byName = app.findMenuCommandId('Undo');
        if (byName && byName > 0) { app.executeCommand(byName); return 'findMenuCommandId'; }
    } catch (e) {}
    try { app.executeCommand(16); return 'commandId16'; } catch (e) {}
    return '';
}

function ntlFreshComp() {
    var proj = app.project;
    for (var i = proj.numItems; i >= 1; i--) {
        var it = proj.item(i);
        if (it instanceof CompItem && it.name === NTL_ID_COMP) it.remove();
    }
    var comp = proj.items.addComp(NTL_ID_COMP, 320, 240, 1, 2, 24);
    for (var k = 0; k < 3; k++) {
        comp.layers.addSolid([0.3, 0.5, 0.8], 'L' + (k + 1), 100, 100, 1);
    }
    return comp;
}

// Tag layer 1, perform one operation, then report what survived and where.
function NTL_identityTest(carrier, op) {
    try {
        var comp = ntlFreshComp();
        var layer = comp.layer(1);
        var writeVal = (carrier === 'effect') ? '4242' : 'ntl-' + carrier + '-4242';

        app.beginUndoGroup('NTL identity tag');
        var wrote = ntlTagWrite(layer, carrier, writeVal);
        app.endUndoGroup();

        var before = ntlTagRead(layer, carrier);
        if (carrier === 'native') wrote = true;    // AE already assigned one
        if (before === '') {
            comp.remove();
            return ntlJson({ ok: true, carrier: carrier, op: op, supported: false,
                             note: 'carrier could not be read back after writing' });
        }

        var note = '', undoMethod = '', copyVal = '', err = '';
        var undoEffective = null;   // null = not applicable to this op

        try {
            app.beginUndoGroup('NTL identity op');
            if (op === 'baseline') {
                // nothing — proves the read path before any operation
            } else if (op === 'reorder') {
                comp.layer(3).moveToBeginning();
            } else if (op === 'rename') {
                layer.name = 'renamed-by-user';
            } else if (op === 'duplicate') {
                copyVal = ntlTagRead(layer.duplicate(), carrier);
            } else if (op === 'undo') {
                // An UNRELATED later edit, then one undo. The tag must survive:
                // this is the user pressing Ctrl+Z during normal work.
                var op100 = layer.property('ADBE Transform Group').property('ADBE Opacity');
                op100.setValue(33);
                app.endUndoGroup();
                undoMethod = ntlUndo();
                app.beginUndoGroup('NTL identity op tail');
                // Issuing an undo command is not the same as an undo happening.
                // Verify the unrelated edit actually reverted, or this column is
                // measuring nothing at all.
                undoEffective = (op100.value === 100);
                if (undoMethod === '') note = 'could not trigger undo — UNTESTED, not a pass';
                else if (!undoEffective) note = 'undo command fired but the edit did not revert — UNTESTED';
            } else if (op === 'precompose') {
                comp.layers.precompose([1], 'NTL Pre', true);
            }
            app.endUndoGroup();
        } catch (e) {
            err = String(e && (e.message || e));
            try { app.endUndoGroup(); } catch (e2) {}
        }

        // The production path for a native id: resolve it directly, project-wide,
        // and infer the comp from the layer. No scan and no index — this is what
        // the reconciler would actually do, so scanning would understate it.
        // Must run before the comp is removed.
        var direct = '', directComp = '';
        if (carrier === 'native') {
            try {
                var hit = app.project.layerByID(Number(before));
                if (hit !== null && typeof hit !== 'undefined') {
                    direct = String(hit.id);
                    if (hit.containingComp) directComp = String(hit.containingComp.name);
                }
            } catch (e) { direct = ''; }
        }

        // Re-find the tagged layer by scanning. This is the fallback path — the
        // only one a stamped carrier has, since layer index is exactly the thing
        // a durable id is supposed to replace.
        var found = '', foundIndex = 0, matches = 0;
        function scan(c) {
            for (var i = 1; i <= c.numLayers; i++) {
                var v = ntlTagRead(c.layer(i), carrier);
                if (v === before) { matches++; if (found === '') { found = v; foundIndex = i; } }
            }
        }
        scan(comp);
        if (op === 'precompose') {
            for (var pi = 1; pi <= app.project.numItems; pi++) {
                var pit = app.project.item(pi);
                if (pit instanceof CompItem && pit.name === 'NTL Pre') scan(pit);
            }
        }

        var survived = (found === before);
        comp.remove();
        for (var pj = app.project.numItems; pj >= 1; pj--) {
            var q = app.project.item(pj);
            if (q instanceof CompItem && q.name === 'NTL Pre') q.remove();
        }

        return ntlJson({
            ok: true, carrier: carrier, op: op, supported: wrote,
            before: before, after: found, survived: survived,
            foundIndex: foundIndex, matches: matches,
            resolvedDirectly: (direct !== '' && direct === before),
            direct: direct, directComp: directComp,
            collision: (op === 'duplicate' && copyVal === before),
            copyValue: copyVal, undoMethod: undoMethod, undoEffective: undoEffective,
            note: note, error: err
        });
    } catch (e) { return ntlFail(e); }
}

// The reconciler reads every id on every diff, so read cost is part of the
// per-frame budget, not a one-off. Compare against the 31.7 us/property that a
// clean diff already costs.
function NTL_identityCost(carrier) {
    try {
        var comp = ntlFindComp();
        if (comp === null || comp.numLayers === 0) {
            NTL_ensure(200);
            comp = ntlFindComp();
            if (comp === null || comp.numLayers === 0) return ntlFail('could not build ' + NTL_COMP);
        }
        var n = comp.numLayers;
        // A native id cannot be written, so timing an empty loop would report a
        // fake "1.5 us write" rather than "not applicable". Skip it outright.
        var writeUs = -1;
        if (carrier !== 'native') {
            app.beginUndoGroup('NTL identity cost');
            $.hiresTimer;
            for (var w = 1; w <= n; w++) {
                ntlTagWrite(comp.layer(w), carrier, (carrier === 'effect') ? String(w) : 'ntl-' + w);
            }
            writeUs = $.hiresTimer;
            app.endUndoGroup();
        }

        $.hiresTimer;
        var seen = 0;
        for (var r = 1; r <= n; r++) { if (ntlTagRead(comp.layer(r), carrier) !== '') seen++; }
        var readUs = $.hiresTimer;

        // A native id is resolved by project-wide lookup, not by walking a comp.
        // Measure the path the reconciler would really use — reading ids off
        // layers you already hold is not the same thing as finding them.
        var lookupUs = -1, hits = 0;
        if (carrier === 'native') {
            var ids = [];
            for (var g = 1; g <= n; g++) ids.push(comp.layer(g).id);
            $.hiresTimer;
            for (var h = 0; h < ids.length; h++) {
                var L = app.project.layerByID(ids[h]);
                if (L !== null && typeof L !== 'undefined') hits++;
            }
            lookupUs = $.hiresTimer;
        }

        return ntlJson({ ok: true, carrier: carrier, n: n, seen: seen,
                         writeUs: writeUs, usPerWrite: writeUs < 0 ? -1 : ntlPer(writeUs, n),
                         readUs: readUs, usPerRead: ntlPer(readUs, n),
                         lookupUs: lookupUs, usPerLookup: lookupUs < 0 ? -1 : ntlPer(lookupUs, n),
                         lookupHits: hits });
    } catch (e) { return ntlFail(e); }
}

// DESTRUCTIVE: saves the current project to a temp file, closes it, reopens it.
// Gated behind its own button in the panel for exactly that reason.
function NTL_identitySaveReload(carrier) {
    try {
        var comp = ntlFreshComp();
        var ID = (carrier === 'effect') ? '4242' : 'ntl-persist-4242';
        app.beginUndoGroup('NTL identity persist');
        ntlTagWrite(comp.layer(1), carrier, ID);
        app.endUndoGroup();
        var before = ntlTagRead(comp.layer(1), carrier);

        var f = new File(Folder.temp.fsName + '/ntl-identity-' + carrier + '.aep');
        app.project.save(f);
        app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
        app.open(f);

        var reopened = null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof CompItem && it.name === NTL_ID_COMP) { reopened = it; break; }
        }
        if (reopened === null) {
            return ntlJson({ ok: true, carrier: carrier, op: 'save-reload', survived: false,
                             note: 'comp not found after reopen' });
        }
        var after = ntlTagRead(reopened.layer(1), carrier);
        return ntlJson({ ok: true, carrier: carrier, op: 'save-reload',
                         before: before, after: after, survived: (after === before),
                         projectPath: f.fsName });
    } catch (e) { return ntlFail(e); }
}

// ------------------------------------------------------------------- S4: drift
//
// After Effects will not tell us when the user edits the comp we generated.
// So: can we notice, cheaply enough to do it on every diff?
//
// A snapshot is keyed by layer id, never by index — an index-keyed snapshot
// reports a one-layer reorder as "everything changed", which is true and
// useless. Keying by id makes add / remove / reorder / edit four distinct
// answers.

var NTL_DRIFT_COMP = 'NTL Drift';

// Is there ANY native change signal? Almost certainly not, but the negative is
// what justifies polling, so it gets recorded rather than assumed.
// `numItems` is a control: it exists, so an all-false result would mean the
// probe itself is broken rather than that AE offers nothing.
function NTL_driftProbe() {
    var found = [], missing = [], controlOk = false;
    // The control is tracked by a flag set here, not by string-matching the
    // label afterwards - the first version matched 'numItems' at index 0 of a
    // label beginning 'app.project.', so the guard against a broken probe was
    // itself the broken thing, and reported every healthy run as broken.
    function check(label, fn, isControl) {
        var ok = false;
        try { var v = fn(); ok = (typeof v !== 'undefined' && v !== null); } catch (e) { ok = false; }
        if (ok && isControl) controlOk = true;
        (ok ? found : missing).push(label);
    }
    try {
        var comp = app.project.items.addComp('NTL DriftProbe', 128, 128, 1, 1, 24);
        var layer = comp.layers.addSolid([1, 0, 0], 'probe', 64, 64, 1);

        check('app.project.numItems (control, must be found)', function () { return app.project.numItems; }, true);
        check('app.project.dirty', function () { return app.project.dirty; });
        check('app.project.modified', function () { return app.project.modified; });
        check('app.project.revision', function () { return app.project.revision; });
        check('app.project.timeChanged', function () { return app.project.timeChanged; });
        check('comp.revision', function () { return comp.revision; });
        check('comp.modified', function () { return comp.modified; });
        check('layer.revision', function () { return layer.revision; });
        check('layer.modified', function () { return layer.modified; });

        comp.remove();
        return ntlJson({
            ok: true,
            found: found.join(' · '),
            missing: missing.join(' · '),
            controlFound: controlOk
        });
    } catch (e) { return ntlFail(e); }
}

// ---- snapshots ----

// Counted rather than swallowed: a snapshot that quietly drops a field would
// stop detecting changes to it, which is worse than a visible error.
var NTL_SNAP_ERRORS = 0;
var NTL_SNAP_FIRST_ERROR = '';

function ntlSafeValue(group, matchName) {
    try {
        var p = group.property(matchName);
        if (p === null || typeof p === 'undefined') {
            NTL_SNAP_ERRORS++;
            if (NTL_SNAP_FIRST_ERROR === '') NTL_SNAP_FIRST_ERROR = matchName + ': property is null';
            return '!NULL';
        }
        return String(p.value);
    } catch (e) {
        NTL_SNAP_ERRORS++;
        if (NTL_SNAP_FIRST_ERROR === '') {
            NTL_SNAP_FIRST_ERROR = matchName + ': ' + String(e && (e.message || e));
        }
        return '!ERR';
    }
}

// Three levels, priced separately: you only pay for what you need to detect.
function ntlSnapLayer(layer, level) {
    var s = layer.index + '|' + layer.name + '|' + (layer.enabled ? 1 : 0) +
            '|' + (layer.parent ? layer.parent.index : 0) +
            '|' + layer.inPoint + '|' + layer.outPoint + '|' + layer.comment;
    if (level === 'structural') return s;

    // A single unreadable property must not abort a whole snapshot - but it must
    // not vanish either, or the digest silently stops covering that field.
    // Failures are substituted with a marker AND counted in NTL_SNAP_ERRORS.
    var t = layer.property('ADBE Transform Group');
    var tnames = ['ADBE Anchor Point', 'ADBE Position', 'ADBE Scale',
                  'ADBE Rotate Z', 'ADBE Opacity'];
    for (var ti = 0; ti < tnames.length; ti++) {
        s += '|' + ntlSafeValue(t, tnames[ti]);
    }
    if (level === 'transform') return s;

    var fx = layer.property('ADBE Effect Parade');
    s += '|fx' + fx.numProperties;
    for (var i = 1; i <= fx.numProperties; i++) {
        var e = fx.property(i);
        s += '|' + e.name;
        for (var j = 1; j <= e.numProperties; j++) {
            try {
                s += ',' + e.property(j).value;
            } catch (err) {
                s += ',!ERR';
                NTL_SNAP_ERRORS++;
            }
        }
    }
    return s;
}

// Keyed by layer id. Returns the map plus a joined digest for the cheap
// "did anything at all change" check.
//
// `limit` caps how many layers are walked, so cost can be measured as a curve
// rather than a single number - a pass that is quadratic in layer count looks
// fine at 25 layers and hangs at 200, and only the curve tells them apart.
function ntlSnapshot(comp, level, limit) {
    var n = (limit && limit > 0) ? Math.min(limit, comp.numLayers) : comp.numLayers;
    var map = {}, joined = [];
    for (var i = 1; i <= n; i++) {
        var L = comp.layer(i);
        var key = String(L.id);
        var val = ntlSnapLayer(L, level);
        map[key] = val;
        joined.push(key + '=' + val);
    }
    return { map: map, digest: joined.join(';'), n: n };
}

// h*33 on a value already near 2^31 produces ~7e10, and every bitwise op then
// forces ExtendScript through an internal ToInt32 (a modulo). That is the most
// plausible source of "invalid numeric result (divide by zero?)" in this file,
// since the only actual division here is guarded. Shifts keep everything inside
// int32 the whole way, so no large intermediate is ever built.
function ntlHash(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
        h = ((((h << 5) - h) | 0) ^ str.charCodeAt(i)) | 0;
    }
    return h & 0x7fffffff;
}

// added / removed / changed, from two id-keyed maps.
function ntlDiffSnapshots(before, after) {
    var added = 0, removed = 0, changed = 0, firstChanged = '';
    for (var k in after.map) {
        if (!after.map.hasOwnProperty(k)) continue;
        if (!before.map.hasOwnProperty(k)) { added++; }
        else if (before.map[k] !== after.map[k]) {
            changed++;
            if (firstChanged === '') firstChanged = k;
        }
    }
    for (var j in before.map) {
        if (!before.map.hasOwnProperty(j)) continue;
        if (!after.map.hasOwnProperty(j)) removed++;
    }
    return { added: added, removed: removed, changed: changed, firstChanged: firstChanged };
}

// What does a snapshot cost on the real 200-layer comp? Compared against the
// 6.3 ms a clean property diff already costs, since both run on every pass.
function NTL_driftCost(level, limit) {
    // Every phase names itself before it runs. A failure then reports WHERE it
    // happened instead of a bare ExtendScript message with no location - which
    // has already cost two rounds of guessing.
    var phase = 'init';
    try {
        // Build the comp if it is not here. The identity save/reload test swaps
        // the whole project out, so this tab cannot assume another tab ran in
        // the project that happens to be open now.
        phase = 'find/build comp';
        var comp = ntlFindComp();
        if (comp === null || comp.numLayers === 0) {
            var ensured = NTL_ensure(200);
            comp = ntlFindComp();
            if (comp === null || comp.numLayers === 0) {
                return ntlFail('could not build ' + NTL_COMP + ' (' + ensured + ')');
            }
        }
        var n = (limit && limit > 0) ? Math.min(limit, comp.numLayers) : comp.numLayers;

        // Phase 1: resolving the layer objects, with no field reads at all.
        // If THIS is the expensive part, comp.layer(i) is the problem and the
        // fix is to resolve once and reuse, not to read fewer fields.
        NTL_SNAP_ERRORS = 0;
        NTL_SNAP_FIRST_ERROR = '';

        phase = 'resolve layers';
        $.hiresTimer;
        var layers = [];
        for (var i = 1; i <= n; i++) layers.push(comp.layer(i));
        var resolveUs = $.hiresTimer;

        // Phase 2: reading the fields off layers already in hand.
        phase = 'read fields';
        $.hiresTimer;
        var map = {}, joined = [];
        for (var j = 0; j < layers.length; j++) {
            var key = String(layers[j].id);
            var val = ntlSnapLayer(layers[j], level);
            map[key] = val;
            joined.push(key + '=' + val);
        }
        var readUs = $.hiresTimer;

        // Phase 3: building one digest string out of the pieces.
        phase = 'join digest';
        $.hiresTimer;
        var digest = joined.join(';');
        var joinUs = $.hiresTimer;

        var a = { map: map, digest: digest, n: n };

        // Phase 4: hashing it, character by character.
        phase = 'hash';
        $.hiresTimer;
        var h = ntlHash(digest);
        var hashUs = $.hiresTimer;

        // Phase 5: the two comparison strategies, against a second snapshot.
        phase = 'second snapshot';
        var b = ntlSnapshot(comp, level, n);
        phase = 'string compare';
        $.hiresTimer;
        var same = (a.digest === b.digest);
        var strcmpUs = $.hiresTimer;

        phase = 'map compare';
        $.hiresTimer;
        var d = ntlDiffSnapshots(a, b);
        var mapCmpUs = $.hiresTimer;

        phase = 'report';
        var totalUs = resolveUs + readUs + joinUs;
        return ntlJson({
            ok: true, level: level, n: n,
            resolveUs: resolveUs, usPerResolve: ntlPer(resolveUs, n),
            readUs: readUs, usPerRead: ntlPer(readUs, n),
            joinUs: joinUs,
            snapUs: totalUs, usPerLayer: ntlPer(totalUs, n),
            digestChars: digest.length,
            hashUs: hashUs, hash: h,
            strcmpUs: strcmpUs, strcmpSame: same,
            mapCmpUs: mapCmpUs, mapCmpChanged: d.changed,
            readErrors: NTL_SNAP_ERRORS,
            firstReadError: NTL_SNAP_FIRST_ERROR
        });
    } catch (e) {
        return ntlJson({
            ok: false,
            message: 'phase "' + phase + '" (' + level + ', n=' + (limit || 'all') + '): ' +
                     String(e && (e.message || e))
        });
    }
}

// ---- fidelity ----
//
// A cheap snapshot that misses the drift that matters is worthless, so every
// level is tested against every mutation a user might actually perform.

function ntlDriftComp() {
    var proj = app.project;
    for (var i = proj.numItems; i >= 1; i--) {
        var it = proj.item(i);
        if (it instanceof CompItem && it.name === NTL_DRIFT_COMP) it.remove();
    }
    var comp = proj.items.addComp(NTL_DRIFT_COMP, 320, 240, 1, 2, 24);
    for (var k = 0; k < 6; k++) {
        var L = comp.layers.addSolid([0.3, 0.5, 0.8], 'D' + (k + 1), 100, 100, 1);
        L.comment = 'ntl-node-' + (k + 1);      // the S3 anchor
    }
    return comp;
}

function ntlApplyMutation(comp, mutation) {
    var L = comp.layer(2);
    if (mutation === 'none') return 'nothing (control — must NOT be detected)';
    if (mutation === 'rename') { L.name = 'user-renamed'; return 'renamed layer 2'; }
    if (mutation === 'reorder') { comp.layer(4).moveToBeginning(); return 'moved layer 4 to top'; }
    if (mutation === 'move') {
        var p = L.property('ADBE Transform Group').property('ADBE Position');
        p.setValue([p.value[0] + 25, p.value[1]]);
        return 'nudged layer 2 position';
    }
    if (mutation === 'opacity') {
        L.property('ADBE Transform Group').property('ADBE Opacity').setValue(42);
        return 'set layer 2 opacity';
    }
    if (mutation === 'disable') { L.enabled = false; return 'disabled layer 2'; }
    if (mutation === 'delete') { comp.layer(3).remove(); return 'deleted layer 3'; }
    if (mutation === 'addLayer') {
        comp.layers.addSolid([1, 1, 0], 'user-added', 50, 50, 1);
        return 'user added a layer';
    }
    if (mutation === 'clearComment') { L.comment = ''; return 'cleared layer 2 comment (the S3 anchor)'; }
    if (mutation === 'addEffect') {
        L.property('ADBE Effect Parade').addProperty('ADBE Gaussian Blur 2');
        return 'added an effect to layer 2';
    }
    if (mutation === 'parent') { comp.layer(2).parent = comp.layer(5); return 'parented layer 2 to 5'; }
    return 'unknown mutation';
}

function NTL_driftDetect(level, mutation) {
    try {
        var comp = ntlDriftComp();
        var before = ntlSnapshot(comp, level);

        app.beginUndoGroup('NTL drift mutation');
        var what = ntlApplyMutation(comp, mutation);
        app.endUndoGroup();

        var after = ntlSnapshot(comp, level);
        var d = ntlDiffSnapshots(before, after);
        var digestChanged = (before.digest !== after.digest);

        comp.remove();
        return ntlJson({
            ok: true, level: level, mutation: mutation, what: what,
            detected: digestChanged,
            added: d.added, removed: d.removed, changed: d.changed,
            // A reorder legitimately shifts many indices. Reporting how many
            // layers moved separates "one edit" from "the whole comp shifted".
            touched: d.added + d.removed + d.changed
        });
    } catch (e) { return ntlFail(e); }
}

// Our own patch must register as drift unless we re-snapshot after it. This
// prices the protocol: snapshot-after-patch is part of the patch budget.
function NTL_driftSelfPatch(level) {
    try {
        var comp = ntlFindComp();
        if (comp === null || comp.numLayers === 0) {
            NTL_ensure(200);
            comp = ntlFindComp();
            if (comp === null || comp.numLayers === 0) return ntlFail('could not build ' + NTL_COMP);
        }
        var n = Math.min(50, comp.numLayers);

        var before = ntlSnapshot(comp, level);

        // The value must differ from whatever is already there, or this test
        // measures nothing. The first version always wrote 60: the structural
        // pass set every layer to 60, and the transform and effects passes then
        // wrote 60 over 60, saw no change, and reported "our patch does not look
        // like drift" - which is the opposite of the truth.
        var current = ntlOpacity(comp.layer(1)).value;
        var target = (current === 60) ? 30 : 60;

        app.beginUndoGroup('NTL drift self patch');
        for (var i = 1; i <= n; i++) {
            ntlOpacity(comp.layer(i)).setValue(target);
        }
        app.endUndoGroup();

        var afterPatch = ntlSnapshot(comp, level);
        var seenAsDrift = ntlDiffSnapshots(before, afterPatch);

        // Re-snapshot, then confirm a following pass sees a clean comp.
        $.hiresTimer;
        var rebased = ntlSnapshot(comp, level);
        var rebaseUs = $.hiresTimer;
        var afterRebase = ntlDiffSnapshots(rebased, ntlSnapshot(comp, level));

        return ntlJson({
            ok: true, level: level, patched: n,
            wroteValue: target, previousValue: current,
            // Opacity is not part of a structural snapshot, so "not detected"
            // there is correct rather than a pass. Flag it so the row is read
            // as "out of scope for this level", not as evidence.
            opacityInScope: (level !== 'structural'),
            ownPatchLooksLikeDrift: (seenAsDrift.changed > 0),
            ownPatchChanged: seenAsDrift.changed,
            cleanAfterRebase: (afterRebase.changed === 0 && afterRebase.added === 0 && afterRebase.removed === 0),
            rebaseUs: rebaseUs
        });
    } catch (e) { return ntlFail(e); }
}

// app.project.dirty and app.project.revision both EXIST - the first probe run
// found them, against expectation. Existing is not the same as being usable as
// a change signal, though: `dirty` may simply mean "unsaved changes" and latch
// true forever, and `revision` may count saves rather than edits.
//
// If revision really does tick per edit, it is a free gate: when it has not
// moved, skip the whole snapshot. That is worth far more than making the
// snapshot faster, so it gets tested properly - including the two ways it could
// be useless (never moving, or moving when nothing happened).
function NTL_driftSignal() {
    try {
        var comp = ntlDriftComp();

        function read() {
            var d = 'n/a', r = 'n/a';
            try { d = String(app.project.dirty); } catch (e) {}
            try { r = String(app.project.revision); } catch (e) {}
            return d + '/' + r;
        }

        var atStart = read();

        // 1. pure reads, changing nothing. A signal that moves here is useless.
        var probeName = comp.layer(1).name;
        var afterIdle = read();

        // 2. a real edit
        app.beginUndoGroup('NTL signal edit');
        ntlOpacity(comp.layer(1)).setValue(77);
        app.endUndoGroup();
        var afterEdit = read();

        // 3. writing the SAME value again - does a no-change write still tick?
        //    This decides whether the gate stays honest during our own patches.
        app.beginUndoGroup('NTL signal same value');
        ntlOpacity(comp.layer(1)).setValue(77);
        app.endUndoGroup();
        var afterSameValue = read();

        // 4. a second distinct edit, to see whether it increments per edit or
        //    merely latches once.
        app.beginUndoGroup('NTL signal edit 2');
        ntlOpacity(comp.layer(1)).setValue(31);
        app.endUndoGroup();
        var afterEdit2 = read();

        // 5. what does reading it cost? It is only a gate if it is cheap.
        $.hiresTimer;
        for (var i = 0; i < 100; i++) { var _ = read(); }
        var readUs = $.hiresTimer;

        comp.remove();

        return ntlJson({
            ok: true,
            atStart: atStart,
            afterIdle: afterIdle,
            afterEdit: afterEdit,
            afterSameValue: afterSameValue,
            afterEdit2: afterEdit2,
            movesOnIdle: (afterIdle !== atStart),
            movesOnEdit: (afterEdit !== afterIdle),
            movesOnSameValueWrite: (afterSameValue !== afterEdit),
            incrementsPerEdit: (afterEdit2 !== afterEdit),
            usPerRead: ntlPer(readUs, 100),
            probeName: probeName
        });
    } catch (e) { return ntlFail(e); }
}

// "read fields" throws at transform level and is clean at structural, so the
// fault is one of the transform reads - but which one is a question for the
// instrument, not for another hypothesis. Each read runs in its own try/catch
// and reports its value or its error.
function NTL_probeProps() {
    var out = [];
    function tryRead(label, fn) {
        try {
            var v = fn();
            out.push(label + ' = ' + String(v));
        } catch (e) {
            out.push(label + ' THREW ' + String(e && (e.message || e)));
        }
    }
    try {
        var comp = ntlFindComp();
        if (comp === null || comp.numLayers === 0) {
            NTL_ensure(200);
            comp = ntlFindComp();
        }
        if (comp === null || comp.numLayers === 0) return ntlFail('no comp to probe');
        var L = comp.layer(1);

        tryRead('comp.duration', function () { return comp.duration; });
        tryRead('comp.frameRate', function () { return comp.frameRate; });
        tryRead('comp.frameDuration', function () { return comp.frameDuration; });
        tryRead('layer.name', function () { return L.name; });
        tryRead('layer.threeDLayer', function () { return L.threeDLayer; });
        tryRead('layer.inPoint', function () { return L.inPoint; });
        tryRead('layer.outPoint', function () { return L.outPoint; });
        tryRead('layer.startTime', function () { return L.startTime; });
        tryRead('layer.stretch', function () { return L.stretch; });

        var t = null;
        tryRead('Transform group', function () {
            t = L.property('ADBE Transform Group');
            return t === null ? 'NULL' : 'ok';
        });

        if (t !== null) {
            var names = ['ADBE Anchor Point', 'ADBE Position', 'ADBE Scale',
                         'ADBE Rotate Z', 'ADBE Opacity', 'ADBE Rotate X', 'ADBE Rotate Y'];
            for (var i = 0; i < names.length; i++) {
                (function (nm) {
                    tryRead('prop("' + nm + '") exists', function () {
                        var p = t.property(nm);
                        return p === null ? 'NULL' : 'ok';
                    });
                    tryRead('  ' + nm + '.value', function () {
                        var p = t.property(nm);
                        if (p === null) return 'skipped (null)';
                        return p.value;
                    });
                })(names[i]);
            }
        }

        tryRead('Effect Parade', function () {
            var fx = L.property('ADBE Effect Parade');
            return fx === null ? 'NULL' : (fx.numProperties + ' effects');
        });

        return ntlJson({ ok: true, report: out.join('   |   ') });
    } catch (e) {
        return ntlJson({ ok: false, message: String(e && (e.message || e)) + ' :: ' + out.join('   |   ') });
    }
}

function NTL_saveDrift(encoded) {
    try {
        return ntlJson({ ok: true, path: ntlWriteResults('ntl-drift-results.json', encoded) });
    } catch (e) { return ntlFail(e); }
}


// -------------------------------------------------------------------- S5: undo
//
// REWRITTEN after the first run produced five results that were all the same
// artefact: the undo never fired. `app.executeCommand(id)` returning without
// throwing is not evidence that anything was undone, and the first version
// treated it as such - reporting "NOT ATOMIC", "undo is undetectable" and
// "eviction at depth 5" when the truth was simply that nothing happened.
//
// The suspected cause: After Effects dispatches menu commands through its own
// queue, so an undo requested inside evalScript may only run AFTER the script
// returns. Every post-undo read in that same script would then see pre-undo
// state - which is exactly the pattern observed.
//
// So the work is split across script boundaries: set up, fire, then inspect in
// a SEPARATE call. And nothing is measured until a positive control proves that
// an undo can be made to happen at all.

var NTL_UNDO_COMP = 'NTL Undo';

function ntlUndoComp(fresh) {
    var proj = app.project;
    if (fresh) {
        for (var i = proj.numItems; i >= 1; i--) {
            var it = proj.item(i);
            if (it instanceof CompItem && it.name === NTL_UNDO_COMP) it.remove();
        }
        var comp = proj.items.addComp(NTL_UNDO_COMP, 320, 240, 1, 2, 24);
        for (var k = 0; k < 4; k++) {
            comp.layers.addSolid([0.3, 0.5, 0.8], 'U' + (k + 1), 100, 100, 1);
        }
        return comp;
    }
    for (var j = 1; j <= proj.numItems; j++) {
        var t = proj.item(j);
        if (t instanceof CompItem && t.name === NTL_UNDO_COMP) return t;
    }
    return null;
}

function ntlRevision() {
    try { return Number(app.project.revision); } catch (e) { return -1; }
}

// Several ways to ask for an undo. Which one works is a question for the
// control, not for an assumption.
function ntlUndoBy(method) {
    try {
        if (method === 'menu') {
            var id = app.findMenuCommandId('Undo');
            if (id && id > 0) { app.executeCommand(id); return 'menu:' + id; }
            return '';
        }
        if (method === 'id16') { app.executeCommand(16); return 'id16'; }
        if (method === 'id2') { app.executeCommand(2); return 'id2'; }
    } catch (e) { return ''; }
    return '';
}

// What the undo surface offers. Control included.
function NTL_undoProbe() {
    var found = [], missing = [], controlOk = false;
    function check(label, fn, isControl) {
        var ok = false;
        try { var v = fn(); ok = (typeof v !== 'undefined' && v !== null); } catch (e) { ok = false; }
        if (ok && isControl) controlOk = true;
        (ok ? found : missing).push(label);
    }
    try {
        check('app.project.numItems (control)', function () { return app.project.numItems; }, true);
        check('app.findMenuCommandId("Undo")', function () {
            var id = app.findMenuCommandId('Undo');
            return (id && id > 0) ? id : null;
        });
        check('app.findMenuCommandId("Redo")', function () {
            var id = app.findMenuCommandId('Redo');
            return (id && id > 0) ? id : null;
        });

        var menuId = 0;
        try { menuId = app.findMenuCommandId('Undo') || 0; } catch (e) {}

        var levels = -1, levelsFrom = '';
        var tries = [
            ['Main Pref Section', 'Pref_NUM_UNDOS'],
            ['Main Pref Section v2', 'Pref_NUM_UNDOS'],
            ['General Section', 'Pref_NUM_UNDOS']
        ];
        for (var t = 0; t < tries.length; t++) {
            try {
                if (app.preferences.havePref(tries[t][0], tries[t][1], PREFType.PREF_Type_MACHINE_INDEPENDENT)) {
                    levels = app.preferences.getPrefAsLong(tries[t][0], tries[t][1], PREFType.PREF_Type_MACHINE_INDEPENDENT);
                    levelsFrom = tries[t][0] + ' / ' + tries[t][1];
                    break;
                }
            } catch (e) {}
        }

        return ntlJson({
            ok: true,
            found: found.join(' · '),
            missing: missing.join(' · '),
            controlFound: controlOk,
            undoMenuId: menuId,
            undoLevels: levels,
            undoLevelsFrom: levelsFrom || 'not readable — measured empirically instead'
        });
    } catch (e) { return ntlFail(e); }
}

// ---- the split protocol: begin / fire / inspect ----
//
// Each is its own evalScript call, so AE gets a chance to run whatever it
// queued between them.

// scenario: 'control'  one edit, to prove an undo can happen at all
//           'atomic'   n properties in ONE undo group
//           'order'    a user edit, then our patch on top
//           'depth'    a user edit, then k patches on top
function NTL_undoBegin(scenario, n) {
    try {
        var comp = ntlUndoComp(true);
        var L = comp.layer(1);
        var originalName = L.name;
        var originalOpacity = ntlOpacity(L).value;

        if (scenario === 'control') {
            app.beginUndoGroup('NTL undo control');
            ntlOpacity(L).setValue(33);
            app.endUndoGroup();
        } else if (scenario === 'atomic') {
            app.beginUndoGroup('NTL undo atomicity');
            for (var i = 1; i <= Math.min(n, comp.numLayers); i++) {
                ntlOpacity(comp.layer(i)).setValue(17);
            }
            app.endUndoGroup();
        } else if (scenario === 'order') {
            app.beginUndoGroup('user edit');
            L.name = 'USER-EDIT';
            app.endUndoGroup();
            app.beginUndoGroup('NTL patch');
            ntlOpacity(L).setValue(11);
            app.endUndoGroup();
        } else if (scenario === 'depth') {
            app.beginUndoGroup('user edit worth keeping');
            L.name = 'USER-EDIT';
            app.endUndoGroup();
            for (var j = 1; j <= n; j++) {
                app.beginUndoGroup('NTL patch ' + j);
                ntlOpacity(L).setValue(20 + (j % 50));
                app.endUndoGroup();
            }
        }

        return ntlJson({
            ok: true, scenario: scenario, n: n,
            originalName: originalName, originalOpacity: originalOpacity,
            nameNow: L.name, opacityNow: ntlOpacity(L).value,
            revision: ntlRevision()
        });
    } catch (e) { return ntlFail(e); }
}

// Fire `times` undos and return WITHOUT reading anything back - the whole point
// is that the read happens in a later call.
function NTL_undoFire(method, times) {
    try {
        var used = '', fired = 0;
        for (var i = 0; i < times; i++) {
            var m = ntlUndoBy(method);
            if (m === '') break;
            used = m;
            fired++;
        }
        return ntlJson({ ok: true, method: method, resolvedTo: used, fired: fired,
                         revision: ntlRevision() });
    } catch (e) { return ntlFail(e); }
}

function NTL_undoInspect() {
    try {
        var comp = ntlUndoComp(false);
        if (comp === null) return ntlFail('undo comp is gone');
        var L = comp.layer(1);
        var opacities = [];
        for (var i = 1; i <= comp.numLayers; i++) opacities.push(ntlOpacity(comp.layer(i)).value);
        return ntlJson({
            ok: true,
            name: L.name,
            opacity: ntlOpacity(L).value,
            allOpacities: opacities.join(','),
            numLayers: comp.numLayers,
            revision: ntlRevision()
        });
    } catch (e) { return ntlFail(e); }
}

function NTL_undoCleanup() {
    try {
        var comp = ntlUndoComp(false);
        if (comp !== null) comp.remove();
        return ntlJson({ ok: true });
    } catch (e) { return ntlFail(e); }
}

function NTL_saveUndo(encoded) {
    try {
        return ntlJson({ ok: true, path: ntlWriteResults('ntl-undo-results.json', encoded) });
    } catch (e) { return ntlFail(e); }
}

// ------------------------------------------------------------- S6: time model
//
// The only spike that is a design question. But one measurement decides it
// before taste is involved:
//
//   How much of a REAL shot is structure, and how much is time?
//
// Wall 4 option (a) gives the graph structure and leaves time to After Effects.
// If real comps turn out to be overwhelmingly temporal - keyframes, retiming,
// sequencing - then a structure-only graph displays the minority of the work,
// and the MVP is the wrong product no matter how good the node view looks.
//
// This walks the ACTIVE comp (the user's own work, read-only) and counts both
// sides. Nothing is written to the project.

function ntlIsGroup(p) {
    return (p.propertyType === PropertyType.INDEXED_GROUP ||
            p.propertyType === PropertyType.NAMED_GROUP);
}

// Depth-capped property-tree walk. Counts animated properties, keyframes and
// expressions without materialising anything.
function ntlWalkProps(group, depth, maxDepth, acc) {
    if (depth > maxDepth) { acc.depthCapped = true; return; }
    var n = 0;
    try { n = group.numProperties; } catch (e) { return; }
    for (var i = 1; i <= n; i++) {
        var p;
        try { p = group.property(i); } catch (e) { continue; }
        if (p === null) continue;
        try {
            if (ntlIsGroup(p)) {
                ntlWalkProps(p, depth + 1, maxDepth, acc);
            } else {
                acc.properties++;
                var keys = 0;
                try { keys = p.numKeys; } catch (e) { keys = 0; }
                if (keys > 0) {
                    acc.animatedProperties++;
                    acc.keyframes += keys;
                }
                try {
                    if (p.expressionEnabled && p.expression && p.expression.length > 0) {
                        acc.expressions++;
                    }
                } catch (e) { /* not all properties admit expressions */ }
            }
        } catch (e) { /* unreadable property, keep walking */ }
    }
}

function ntlCensusComp(comp, depth, maxCompDepth, seen, acc) {
    var key = 'c' + comp.id;
    if (seen[key]) { acc.reusedPrecomps++; return; }
    seen[key] = true;
    acc.comps++;
    if (depth > acc.maxNesting) acc.maxNesting = depth;

    for (var i = 1; i <= comp.numLayers; i++) {
        var L;
        try { L = comp.layer(i); } catch (e) { continue; }
        acc.layers++;

        // ---- structure ----
        try { if (L.parent !== null) acc.parentLinks++; } catch (e) {}
        try { if (L.threeDLayer) acc.threeDLayers++; } catch (e) {}
        try {
            if (L.blendingMode !== BlendingMode.NORMAL) acc.blendModes++;
        } catch (e) {}
        try {
            if (L.trackMatteType && L.trackMatteType !== TrackMatteType.NO_TRACK_MATTE) {
                acc.trackMattes++;
            }
        } catch (e) {}
        try {
            var masks = L.property('ADBE Mask Parade');
            if (masks !== null) acc.masks += masks.numProperties;
        } catch (e) {}
        try {
            var fx = L.property('ADBE Effect Parade');
            if (fx !== null) acc.effects += fx.numProperties;
        } catch (e) {}

        // layer kind
        try {
            if (L instanceof TextLayer) acc.textLayers++;
            else if (L instanceof ShapeLayer) acc.shapeLayers++;
            else if (L instanceof CameraLayer) acc.cameraLayers++;
            else if (L instanceof LightLayer) acc.lightLayers++;
            else if (L.nullLayer) acc.nullLayers++;
            else acc.otherLayers++;
        } catch (e) { acc.otherLayers++; }

        // ---- time ----
        try { if (L.timeRemapEnabled) acc.timeRemapped++; } catch (e) {}
        try {
            if (L.inPoint > comp.displayStartTime + 0.0001 ||
                L.outPoint < comp.displayStartTime + comp.duration - 0.0001) {
                acc.trimmedLayers++;
            }
        } catch (e) {}
        try { if (L.stretch !== 100) acc.retimedLayers++; } catch (e) {}

        ntlWalkProps(L, 0, acc.maxPropDepth, acc);

        // ---- recurse into precomps ----
        try {
            if (L.source && L.source instanceof CompItem) {
                acc.precompLayers++;
                if (depth < maxCompDepth) {
                    ntlCensusComp(L.source, depth + 1, maxCompDepth, seen, acc);
                } else {
                    acc.depthCapped = true;
                }
            }
        } catch (e) {}
    }
}

// Read-only census of the active comp. Nothing is written.
function NTL_census(maxCompDepth, maxPropDepth) {
    try {
        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) {
            return ntlFail('no active composition — open the comp you want to measure and click into it');
        }

        var acc = {
            comps: 0, layers: 0, maxNesting: 0, reusedPrecomps: 0,
            parentLinks: 0, precompLayers: 0, effects: 0, masks: 0,
            trackMattes: 0, blendModes: 0, threeDLayers: 0,
            textLayers: 0, shapeLayers: 0, cameraLayers: 0, lightLayers: 0,
            nullLayers: 0, otherLayers: 0,
            properties: 0, animatedProperties: 0, keyframes: 0, expressions: 0,
            timeRemapped: 0, trimmedLayers: 0, retimedLayers: 0,
            depthCapped: false,
            maxPropDepth: maxPropDepth || 6
        };

        $.hiresTimer;
        ntlCensusComp(comp, 0, maxCompDepth || 3, {}, acc);
        var us = $.hiresTimer;

        // Structure: relationships the graph would draw as edges or nodes.
        var structure = acc.parentLinks + acc.precompLayers + acc.effects +
                        acc.masks + acc.trackMattes + acc.blendModes;
        // Time: everything whose meaning is "when", which option (a) leaves in AE.
        var time = acc.animatedProperties + acc.timeRemapped +
                   acc.trimmedLayers + acc.retimedLayers;

        return ntlJson({
            ok: true,
            compName: comp.name,
            compDuration: comp.duration,
            compFrameRate: comp.frameRate,
            comps: acc.comps, layers: acc.layers, maxNesting: acc.maxNesting,
            reusedPrecomps: acc.reusedPrecomps,
            parentLinks: acc.parentLinks, precompLayers: acc.precompLayers,
            effects: acc.effects, masks: acc.masks, trackMattes: acc.trackMattes,
            blendModes: acc.blendModes, threeDLayers: acc.threeDLayers,
            textLayers: acc.textLayers, shapeLayers: acc.shapeLayers,
            cameraLayers: acc.cameraLayers, lightLayers: acc.lightLayers,
            nullLayers: acc.nullLayers, otherLayers: acc.otherLayers,
            properties: acc.properties, animatedProperties: acc.animatedProperties,
            keyframes: acc.keyframes, expressions: acc.expressions,
            timeRemapped: acc.timeRemapped, trimmedLayers: acc.trimmedLayers,
            retimedLayers: acc.retimedLayers,
            structureScore: structure,
            timeScore: time,
            ratio: (time > 0) ? (structure / time) : -1,
            depthCapped: acc.depthCapped,
            elapsedMs: us / 1000
        });
    } catch (e) { return ntlFail(e); }
}

// The structure of the active comp, as data - the same read P1.1 needs for its
// comp-state reader, and the input to a node-graph sketch of a real shot.
function NTL_dumpStructure(maxLayers) {
    try {
        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) return ntlFail('no active composition');
        var cap = maxLayers || 200;
        var rows = [];
        for (var i = 1; i <= Math.min(cap, comp.numLayers); i++) {
            var L = comp.layer(i);
            var fxNames = [];
            try {
                var fx = L.property('ADBE Effect Parade');
                for (var f = 1; f <= fx.numProperties; f++) fxNames.push(fx.property(f).name);
            } catch (e) {}
            var animated = { properties: 0, animatedProperties: 0, keyframes: 0,
                             expressions: 0, maxPropDepth: 6, depthCapped: false };
            ntlWalkProps(L, 0, 6, animated);

            var kind = 'other';
            try {
                if (L instanceof TextLayer) kind = 'text';
                else if (L instanceof ShapeLayer) kind = 'shape';
                else if (L instanceof CameraLayer) kind = 'camera';
                else if (L instanceof LightLayer) kind = 'light';
                else if (L.nullLayer) kind = 'null';
                else if (L.source && L.source instanceof CompItem) kind = 'precomp';
                else if (L.source) kind = 'footage';
            } catch (e) {}

            var masks = 0;
            try { masks = L.property('ADBE Mask Parade').numProperties; } catch (e) {}

            rows.push([
                L.index, ntlEscape(L.name), kind,
                (L.parent ? L.parent.index : 0),
                fxNames.length, masks,
                animated.animatedProperties, animated.keyframes, animated.expressions,
                (L.enabled ? 1 : 0),
                ntlEscape(fxNames.join('+'))
            ].join('\t'));
        }
        return ntlJson({
            ok: true,
            compName: comp.name,
            layers: comp.numLayers,
            capped: (comp.numLayers > cap),
            header: 'index\tname\tkind\tparent\teffects\tmasks\tanimatedProps\tkeyframes\texpressions\tenabled\teffectNames',
            rows: rows.join('\n')
        });
    } catch (e) { return ntlFail(e); }
}

function NTL_saveCensus(encoded) {
    try {
        return ntlJson({ ok: true, path: ntlWriteResults('ntl-census-results.json', encoded) });
    } catch (e) { return ntlFail(e); }
}
