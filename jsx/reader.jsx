// P1.1 — the comp state reader.
//
// Reads a composition into the `compState` object the pure diff consumes. It is
// STRICTLY READ-ONLY: it opens no undo group, because it writes nothing. If this
// file ever needs an undo group, something has gone wrong.
//
// Two measured decisions are baked in:
//
//   - It SCANS, because it needs every layer anyway - one pass, no lookups.
//     (S3 measured layerByID at 71.5 µs a call on a 200-layer comp; the P1
//     in-AE pass measured 3.2-3.3 µs on a 4-layer one, twice. The gap is
//     unexplained and may mean the lookup scales with project size. The
//     decision does not rest on it: a reader that wants all n layers has
//     nothing to gain from n lookups at any price.)
//   - It resolves each property ONCE and reads through the handle. S4/Wall 1b:
//     resolution, not reading, is what a property access actually costs.
//
// ES3 only. No regex literals containing backslashes - an unterminated regex is
// a parse error, and After Effects is the only syntax check this file gets.
// Prefer split/join. (tools/jsx_check.py is the pre-flight.)

// Requires jsx/common.jsx (JSON emitter, tag parsing, the property table).
// The panel must evaluate that file first.

// Errors are COUNTED, never swallowed. A reader that quietly drops a property
// stops detecting changes to it - the diff would then report "clean" forever,
// which is worse than a visible failure.
var NTLR_ERRORS = 0;
var NTLR_FIRST_ERROR = '';

function ntlrNote(where, e) {
    NTLR_ERRORS++;
    if (NTLR_FIRST_ERROR === '') {
        NTLR_FIRST_ERROR = where + ': ' + String(e && (e.message || e));
    }
}

// Resolve once, read both the value and the expression through the same handle.
function ntlrReadProp(group, matchName, propName, props, exprs) {
    var p;
    try {
        p = group.property(matchName);
    } catch (e) {
        ntlrNote(propName, e);
        return;
    }
    if (p === null || p === undefined) return; // not on this layer kind; not an error

    try {
        var v = ntlrPlain(p.value);
        if (v !== null) props[propName] = v;
    } catch (e2) {
        ntlrNote(propName + '.value', e2);
    }

    // An expression-driven property still reports a value; the expression is
    // what the graph actually owns there, so both are carried and the diff
    // decides which one matters.
    try {
        if (p.canSetExpression && p.expressionEnabled) {
            var t = p.expression;
            if (t && t.length) exprs[propName] = t;
        }
    } catch (e3) {
        ntlrNote(propName + '.expression', e3);
    }
}

// ------------------------------------------------------------------- effects

function ntlrReadEffects(layer) {
    var out = [];
    var parade;
    try {
        parade = layer.property('ADBE Effect Parade');
    } catch (e) {
        ntlrNote('effectParade', e);
        return out;
    }
    if (!parade) return out;

    for (var i = 1; i <= parade.numProperties; i++) {
        var fx;
        try {
            fx = parade.property(i);
        } catch (e2) {
            ntlrNote('effect#' + i, e2);
            continue;
        }
        var params = {};
        var exprs = {};
        for (var j = 1; j <= fx.numProperties; j++) {
            var sub;
            try {
                sub = fx.property(j);
            } catch (e3) {
                ntlrNote('effect#' + i + '.param#' + j, e3);
                continue;
            }
            // Groups and topics are containers, not values. Skipped, not
            // recursed: a nested effect group is out of P1's scope and
            // pretending to read it would be a silent partial result.
            if (sub.propertyType !== PropertyType.PROPERTY) continue;
            try {
                var v = ntlrPlain(sub.value);
                if (v !== null) params[sub.matchName] = v;
            } catch (e4) {
                ntlrNote('effect#' + i + '.' + sub.matchName, e4);
            }
            try {
                if (sub.canSetExpression && sub.expressionEnabled && sub.expression) {
                    exprs[sub.matchName] = sub.expression;
                }
            } catch (e5) {
                ntlrNote('effect#' + i + '.' + sub.matchName + '.expression', e5);
            }
        }
        out.push({
            name: fx.name,
            matchName: fx.matchName,
            index: i,
            params: params,
            expressions: exprs
        });
    }
    return out;
}

// ---------------------------------------------------------------- the reader

// Cameras and lights have no blending mode, and asking for one throws. Kept as
// its own predicate so an unsupported layer kind reads as "not applicable"
// rather than as an error counted against the read.
function ntlrBlendReadable(layer) {
    try {
        return layer.blendingMode !== undefined && layer.blendingMode !== null;
    } catch (e) {
        return false;
    }
}

function ntlrKindOf(layer) {
    if (layer instanceof CameraLayer) return 'camera';
    if (layer instanceof LightLayer) return 'light';
    if (layer instanceof TextLayer) return 'text';
    if (layer instanceof ShapeLayer) return 'shape';
    if (layer.nullLayer) return 'null';
    try {
        if (layer.source && layer.source instanceof CompItem) return 'precomp';
    } catch (e) { /* source can throw on exotic layers; kind falls through */ }
    return 'footage';
}

/**
 * @param comp          the CompItem to read
 * @param includeEffects  effects cost real time; the drift gate does not need them
 * @returns compState
 */
function ntlrReadComp(comp, includeEffects) {
    NTLR_ERRORS = 0;
    NTLR_FIRST_ERROR = '';

    var layers = [];
    var tagByIndex = {};   // index -> node tag, so parents resolve in one pass
    var managed = 0;

    var n = comp.numLayers;

    // Pass 1: identity only. Cheap, and it must complete before parents can be
    // expressed as TAGS rather than as indices - an index is not an identity.
    for (var i = 1; i <= n; i++) {
        var l = comp.layer(i);
        var tag = ntlrNodeIdFromTag(l.comment);
        if (tag !== null) tagByIndex[i] = tag;
    }

    // Pass 2: the read.
    for (var k = 1; k <= n; k++) {
        var layer = comp.layer(k);
        var nodeId = tagByIndex[k];
        if (nodeId === undefined) nodeId = null;

        var rec = {
            nativeId: layer.id,
            index: layer.index,
            name: layer.name,
            comment: layer.comment,
            nodeId: nodeId,
            kind: ntlrKindOf(layer),
            enabled: layer.enabled ? true : false,
            inPoint: layer.inPoint,
            outPoint: layer.outPoint,
            parentIndex: layer.parent ? layer.parent.index : null,
            parentTag: null,
            props: {},
            expressions: {}
        };

        if (rec.parentIndex !== null) {
            var pt = tagByIndex[rec.parentIndex];
            rec.parentTag = (pt === undefined) ? null : pt;
        }

        // The user's own layers are identified and counted, but not read into.
        // Reading them is harmless; carrying their properties is not, because
        // anything in compState looks to the diff like something it may write.
        if (nodeId !== null) {
            managed++;
            // R1: label and blend mode are READ, not assumed. The diff only
            // emits a write for a field it observed, so a field the reader
            // omitted was one the inspector could change forever while After
            // Effects kept the old value and the diff reported clean. Read here,
            // with the properties, because the same rule applies: a field on an
            // unmanaged layer is not ours and must not reach the diff.
            try {
                rec.label = layer.label;
            } catch (eLabel) {
                ntlrNote('label', eLabel);
            }
            try {
                if (ntlrBlendReadable(layer)) rec.blendMode = ntlrBlendName(layer.blendingMode);
            } catch (eBlend) {
                ntlrNote('blendMode', eBlend);
            }
            var tg;
            try {
                tg = layer.property('ADBE Transform Group');
            } catch (e) {
                ntlrNote('transformGroup', e);
                tg = null;
            }
            if (tg) {
                for (var t = 0; t < NTLR_TRANSFORM.length; t++) {
                    ntlrReadProp(tg, NTLR_TRANSFORM[t][1], NTLR_TRANSFORM[t][0],
                                 rec.props, rec.expressions);
                }
            }
            if (includeEffects) rec.effects = ntlrReadEffects(layer);
        }

        layers.push(rec);
    }

    return {
        ok: true,
        compName: comp.name,
        compId: comp.id,
        // S4: app.project.revision is a 2.3 µs gate. Stamping the read with it
        // is what lets a later pass know whether this state is still current.
        revision: app.project.revision,
        duration: comp.duration,
        frameRate: comp.frameRate,
        // The panel needs the frame to place a new layer's position and anchor
        // point at the centre of THIS comp rather than at a hardcoded 1920x1080.
        width: comp.width,
        height: comp.height,
        layerCount: n,
        managedLayers: managed,
        untaggedLayers: n - managed,
        readErrors: NTLR_ERRORS,
        firstError: NTLR_FIRST_ERROR === '' ? null : NTLR_FIRST_ERROR,
        layers: layers
    };
}

// ------------------------------------------------------------- entry points

function ntlrFindComp(name, compId) {
    if (compId !== undefined && compId !== null) {
        for (var c = 1; c <= app.project.numItems; c++) {
            var candidate = app.project.item(c);
            if (candidate instanceof CompItem && candidate.id === compId) return candidate;
        }
        return null;
    }
    if (name) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof CompItem && it.name === name) return it;
        }
        return null;
    }
    var a = app.project.activeItem;
    return (a && a instanceof CompItem) ? a : null;
}

function NTL_ReadComp(compName, includeEffects, compId) {
    try {
        var comp = ntlrFindComp(compName, compId);
        if (!comp) {
            return ntlrVal({ ok: false, message: 'no composition (open one, or pass a name)' });
        }
        if (compId !== undefined && compId !== null) {
            var active = app.project.activeItem;
            if (!active || !(active instanceof CompItem) || active.id !== compId) {
                return ntlrVal({ ok: false, message: 'active composition changed',
                                 expectedCompId: compId,
                                 actualCompId: active && active instanceof CompItem ? active.id : null });
            }
        }
        $.hiresTimer; // reading it once is how you reset it
        var state = ntlrReadComp(comp, includeEffects ? true : false);
        state.elapsedMs = $.hiresTimer / 1000;
        return ntlrVal(state);
    } catch (e) {
        return ntlrVal({ ok: false, message: String(e && (e.message || e)), line: e && e.line });
    }
}

// A cheap identity check for the panel lifecycle. Selection does not move
// app.project.revision, so the revision gate cannot detect a comp switch.
//
// The project's own path rides along, because the graph is saved in a sidecar
// file named after it. Save As moves the project and leaves the sidecar behind,
// and nothing else in the panel would ever notice: the path is read once at
// startup. Carried here rather than in a second call, since this one already
// runs once a second and the whole point of it is cheapness.
function NTL_ActiveComp() {
    try {
        var path = null;
        try {
            if (app.project && app.project.file) path = app.project.file.fsName;
        } catch (ePath) { /* an unsaved project has no file; not an error */ }
        var active = app.project && app.project.activeItem;
        if (!active || !(active instanceof CompItem)) {
            return ntlrVal({ ok: true, active: false, projectPath: path });
        }
        return ntlrVal({ ok: true, active: true, compName: active.name,
                         compId: active.id, projectPath: path });
    } catch (e) {
        return ntlrVal({ ok: false, message: String(e && (e.message || e)), line: e && e.line });
    }
}

// Open AE's own New Composition dialog so presets and every native composition
// option remain available. executeCommand blocks until the user confirms or
// cancels the modal dialog.
function NTL_ShowNewCompDialog() {
    try {
        if (!app.project) app.newProject();
        var beforeItems = app.project.numItems;
        // Adobe recommends fixed command IDs in production because
        // findMenuCommandId is language-package dependent. 2000 is AE's New
        // Composition command; the name lookup is a defensive fallback.
        var commandId = app.findMenuCommandId('New Composition...') || 2000;
        if (!commandId) throw new Error('After Effects did not expose the New Composition command');
        app.executeCommand(commandId);

        var active = app.project.activeItem;
        var created = app.project.numItems > beforeItems && active && active instanceof CompItem;
        if (!created) return ntlrVal({ ok: true, created: false });
        return ntlrVal({ ok: true, created: true, compName: active.name, compId: active.id });
    } catch (e) {
        return ntlrVal({ ok: false, message: String(e && (e.message || e)), line: e && e.line });
    }
}

// The drift gate, priced on its own: S4 measured this at 2.3 µs, which is why
// the reader above never runs unless this number has moved.
function NTL_Revision() {
    try {
        return ntlrVal({ ok: true, revision: app.project.revision });
    } catch (e) {
        return ntlrVal({ ok: false, message: String(e && (e.message || e)) });
    }
}

function NTL_ProjectIdentity() {
    var active = app.project && app.project.activeItem;
    return ntlrVal({ projectPath: app.project && app.project.file ? app.project.file.fsName : null,
        compId: active && active instanceof CompItem ? active.id : null });
}
