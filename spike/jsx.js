// ExtendScript payloads for the write-path spike. ES3 only.
// Each payload writes a JSON blob to <temp>/ntl-spike.json; the Node side
// reads it to get the in-AE breakdown. RTT is measured on the Node side.

const COMP_NAME = 'NTL Spike';

// Inlined into every payload. $.hiresTimer returns microseconds elapsed
// since the previous read, so reading it once is how you reset it.
const PRELUDE = `
var NTL_REPORT = new File(Folder.temp.fsName + "/ntl-spike.json");
function ntlWrite(o) {
  var parts = [];
  for (var k in o) {
    if (!o.hasOwnProperty(k)) continue;
    var v = o[k];
    parts.push('"' + k + '":' + (typeof v === 'string' ? '"' + String(v).replace(/"/g, "'") + '"' : String(v)));
  }
  NTL_REPORT.open('w'); NTL_REPORT.write('{' + parts.join(',') + '}'); NTL_REPORT.close();
}
function ntlComp() {
  var proj = app.project;
  for (var i = 1; i <= proj.numItems; i++) {
    var it = proj.item(i);
    if (it instanceof CompItem && it.name === ${JSON.stringify(COMP_NAME)}) return it;
  }
  return null;
}
function ntlOpacity(layer) {
  return layer.property("ADBE Transform Group").property("ADBE Opacity");
}
`;

// Build (or top up) the test comp and leave it open in the viewer.
const setup = (layerCount) => `${PRELUDE}
var comp = ntlComp();
if (comp === null) {
  comp = app.project.items.addComp(${JSON.stringify(COMP_NAME)}, 1920, 1080, 1, 10, 24);
}
app.beginUndoGroup("NTL spike setup");
while (comp.numLayers < ${layerCount}) {
  comp.layers.addSolid([0.2, 0.4, 0.9], "s" + (comp.numLayers + 1), 200, 200, 1);
}
app.endUndoGroup();
comp.openInViewer();
ntlWrite({ layers: comp.numLayers, name: comp.name, version: app.version });
`;

// A no-op run: isolates eval + agent overhead from any AE work.
const noop = () => `${PRELUDE}
$.hiresTimer;
var t = $.hiresTimer;
ntlWrite({ evalUs: t });
`;

// n opacity writes. undo=false skips the undo group to price it separately.
const writeProps = (n, undo, value) => `${PRELUDE}
var comp = ntlComp();
var n = Math.min(${n}, comp.numLayers);
var props = [];
for (var i = 1; i <= n; i++) props.push(ntlOpacity(comp.layer(i)));
$.hiresTimer;
${undo ? 'app.beginUndoGroup("NTL spike write");' : ''}
for (var j = 0; j < n; j++) props[j].setValue(${value});
${undo ? 'app.endUndoGroup();' : ''}
var writeUs = $.hiresTimer;
ntlWrite({ n: n, writeUs: writeUs, usPerWrite: writeUs / n });
`;

// The differ's real shape: resolve the property, read it, write only on change.
// changed=false is the common case - an idle diff pass over a clean graph.
const diffPass = (n, changed) => `${PRELUDE}
var comp = ntlComp();
var n = Math.min(${n}, comp.numLayers);
$.hiresTimer;
var writes = 0;
for (var i = 1; i <= n; i++) {
  var p = ntlOpacity(comp.layer(i));
  var current = p.value;
  var desired = ${changed ? 'current === 50 ? 75 : 50' : 'current'};
  if (current !== desired) { p.setValue(desired); writes++; }
}
var us = $.hiresTimer;
ntlWrite({ n: n, writes: writes, totalUs: us, usPerProp: us / n });
`;

// Structural churn: create n solids, then remove them. Priced separately
// because a graph edit that adds a node is a structural patch, not a value one.
const structural = (n) => `${PRELUDE}
var comp = ntlComp();
app.beginUndoGroup("NTL spike structural");
$.hiresTimer;
var made = [];
for (var i = 0; i < ${n}; i++) made.push(comp.layers.addSolid([1, 0, 0], "tmp" + i, 100, 100, 1));
var addUs = $.hiresTimer;
for (var j = 0; j < made.length; j++) made[j].remove();
var removeUs = $.hiresTimer;
app.endUndoGroup();
ntlWrite({ n: ${n}, addUs: addUs, usPerAdd: addUs / ${n}, removeUs: removeUs, usPerRemove: removeUs / ${n} });
`;

module.exports = { COMP_NAME, setup, noop, writeProps, diffPass, structural };
