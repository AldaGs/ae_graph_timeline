// Shared ground for the reader and the writer.
//
// The property table in particular lives here and nowhere else. The graph speaks
// prop names ("opacity"); After Effects speaks matchNames ("ADBE Opacity"). If
// the reader and the writer each kept their own copy of that mapping they could
// disagree about what "opacity" means - and the failure would look like drift,
// not like a bug.
//
// The panel must evaluate this file BEFORE reader.jsx or patch.jsx.
//
// ES3 only. No regex literals containing backslashes; prefer split/join.
// Pre-flight with tools/jsx_check.py.

// ------------------------------------------------------------------ JSON out
//
// ExtendScript has no JSON global, and evalScript can only hand back a string.

function ntlrEscape(v) {
    var s = String(v);
    s = s.split('\\').join('\\\\');
    s = s.split('"').join('\\"');
    s = s.split('\r').join('\\n');
    s = s.split('\n').join('\\n');
    s = s.split('\t').join('\\t');
    return s;
}

function ntlrVal(v) {
    if (v === null || v === undefined) return 'null';
    var t = typeof v;
    if (t === 'number') return isFinite(v) ? String(v) : 'null';
    if (t === 'boolean') return v ? 'true' : 'false';
    if (v instanceof Array) {
        var parts = [];
        for (var i = 0; i < v.length; i++) parts.push(ntlrVal(v[i]));
        return '[' + parts.join(',') + ']';
    }
    if (t === 'object') {
        var kv = [];
        for (var k in v) {
            if (!v.hasOwnProperty(k)) continue;
            if (v[k] === undefined) continue;
            kv.push('"' + ntlrEscape(k) + '":' + ntlrVal(v[k]));
        }
        return '{' + kv.join(',') + '}';
    }
    return '"' + ntlrEscape(v) + '"';
}

// ------------------------------------------------------------------ identity

var NTLR_TAG_PREFIX = 'ntl:';

function ntlrTrim(s) {
    var out = String(s);
    while (out.length && (out.charAt(0) === ' ' || out.charAt(0) === '\t' || out.charAt(0) === '\n' || out.charAt(0) === '\r')) {
        out = out.slice(1);
    }
    while (out.length) {
        var last = out.charAt(out.length - 1);
        if (last !== ' ' && last !== '\t' && last !== '\n' && last !== '\r') break;
        out = out.slice(0, -1);
    }
    return out;
}

function ntlrTagFor(nodeId) {
    return NTLR_TAG_PREFIX + nodeId;
}

function ntlrNodeIdFromTag(comment) {
    if (typeof comment !== 'string') return null;
    var s = ntlrTrim(comment);
    if (s.length <= NTLR_TAG_PREFIX.length) return null;
    if (s.slice(0, NTLR_TAG_PREFIX.length) !== NTLR_TAG_PREFIX) return null;
    return s.slice(NTLR_TAG_PREFIX.length);
}

// ---------------------------------------------------------------- properties

var NTLR_TRANSFORM = [
    ['anchorPoint', 'ADBE Anchor Point'],
    ['position',    'ADBE Position'],
    ['scale',       'ADBE Scale'],
    ['rotation',    'ADBE Rotate Z'],
    ['opacity',     'ADBE Opacity']
];

function ntlrMatchName(propName) {
    for (var i = 0; i < NTLR_TRANSFORM.length; i++) {
        if (NTLR_TRANSFORM[i][0] === propName) return NTLR_TRANSFORM[i][1];
    }
    return null;
}

// AE hands back a Number, an Array, or something exotic (a Shape, a MarkerValue).
// Only the first two are values the graph can diff; anything else is reported
// rather than coerced into a lie.
function ntlrPlain(value) {
    if (typeof value === 'number') return isFinite(value) ? value : null;
    if (value instanceof Array) {
        var out = [];
        for (var i = 0; i < value.length; i++) {
            var n = value[i];
            if (typeof n !== 'number' || !isFinite(n)) return null;
            out.push(n);
        }
        return out;
    }
    return null;
}

// ------------------------------------------------------------------ scanning
//
// S3 measured app.project.layerByID() at 71.5 µs per call against 0.48 ms for a
// whole 200-layer scan. One scan beats seven lookups, and every pass here needs
// all of them anyway.
function ntlrScanTags(comp) {
    var map = {};        // nodeId -> layer
    var dupes = {};      // nodeId -> how many carry that tag
    for (var i = 1; i <= comp.numLayers; i++) {
        var l = comp.layer(i);
        var tag = ntlrNodeIdFromTag(l.comment);
        if (tag === null) continue;
        if (map[tag] === undefined) {
            map[tag] = l;
            dupes[tag] = 1;
        } else {
            dupes[tag]++;
        }
    }
    return { byTag: map, counts: dupes };
}
