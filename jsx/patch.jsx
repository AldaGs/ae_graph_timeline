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
    var l = ctx.byTag[nodeId];
    if (l === undefined) throw ntlpFail('no layer carries the tag "' + nodeId + '"');
    if (ctx.counts[nodeId] > 1) {
        if (nativeId !== undefined && nativeId !== null) {
            for (var i = 1; i <= ctx.comp.numLayers; i++) {
                if (ctx.comp.layer(i).id === nativeId) return ctx.comp.layer(i);
            }
            throw ntlpFail('no layer found with id ' + nativeId + ' for tag "' + nodeId + '"');
        }
        // S3: a duplicated layer carries the same comment. The diff already
        // warns; the writer refuses outright, because writing to the wrong one
        // of an ambiguous pair is exactly the silent corruption we are here to
        // prevent.
        throw ntlpFail(ctx.counts[nodeId] + ' layers carry the tag "' + nodeId + '"; refusing to guess');
    }
    return l;
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
        layer = comp.layers.addText('');
    } else {
        layer = comp.layers.addSolid([0.5, 0.5, 0.5], op.name || op.node,
                                     comp.width, comp.height, 1);
    }
    layer.name = op.name || op.node;
    // The tag is what makes the layer findable again, so it is written in the
    // same undo group as the creation. A created-but-untagged layer would be
    // indistinguishable from one of the user's own.
    layer.comment = ntlrTagFor(op.node);

    ctx.byTag[op.node] = layer;
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
    layer.remove();
    delete ctx.byTag[op.node];
    delete ctx.counts[op.node];
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
    // op.tags is the desired top-to-bottom order of managed layers.
    // To achieve this without scrambling unmanaged layers unnecessarily,
    // we iterate the desired array backward, and move each layer above the
    // lowest possible remaining managed layer.
    // Wait, the simplest robust way to sort an interleaved subset is to find the
    // actual layer instances in AE in their current order, and just re-insert them 
    // in the new order at the exact indices they occupied.
    // E.g. managed layers are at index 2, 5, 8. 
    // We want the node array [A, B, C] to go into indices 2, 5, 8.
    // So A goes to 2, B goes to 5, C goes to 8.
    
    // 1. Gather all managed layer instances that are part of this reorder, and their current indices.
    var currentIndices = [];
    var layersById = {};
    for (var i = 1; i <= ctx.comp.numLayers; i++) {
        var layer = ctx.comp.layer(i);
        var tag = ntlrTag(layer.comment);
        // Only consider layers that are in op.tags
        for (var j = 0; j < op.tags.length; j++) {
            if (op.tags[j] === tag && ctx.counts[tag] === 1) {
                currentIndices.push(i);
                layersById[tag] = layer;
                break;
            }
        }
    }
    
    // Sort currentIndices just in case (AE is 1-based, top-to-bottom)
    currentIndices.sort(function(a, b) { return a - b; });
    
    // 2. Now place the desired layers into these slots.
    // Because moving layers shifts indices, we work bottom-up.
    // The lowest desired layer (last in op.tags) goes to the highest index (last in currentIndices).
    // If we move the bottom-most layer into position first, it doesn't affect the indices of the slots above it.
    for (var k = op.tags.length - 1; k >= 0; k--) {
        var tagToMove = op.tags[k];
        var targetIndex = currentIndices[k];
        var layerToMove = layersById[tagToMove];
        
        if (!layerToMove) continue; // Layer might have been deleted or missing
        
        // Move it before the layer that is currently at targetIndex + 1
        // If targetIndex is the very bottom (comp.numLayers), we move it to the end.
        if (targetIndex === ctx.comp.numLayers) {
            layerToMove.moveToEnd();
        } else {
            // It goes above whatever is currently at targetIndex.
            // Wait, if we are working bottom-up, placing it above (targetIndex + 1) works because
            // whatever is at targetIndex+1 and below is already finalized.
            var anchor = ctx.comp.layer(targetIndex + 1);
            if (layerToMove.index !== targetIndex) {
                // If it's already at targetIndex, no need to move.
                // Note: if it's currently BELOW the anchor, moving it BEFORE the anchor puts it at targetIndex.
                // If it's currently ABOVE the anchor, moving it BEFORE the anchor ALSO puts it at targetIndex.
                layerToMove.moveBefore(anchor);
            }
        }
    }
    
    // A single revert op that puts them back the way they were
    return { op: 'reorder', tags: op.current, current: op.tags };
}


function ntlpSetComment(ctx, op) {
    var layer = ntlpLayer(ctx, op.node, op.nativeId);
    var before = layer.comment;
    layer.comment = op.comment;
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
 */
function NTL_ApplyPatch(compName, ops, label, expectRevision) {
    var started = false;
    var ctx = null;
    var applied = 0;
    var inverse = [];
    try {
        var comp = ntlpFindComp(compName);
        if (!comp) return ntlrVal({ ok: false, message: 'no composition' });
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
        ctx = { comp: comp, byTag: scan.byTag, counts: scan.counts,
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
