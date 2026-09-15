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
        var expressionParams = [];
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
                if (sub.canSetExpression) {
                    // The diff must distinguish an unlinked parameter from one
                    // AE simply does not allow expressions on. Without this
                    // list a linked Fill is judged incomplete forever because
                    // its topic/menu parameters correctly have no expression.
                    expressionParams.push(sub.matchName);
                    if (sub.expressionEnabled && sub.expression) {
                        exprs[sub.matchName] = sub.expression;
                    }
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
            expressions: exprs,
            expressionParams: expressionParams
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
    // Source Text is the capability that matters, and is more reliable than
    // `instanceof TextLayer` across ExtendScript engine versions.
    try {
        if (ntlrTextProp(layer) !== null) return 'text';
    } catch (eText) { /* fall through to the nominal kind checks */ }
    if (layer instanceof TextLayer) return 'text';
    if (layer instanceof ShapeLayer) return 'shape';
    if (layer.nullLayer) return 'null';
    try {
        if (layer.source && ntlrIsCompItem(layer.source)) return 'precomp';
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
            // Effect-node host nulls are graph implementation details. Shy is
            // read so the diff can repair an older or manually un-shied host.
            try {
                rec.shy = layer.shy ? true : false;
            } catch (eShy) {
                ntlrNote('shy', eShy);
            }
            // Only file-backed sources carry a path. Solids also have a
            // FootageItem source in AE, but their SolidSource has no file and
            // must not be mistaken for imported footage.
            try {
                var source = layer.source;
                var sourceFile = source && source.mainSource ? source.mainSource.file : null;
                var missingPath = source && source.mainSource ? source.mainSource.missingFootagePath : null;
                if (source && (sourceFile || missingPath)) {
                    rec.source = {
                        kind: 'footage',
                        itemId: source.id,
                        name: source.name,
                        path: sourceFile ? sourceFile.fsName : missingPath,
                        missing: source.footageMissing ? true : false
                    };
                }
            } catch (eSource) {
                ntlrNote('source', eSource);
            }
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
            // A text layer's string. Read for the same reason label and blend
            // mode are: the diff only emits a write for a field it observed, so
            // an unread field is one the inspector could change forever while
            // After Effects kept the old value and the drift check reported
            // clean. Until this existed, "+ Text" made an empty layer that
            // nothing in the panel could ever fill.
            if (rec.kind === 'text') {
                try {
                    var sourceText = ntlrTextProp(layer);
                    if (sourceText !== null) {
                        rec.text = String(sourceText.value.text);
                        // Keyframed or expression-driven source text is not
                        // ours to overwrite, and the writer refuses it. Said
                        // here so the panel can show the field as read-only
                        // rather than letting the user type into a refusal.
                        if (sourceText.numKeys > 0 || sourceText.expressionEnabled) rec.textLocked = true;
                    }
                } catch (eText) {
                    ntlrNote('sourceText', eText);
                }
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
        hideShyLayers: comp.hideShyLayers ? true : false,
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
            if (ntlrIsCompItem(candidate) && candidate.id === compId) return candidate;
        }
        return null;
    }
    if (name) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (ntlrIsCompItem(it) && it.name === name) return it;
        }
        return null;
    }
    var a = app.project.activeItem;
    return ntlrIsCompItem(a) ? a : null;
}

function NTL_ReadComp(compName, includeEffects, compId) {
    try {
        var comp = ntlrFindComp(compName, compId);
        if (!comp) {
            return ntlrVal({ ok: false, message: 'no composition (open one, or pass a name)' });
        }
        if (compId !== undefined && compId !== null) {
            var active = app.project.activeItem;
            // A Project-panel item becomes active while it is selected or
            // dragged. Reading the still-existing bound comp is safe; only a
            // different active composition is an identity change.
            if (ntlrIsCompItem(active) && active.id !== compId) {
                return ntlrVal({ ok: false, message: 'active composition changed',
                                 expectedCompId: compId,
                                 actualCompId: ntlrIsCompItem(active) ? active.id : null });
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

// A native Project-panel drag carries no stable browser payload in CEP. The
// Project selection is the authoritative payload: resolve it only when the
// user drops on the graph, then restore the graph's bound comp so the ordinary
// guarded patch can add layers from these existing project items.
function NTL_DroppedProjectItems(compId) {
    try {
        var comp = ntlrFindComp(null, compId);
        if (!comp) return ntlrVal({ ok: false, message: 'target composition no longer exists' });
        var selected = app.project.selection || [];
        var items = [];
        var rejected = 0;
        for (var i = 0; i < selected.length; i++) {
            var item = selected[i];
            var isFootage = false;
            try {
                isFootage = !ntlrIsCompItem(item) && item.mainSource !== undefined;
            } catch (eType) { isFootage = false; }
            if (!isFootage) {
                rejected++;
                continue;
            }
            var path = null;
            try {
                if (item.mainSource && item.mainSource.file) path = item.mainSource.file.fsName;
            } catch (ePath) { /* generated or missing footage may have no file */ }
            items.push({ itemId: item.id, name: item.name, path: path,
                         missing: item.footageMissing ? true : false });
        }
        if (items.length) comp.openInViewer();
        return ntlrVal({ ok: true, items: items, rejected: rejected });
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
function NTL_ActiveComp(expectedCompId) {
    try {
        var path = null;
        try {
            if (app.project && app.project.file) path = app.project.file.fsName;
        } catch (ePath) { /* an unsaved project has no file; not an error */ }
        var active = app.project && app.project.activeItem;
        if (!ntlrIsCompItem(active)) {
            var retained = false;
            if (expectedCompId !== undefined && expectedCompId !== null) {
                retained = ntlrFindComp(null, expectedCompId) !== null;
            }
            return ntlrVal({ ok: true, active: false, retainedComp: retained,
                             projectItemActive: active ? true : false, projectPath: path });
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
        var created = app.project.numItems > beforeItems && ntlrIsCompItem(active);
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
        compId: ntlrIsCompItem(active) ? active.id : null });
}

// ------------------------------------------------------- frame transport

// CTI motion is viewer state, not project state: it creates no undo entry and
// does not move app.project.revision.  Keep it outside the graph reader and
// writer so playback can never look like a structural edit or drift.
function ntlrTransportRecord(comp) {
    var fd = comp.frameDuration;
    var startFrame;
    try {
        // displayStartFrame avoids accumulated floating-point error on comps
        // with long or negative start timecodes. It is available in modern AE.
        startFrame = comp.displayStartFrame;
    } catch (eStart) {
        startFrame = Math.round(comp.displayStartTime / fd);
    }
    if (startFrame === undefined || startFrame === null || !isFinite(startFrame)) {
        startFrame = Math.round(comp.displayStartTime / fd);
    }

    var frameCount = Math.max(1, Math.round(comp.duration / fd));
    var workStartOffset = Math.round(comp.workAreaStart / fd);
    var workFrameCount = Math.max(1, Math.round(comp.workAreaDuration / fd));
    var endFrame = startFrame + frameCount - 1;
    var workStartFrame = startFrame + workStartOffset;
    var workEndFrame = Math.min(endFrame, workStartFrame + workFrameCount - 1);
    var currentFrame = startFrame + Math.round(comp.time / fd);
    currentFrame = Math.max(startFrame, Math.min(endFrame, currentFrame));

    return {
        ok: true,
        compId: comp.id,
        frameRate: comp.frameRate,
        frameDuration: fd,
        startFrame: startFrame,
        endFrame: endFrame,
        workStartFrame: workStartFrame,
        workEndFrame: workEndFrame,
        currentFrame: currentFrame,
        dropFrame: comp.dropFrame ? true : false
    };
}

function NTL_TransportState(compId) {
    try {
        var comp = ntlrFindComp(null, compId);
        var active = app.project && app.project.activeItem;
        if (!comp || !ntlrIsCompItem(active) || active.id !== comp.id) {
            return ntlrVal({ ok: false, message: 'active composition changed' });
        }
        return ntlrVal(ntlrTransportRecord(comp));
    } catch (e) {
        return ntlrVal({ ok: false, message: String(e && (e.message || e)), line: e && e.line });
    }
}

function NTL_SetCurrentFrame(compId, frame) {
    try {
        var comp = ntlrFindComp(null, compId);
        var active = app.project && app.project.activeItem;
        if (!comp || !ntlrIsCompItem(active) || active.id !== comp.id) {
            return ntlrVal({ ok: false, message: 'active composition changed' });
        }
        var state = ntlrTransportRecord(comp);
        var target = Math.round(Number(frame));
        if (!isFinite(target)) throw new Error('frame must be a finite number');
        target = Math.max(state.startFrame, Math.min(state.endFrame, target));
        // Assign from an integer frame every time. Repeated addition of
        // frameDuration drifts; this conversion does not.
        comp.time = (target - state.startFrame) * state.frameDuration;
        return ntlrVal(ntlrTransportRecord(comp));
    } catch (e) {
        return ntlrVal({ ok: false, message: String(e && (e.message || e)), line: e && e.line });
    }
}
