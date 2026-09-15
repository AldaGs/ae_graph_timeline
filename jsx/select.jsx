// M4.9 — the selection bridge.
//
// Selecting a node on the canvas should mean what selecting a layer in the
// timeline means, because After Effects' own panels follow the selection and
// nothing else: Effect Controls shows the selected layer's effects, and the
// Properties panel shows its properties. Without this, a node with effects on
// it could be selected in the graph and there was no way to reach those effects
// in the application that actually renders them.
//
// Its own file, and not part of reader.jsx or patch.jsx, because it fits
// neither contract. reader.jsx states that it writes nothing; this writes.
// patch.jsx states that it is the only file that writes to the user's project,
// in one undo group per patch; this writes no project state and must NOT take
// an undo entry:
//
//   - layer.selected is view state. It does not mark the project modified, and
//     After Effects does not put it on the undo stack.
//   - it does not move app.project.revision, so P1.4's drift gate cannot see
//     it - which is why the panel's comp switch watch exists at all, and which
//     is exactly what makes this safe to call on every selection change.
//
// An undo group here would be the bug: one entry out of S5's 99 spent on
// clicking a node.
//
// ES3 only. No regex literals containing backslashes; prefer split/join.
// Pre-flight with tools/jsx_check.py.

// Requires jsx/common.jsx (the JSON emitter and the tag parser).

/**
 * Select exactly the layers carrying these node tags, and nothing else.
 *
 * @param compId  the comp the panel is reconciling. Refused if it is not the
 *                active one: selecting inside a comp the user is not looking at
 *                changes what their next keystroke applies to.
 * @param tags    node ids, as a real array literal - ExtendScript has no JSON
 *                parser, so the panel builds the call, not a string to parse
 * @param exclusive  clear the selection of layers we did not ask for. The panel
 *                wants one layer selected to mirror one selected node; a caller
 *                that is adding to a selection passes false.
 */
function NTL_SelectLayers(compId, tags, exclusive) {
    try {
        var active = app.project && app.project.activeItem;
        if (!active || !(active instanceof CompItem)) {
            return ntlrVal({ ok: false, message: 'no active composition' });
        }
        if (compId !== undefined && compId !== null && active.id !== compId) {
            return ntlrVal({ ok: false, message: 'active composition is not the one being reconciled',
                             expectedCompId: compId, actualCompId: active.id });
        }
        if (!tags || !(tags instanceof Array)) {
            return ntlrVal({ ok: false, message: 'no tags array' });
        }

        var wanted = {};
        for (var t = 0; t < tags.length; t++) {
            if (typeof tags[t] === 'string' && tags[t].length) wanted[tags[t]] = true;
        }

        var selected = 0;
        var cleared = 0;
        var clearOthers = exclusive === undefined ? true : !!exclusive;

        for (var i = 1; i <= active.numLayers; i++) {
            var layer = active.layer(i);
            var tag = ntlrNodeIdFromTag(layer.comment);
            var want = tag !== null && wanted[tag] === true;
            if (want) {
                // Assigned only when it differs. After Effects rebuilds panel
                // state on a selection write, so re-asserting a selection the
                // user already has is visible work for no change.
                if (!layer.selected) layer.selected = true;
                selected++;
                continue;
            }
            // The user's own layers are never deselected by us. They did not ask
            // the graph to manage them, and clearing their selection would take
            // away a selection the graph had no part in making.
            if (!clearOthers || tag === null) continue;
            if (layer.selected) { layer.selected = false; cleared++; }
        }

        return ntlrVal({ ok: true, selected: selected, cleared: cleared, compId: active.id });
    } catch (e) {
        return ntlrVal({ ok: false, message: String(e && (e.message || e)), line: e && e.line });
    }
}

/**
 * Reveal the selected layer's effects in After Effects' own Effect Controls.
 *
 * Separate from the selection, and never automatic: Effect Controls follows the
 * selection on its own once the panel is open, and opening a panel is the
 * user's decision about their workspace, not ours to make on a click.
 */
function NTL_ShowEffectControls() {
    try {
        // 2163 is Effect Controls. The name lookup is the defensive fallback,
        // for the same reason as in NTL_ShowNewCompDialog: findMenuCommandId is
        // language-package dependent, so Adobe recommends the fixed id first.
        var commandId = app.findMenuCommandId('Effect Controls') || 2163;
        if (!commandId) throw new Error('After Effects did not expose the Effect Controls command');
        app.executeCommand(commandId);
        return ntlrVal({ ok: true });
    } catch (e) {
        return ntlrVal({ ok: false, message: String(e && (e.message || e)), line: e && e.line });
    }
}
