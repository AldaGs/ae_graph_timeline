// P1.3 — the patch emitter.
//
// Takes the ordered ops the pure diff produced and applies them to a comp. This
// is the only file in the project that writes to the user's project, and it is
// built around four measured facts:
//
//   - ONE undo group per patch. S5 measured After Effects' undo stack at exactly
//     99 entries. A patch per frame would evict the user's entire history in
//     under two seconds of dragging; a patch per gesture costs one entry.
//   - Properties are resolved ONCE and written through the handle. Wall 1b:
//     130 µs per write when resolved once against 294 µs when re-resolved.
//   - Creating a layer costs 14.5 ms; writing a property costs 0.13 ms. A
//     hundredfold gap, which is why the reconciler patches and never rebuilds.
//   - Layers are found by ONE SCAN, not by layerByID (S3: 0.48 ms for 200 layers
//     against 71.5 µs per lookup).
//
// A script cannot reliably undo its own patch, so every op that can be inverted
// returns its inverse. Rollback is re-applying that inverse, not pressing undo.
//
// Requires jsx/common.jsx. ES3 only; pre-flight with tools/jsx_check.py.

var NTLP_OPEN = null;      // the comp of the patch currently in progress

// ------------------------------------------------------------------ failures
//
// An op that cannot be applied STOPS the patch. It does not get skipped.
//
// Skipping would leave the comp in a state that is neither the old one nor the
// one the graph asked for, and the next diff would compute against a lie. The
// panel gets the inverse of everything applied so far and can put it back.

function ntlpFail(reason) {
    var e = new Error(reason);
    e.ntlp = true;
    return e;
}

// ------------------------------------------------------------------ resolving

function ntlpLayer(ctx, nodeId, nativeId) {
    // An op that named a native id named it for a reason, so it is honoured
    // whether or not the tag is currently ambiguous. Resolving by tag anyway
    // when the count happened to be 1 meant an op aimed at one specific layer
    // could land on a different one - which is the corruption the id is there
    // to prevent, not merely a missed optimisation.
    if (nativeId !== undefined && nativeId !== null) {
        var candidate = ctx.byNativeId[nativeId];
        if (candidate && ntlrNodeIdFromTag(candidate.comment) === nodeId) return candidate;
        throw ntlpFail('no layer found with id ' + nativeId + ' for tag "' + nodeId + '"');
    }
    var l = ctx.byTag[nodeId];
    if (l === undefined) throw ntlpFail('no layer carries the tag "' + nodeId + '"');
    if (ctx.counts[nodeId] > 1) {
        // S3: a duplicated layer carries the same comment. The diff already
        // warns; the writer refuses outright, because writing to the wrong one
        // of an ambiguous pair is exactly the silent corruption we are here to
        // prevent.
        throw ntlpFail(ctx.counts[nodeId] + ' layers carry the tag "' + nodeId + '"; refusing to guess');
    }
    return l;
}

// setComment is the one op whose target need NOT already carry the tag: it is
// the op that assigns and releases tags. Resolved by native id on its own terms,
// so a rollback can re-tag a layer that is currently untagged.
function ntlpCommentTarget(ctx, op) {
    if (op.nativeId === undefined || op.nativeId === null) return ntlpLayer(ctx, op.node);
    var layer = ctx.byNativeId[op.nativeId];
    if (!layer) throw ntlpFail('no layer found with id ' + op.nativeId);
    return layer;
}

// Resolve once, cache, write through the handle.
function ntlpProp(ctx, nodeId, propName) {
    var key = nodeId + '|' + propName;
    if (ctx.props[key] !== undefined) return ctx.props[key];

    var matchName = ntlrMatchName(propName);
    if (matchName === null) throw ntlpFail('unknown property "' + propName + '"');

    var layer = ntlpLayer(ctx, nodeId);
    var group = layer.property('ADBE Transform Group');
    if (!group) throw ntlpFail('layer "' + layer.name + '" has no transform group');
    var p = group.property(matchName);
    if (p === null || p === undefined) {
        throw ntlpFail('layer "' + layer.name + '" has no "' + propName + '"');
    }
    ctx.props[key] = p;
    return p;
}

// Two states in which a property cannot take a value, both of which throw in
// After Effects rather than failing politely. Checked first, so the reason
// reaches the panel as a sentence instead of an AE exception.
function ntlpWritable(p, nodeId, propName) {
    if (p.numKeys > 0) {
        throw ntlpFail(nodeId + '.' + propName + ' is keyframed; the graph does not write over keyframes');
    }
    if (!p.canSetExpression && p.expressionEnabled) {
        throw ntlpFail(nodeId + '.' + propName + ' is expression-driven');
    }
}

// ------------------------------------------------------------------ the ops
//
// Each returns the inverse op, or null where the change cannot be inverted.

function ntlpCreateLayer(ctx, op) {
    // 14.5 ms, against 0.13 ms for a property write. Counted separately in the
    // receipt so a patch that is slow for a good reason looks different from a
    // patch that is slow for a bad one.
    var comp = ctx.comp;
    var layer;
    if (op.kind === 'null') {
        layer = comp.layers.addNull();
    } else if (op.kind === 'text') {
        // Created WITH its string, in the same undo group. A layer that had to
        // wait for a setText would be empty for one write cycle. Safe to let
        // addText build the document here, unlike ntlpSetText: a layer that did
        // not exist a moment ago has no typography to preserve.
        layer = comp.layers.addText(op.text === undefined || op.text === null ? '' : String(op.text));
    } else {
        layer = comp.layers.addSolid([0.5, 0.5, 0.5], op.name || op.node,
                                     comp.width, comp.height, 1);
    }
    layer.name = op.name || op.node;
    // The tag is what makes the layer findable again, so it is written in the
    // same undo group as the creation. A created-but-untagged layer would be
    // indistinguishable from one of the user's own.
    layer.comment = ntlrTagFor(op.node);
    if (op.label !== undefined) layer.label = op.label;
    if (op.enabled !== undefined) layer.enabled = op.enabled;
    // AE inserts new layers at the top. Place a new managed layer relative to
    // the existing managed stack in this same undo group.
    if (op.order !== undefined) {
        var managed = [];
        for (var li = 1; li <= comp.numLayers; li++) {
            var existing = comp.layer(li);
            if (existing !== layer && ntlrNodeIdFromTag(existing.comment) !== null) managed.push(existing);
        }
        var slot = Math.max(0, Math.min(managed.length, op.order - 1));
        if (slot < managed.length) layer.moveBefore(managed[slot]);
        else if (managed.length) layer.moveAfter(managed[managed.length - 1]);
    }

    ctx.byTag[op.node] = layer;
    ctx.byNativeId[layer.id] = layer;
    ctx.counts[op.node] = 1;
    ctx.created++;
    // M4: record the native id so the panel can cache it on the graph node.
    ctx.createdIds[op.node] = layer.id;

    if (op.props) {
        for (var k in op.props) {
            if (!op.props.hasOwnProperty(k)) continue;
            if (ntlrMatchName(k) === null) continue;
            var p = ntlpProp(ctx, op.node, k);
            p.setValue(op.props[k]);
            ctx.writes++;
        }
    }
    return { op: 'deleteLayer', node: op.node };
}

function ntlpDeleteLayer(ctx, op) {
    // M4: use nativeId to target the right duplicate if available
    var layer = ntlpLayer(ctx, op.node, op.nativeId);
    delete ctx.byNativeId[layer.id];
    layer.remove();
    // Reindexed rather than wiped: deleting ONE of a duplicated pair leaves the
    // tag still claimed, and a later op in this patch has to see that.
    ntlpReindexTag(ctx, op.node);
    // NOT invertible. Re-creating a solid is not restoring the layer that was
    // there - its masks, effects and keyframes are gone. A patch containing a
    // delete is reported as only partly reversible, rather than pretending.
    return null;
}

function ntlpSetName(ctx, op) {
    var layer = ntlpLayer(ctx, op.node);
    var before = layer.name;
    layer.name = op.to;
    return { op: 'setName', node: op.node, to: before };
}

function ntlpSetEnabled(ctx, op) {
    var layer = ntlpLayer(ctx, op.node);
    var before = layer.enabled;
    layer.enabled = op.to;
    return { op: 'setEnabled', node: op.node, to: before };
}

function ntlpSetLabel(ctx, op) {
    var layer = ntlpLayer(ctx, op.node);
    var before = layer.label;
    layer.label = op.to;
    return { op: 'setLabel', node: op.node, to: before };
}

function ntlpReorder(ctx, op) {
    // Put the requested managed layers into the slots currently occupied by
    // managed layers. User-owned layers therefore keep both their relative
    // order and their exact indices.
    var currentIndices = [];
    var layersById = {};
    var requested = {};
    for (var j = 0; j < op.tags.length; j++) requested['$' + op.tags[j]] = true;
    for (var i = 1; i <= ctx.comp.numLayers; i++) {
        var layer = ctx.comp.layer(i);
        var tag = ntlrNodeIdFromTag(layer.comment);
        if (requested['$' + tag] && ctx.counts[tag] === 1) {
            currentIndices.push(i);
            layersById[tag] = layer;
        }
    }

    if (currentIndices.length !== op.tags.length) {
        throw new Error('reorder layer set changed; refusing a partial reorder');
    }

    for (var k = 0; k < op.tags.length; k++) {
        var layerToMove = layersById[op.tags[k]];
        var targetIndex = currentIndices[k];
        if (!layerToMove) throw new Error('reorder layer is missing: ' + op.tags[k]);
        if (layerToMove.index === targetIndex) continue;

        var anchor = ctx.comp.layer(targetIndex);
        if (layerToMove.index > targetIndex) layerToMove.moveBefore(anchor);
        else layerToMove.moveAfter(anchor);
    }

    return { op: 'reorder', tags: op.current, current: op.tags };
}


// R2: the patch context's tag index has to move with the comment, or a later op
// in the SAME patch still sees two claimants for a tag whose copy this op just
// released - and the patch fails after the cleanup has already landed.
function ntlpReindexTag(ctx, tag) {
    if (tag === null) return;
    var comp = ctx.comp;
    var count = 0;
    var first = null;
    for (var i = 1; i <= comp.numLayers; i++) {
        var l = comp.layer(i);
        if (ntlrNodeIdFromTag(l.comment) !== tag) continue;
        count++;
        if (first === null) first = l;
    }
    if (count === 0) {
        delete ctx.byTag[tag];
        delete ctx.counts[tag];
        return;
    }
    ctx.byTag[tag] = first;
    ctx.counts[tag] = count;
}

function ntlpSetComment(ctx, op) {
    var layer = ntlpCommentTarget(ctx, op);
    var before = layer.comment;
    var wasTag = ntlrNodeIdFromTag(before);
    layer.comment = op.comment;
    // Both sides: the tag the layer left, and the tag it joined. A rollback
    // re-tags, so the same bookkeeping has to hold in the inverse direction.
    ntlpReindexTag(ctx, wasTag);
    var nowTag = ntlrNodeIdFromTag(op.comment);
    if (nowTag !== wasTag) ntlpReindexTag(ctx, nowTag);
    return { op: 'setComment', node: op.node, nativeId: op.nativeId, comment: before };
}

function ntlpSetProp(ctx, op) {
    var p = ntlpProp(ctx, op.node, op.prop);
    ntlpWritable(p, op.node, op.prop);
    var before = ntlrPlain(p.value);
    p.setValue(op.to);
    ctx.writes++;
    return before === null ? null : { op: 'setProp', node: op.node, prop: op.prop, to: before };
}

/**
 * A text layer's string.
 *
 * The whole TextDocument is read, its text field changed, and the SAME object
 * set back. Constructing a fresh TextDocument would be shorter and would silently
 * reset the layer's font, size, colour, tracking and justification to After
 * Effects' defaults - the user's typography thrown away to change a word.
 */
function ntlpSetText(ctx, op) {
    var layer = ntlpLayer(ctx, op.node);
    var prop = ntlrTextProp(layer);
    if (prop === null) throw ntlpFail(op.node + ' is not a text layer');
    // The same two states every other write checks, and for the same reason:
    // both throw in After Effects rather than failing politely.
    ntlpWritable(prop, op.node, 'sourceText');
    var doc = prop.value;
    var before = String(doc.text);
    if (before === op.to) return null;
    doc.text = op.to;
    prop.setValue(doc);
    ctx.writes++;
    return { op: 'setText', node: op.node, to: before };
}

function ntlpSetParent(ctx, op) {
    var layer = ntlpLayer(ctx, op.node);
    var before = null;
    if (layer.parent) {
        before = ntlrNodeIdFromTag(layer.parent.comment);
        if (before === null) {
            // The user parented our layer to one of their own. Overwriting that
            // silently would discard a decision we cannot restore.
            throw ntlpFail(op.node + ' is parented to an untagged layer ("' +
                           layer.parent.name + '"); refusing to overwrite it');
        }
    }
    layer.parent = (op.to === null || op.to === undefined) ? null : ntlpLayer(ctx, op.to);
    return { op: 'setParent', node: op.node, to: before };
}

function ntlpSetExpression(ctx, op) {
    var p = ntlpProp(ctx, op.node, op.prop);
    if (!p.canSetExpression) {
        throw ntlpFail(op.node + '.' + op.prop + ' cannot take an expression');
    }
    var before = p.expressionEnabled ? p.expression : '';
    // Ownership was decided by the diff, which refuses to touch an expression
    // the user wrote. This is a second check at the point of writing: the comp
    // may have changed since the read.
    if (before && !ntlrOwnsExpression(before)) {
        throw ntlpFail(op.node + '.' + op.prop + ' now carries a hand-written expression');
    }
    p.expression = op.text;
    ctx.writes++;
    return before ? { op: 'setExpression', node: op.node, prop: op.prop, text: before }
                  : { op: 'clearExpression', node: op.node, prop: op.prop };
}

function ntlpClearExpression(ctx, op) {
    var p = ntlpProp(ctx, op.node, op.prop);
    if (!p.canSetExpression) return null;
    var before = p.expressionEnabled ? p.expression : '';
    if (before && !ntlrOwnsExpression(before)) {
        throw ntlpFail(op.node + '.' + op.prop + ' carries a hand-written expression');
    }
    p.expression = '';
    ctx.writes++;
    return before ? { op: 'setExpression', node: op.node, prop: op.prop, text: before } : null;
}

// The graph tags the expressions it authors, which is what makes ownership
// detectable at all. Same predicate as src/graph.js, kept in step by the tests.
var NTLP_EXPR_TAG = '// ntl:edge:';

function ntlrOwnsExpression(text) {
    if (typeof text !== 'string' || text.length === 0) return false;
    var first = ntlrTrim(text.split('\n')[0]);
    if (first.slice(0, NTLP_EXPR_TAG.length) !== NTLP_EXPR_TAG) return false;
    return first.length > NTLP_EXPR_TAG.length;
}

function ntlpSetEffect(ctx, op) {
    var layer = ntlpLayer(ctx, op.node);
    var parade = layer.property('ADBE Effect Parade');
    if (!parade) throw ntlpFail('layer "' + layer.name + '" has no effect parade');
    var effect = parade.property(op.index);
    if (!effect) throw ntlpFail('no effect at index ' + op.index + ' on layer "' + layer.name + '"');
    var p = effect.property(op.param);
    if (!p) throw ntlpFail('effect ' + op.index + ' has no parameter "' + op.param + '"');
    
    ntlpWritable(p, op.node, 'effect.' + op.index + '.' + op.param);
    var before = ntlrPlain(p.value);
    p.setValue(op.to);
    ctx.writes++;
    return before === null ? null : { op: 'setEffect', node: op.node, index: op.index, param: op.param, to: before };
}

function ntlpAddEffect(ctx, op) {
    var layer = ntlpLayer(ctx, op.node);
    var parade = layer.property('ADBE Effect Parade');
    if (!parade) throw ntlpFail('layer "' + layer.name + '" has no effect parade');
    if (!parade.canAddProperty(op.matchName)) {
        throw ntlpFail('cannot add effect "' + op.matchName + '" to layer "' + layer.name + '"');
    }
    var effect = parade.addProperty(op.matchName);
    if (op.name) effect.name = op.name;
    var newIndex = effect.propertyIndex;
    ctx.writes++;
    
    if (op.params) {
        for (var k in op.params) {
            if (!op.params.hasOwnProperty(k)) continue;
            var p = effect.property(k);
            if (p) {
                p.setValue(op.params[k]);
                ctx.writes++;
            }
        }
    }
    return { op: 'removeEffect', node: op.node, index: newIndex };
}

function ntlpLinkEffectToHost(ctx, op) {
    var layer = ntlpLayer(ctx, op.node);
    var parade = layer.property('ADBE Effect Parade');
    if (!parade) throw ntlpFail('layer "' + layer.name + '" has no effect parade');
    var effect = parade.property(op.effectIndex);
    if (!effect) throw ntlpFail('no effect at index ' + op.effectIndex + ' on layer "' + layer.name + '"');

    var hostNameStr = String(op.hostName).split('\\').join('\\\\').split('"').join('\\"');
    var baseExpr = 'thisComp.layer("' + hostNameStr + '").effect(1)';

    for (var i = 1; i <= effect.numProperties; i++) {
        var p = effect.property(i);
        if (p && p.propertyType === PropertyType.PROPERTY && p.canSetExpression) {
            p.expression = baseExpr + '(' + i + ')';
            ctx.writes++;
        }
    }
    return null;
}

function ntlpRemoveEffect(ctx, op) {
    var layer = ntlpLayer(ctx, op.node);
    var parade = layer.property('ADBE Effect Parade');
    if (!parade) throw ntlpFail('layer "' + layer.name + '" has no effect parade');
    var effect = parade.property(op.index);
    if (!effect) throw ntlpFail('no effect at index ' + op.index + ' on layer "' + layer.name + '"');
    effect.remove();
    ctx.writes++;
    return null;
}

var NTLP_BLEND = {
    'normal': 'NORMAL',
    'dissolve': 'DISSOLVE',
    'darken': 'DARKEN',
    'multiply': 'MULTIPLY',
    'colorBurn': 'COLOR_BURN',
    'linearBurn': 'LINEAR_BURN',
    'darkerColor': 'DARKER_COLOR',
    'lighten': 'LIGHTEN',
    'screen': 'SCREEN',
    'colorDodge': 'COLOR_DODGE',
    'linearDodge': 'LINEAR_DODGE',
    'lighterColor': 'LIGHTER_COLOR',
    'overlay': 'OVERLAY',
    'softLight': 'SOFT_LIGHT',
    'hardLight': 'HARD_LIGHT',
    'vividLight': 'VIVID_LIGHT',
    'linearLight': 'LINEAR_LIGHT',
    'pinLight': 'PIN_LIGHT',
    'hardMix': 'HARD_MIX',
    'difference': 'DIFFERENCE',
    'exclusion': 'EXCLUSION',
    'subtract': 'SUBTRACT',
    'divide': 'DIVIDE',
    'hue': 'HUE',
    'saturation': 'SATURATION',
    'color': 'COLOR',
    'luminosity': 'LUMINOSITY'
};

function ntlpSetBlendMode(ctx, op) {
    var layer = ntlpLayer(ctx, op.node);
    var constantName = NTLP_BLEND[op.to];
    if (!constantName) throw ntlpFail('unknown blend mode "' + op.to + '"');
    
    var oldEnum = layer.blendingMode;
    var oldStr = 'normal';
    for (var k in NTLP_BLEND) {
        if (!NTLP_BLEND.hasOwnProperty(k)) continue;
        if (BlendingMode[NTLP_BLEND[k]] === oldEnum) {
            oldStr = k;
            break;
        }
    }
    
    layer.blendingMode = BlendingMode[constantName];
    ctx.writes++;
    return { op: 'setBlendMode', node: op.node, to: oldStr };
}

// An op this build does not implement must SAY so. Silently ignoring it would
// let the diff go on emitting it forever while the comp never changes - a loop
// that looks like drift.
function ntlpApplyOne(ctx, op) {
    switch (op.op) {
        case 'createLayer':     return ntlpCreateLayer(ctx, op);
        case 'deleteLayer':     return ntlpDeleteLayer(ctx, op);
        case 'setName':         return ntlpSetName(ctx, op);
        case 'setProp':         return ntlpSetProp(ctx, op);
        case 'setParent':       return ntlpSetParent(ctx, op);
        case 'setExpression':   return ntlpSetExpression(ctx, op);
        case 'clearExpression': return ntlpClearExpression(ctx, op);
        case 'setEffect':       return ntlpSetEffect(ctx, op);
        case 'addEffect':       return ntlpAddEffect(ctx, op);
        case 'removeEffect':    return ntlpRemoveEffect(ctx, op);
        case 'linkEffectToHost':return ntlpLinkEffectToHost(ctx, op);
        case 'setBlendMode':    return ntlpSetBlendMode(ctx, op);
        case 'setComment':      return ntlpSetComment(ctx, op);
        case 'setEnabled':      return ntlpSetEnabled(ctx, op);
        case 'setLabel':        return ntlpSetLabel(ctx, op);
        case 'setText':         return ntlpSetText(ctx, op);
        case 'reorder':         return ntlpReorder(ctx, op);
    }
    throw ntlpFail('unknown op "' + String(op.op) + '"');
}

// ------------------------------------------------------------- entry points

function ntlpFindComp(name) {
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

/**
 * Apply one patch, in one undo group.
 *
 * @param compName  null for the active comp
 * @param ops       the diff's ops, already ordered - passed as a real array
 *                  literal, because ExtendScript has no JSON parser
 * @param label     what the user will see in Edit > Undo
 * @param expectRevision  the app.project.revision the diff was computed against;
 *                  -1 to skip the check
 * @param expectCompId  native comp identity pinned when the loop was created
 */
function NTL_ApplyPatch(compName, ops, label, expectRevision, expectCompId) {
    var started = false;
    var ctx = null;
    var applied = 0;
    var inverse = [];
    try {
        var comp = ntlrFindComp(compName, expectCompId);
        if (!comp) return ntlrVal({ ok: false, message: 'no composition' });
        if (expectCompId !== undefined && expectCompId !== null) {
            var activeComp = app.project.activeItem;
            if (!activeComp || !(activeComp instanceof CompItem) || activeComp.id !== expectCompId) {
                return ntlrVal({ ok: false, stale: true, message: 'active composition changed',
                                 expectedCompId: expectCompId,
                                 actualCompId: activeComp && activeComp instanceof CompItem ? activeComp.id : null });
            }
        }
        if (!ops || !(ops instanceof Array)) {
            return ntlrVal({ ok: false, message: 'no ops array' });
        }

        // S4's gate, used here as a guard rather than a poll: if the project
        // moved between the read and this write, the patch was computed against
        // a comp that no longer exists and must not be applied.
        if (expectRevision !== undefined && expectRevision !== null && expectRevision >= 0) {
            if (app.project.revision !== expectRevision) {
                return ntlrVal({
                    ok: false,
                    stale: true,
                    message: 'project moved between read and write',
                    expected: expectRevision,
                    actual: app.project.revision
                });
            }
        }

        if (ops.length === 0) {
            return ntlrVal({ ok: true, applied: 0, writes: 0, created: 0,
                             revision: app.project.revision, inverse: [], invertible: true });
        }

        $.hiresTimer;
        var scan = ntlrScanTags(comp);
        ctx = { comp: comp, byTag: scan.byTag, counts: scan.counts, byNativeId: scan.byNativeId,
                props: {}, writes: 0, created: 0, createdIds: {} };
        var scanMs = $.hiresTimer / 1000;

        // ONE group for the whole patch. S5: the stack holds 99 entries.
        app.beginUndoGroup(label || 'Node Timeline patch');
        started = true;

        var destructive = false;
        for (var i = 0; i < ops.length; i++) {
            var inv = ntlpApplyOne(ctx, ops[i]);
            applied++;
            if (inv === null) destructive = true;
            // Built back to front: rolling back means undoing the LAST change
            // first, or an earlier inverse would be overwritten by a later one.
            else inverse.unshift(inv);
        }

        app.endUndoGroup();
        started = false;

        return ntlrVal({
            ok: true,
            applied: applied,
            writes: ctx.writes,
            created: ctx.created,
            createdIds: ctx.createdIds,
            scanMs: scanMs,
            elapsedMs: $.hiresTimer / 1000,
            revision: app.project.revision,
            // False when the patch deleted a layer: re-creating it would not
            // restore its masks, effects or keyframes.
            invertible: !destructive,
            inverse: inverse
        });
    } catch (e) {
        // The group is always closed. An open undo group left behind would
        // swallow the user's next several actions into ours.
        if (started) {
            try { app.endUndoGroup(); } catch (e2) { /* nothing further to do */ }
        }
        return ntlrVal({
            ok: false,
            message: String(e && (e.message || e)),
            failedAt: applied,
            ofOps: ops ? ops.length : 0,
            writes: ctx ? ctx.writes : 0,
            // Everything applied before the failure, ready to be re-applied as
            // a rollback. A script cannot reliably undo its own patch.
            inverse: inverse,
            revision: app.project.revision
        });
    }
}
