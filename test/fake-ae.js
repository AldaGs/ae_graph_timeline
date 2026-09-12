// A fake After Effects, just large enough to run jsx/patch.jsx for real.
//
// ExtendScript is ES3, and ES3 is valid JavaScript - so the actual writer can be
// loaded into a VM context and executed against a mock object model. That is
// worth far more than testing a description of the writer: the code under test
// here is the same text After Effects will run.
//
// What this CANNOT prove is that After Effects behaves like this mock. Where the
// mock encodes a real AE behaviour (a keyframed property refusing setValue, a
// layer.id surviving a rename) it is written from what the P0 spikes measured,
// and the in-AE pass is still owed. Where it is merely convenient, it is marked.

import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const JSX = join(dirname(fileURLToPath(import.meta.url)), '..', 'jsx');

let nextId = 500;

class FakeProperty {
  constructor(name, value, over = {}) {
    this.name = name;
    this._value = value;
    this.numKeys = 0;
    this.canSetExpression = true;
    this.expressionEnabled = false;
    this.expression = '';
    this.propertyType = 'PROPERTY';
    this.writes = 0;
    Object.assign(this, over);
  }
  get value() { return this._value; }
  setValue(v) {
    // AE throws on both of these; the writer is supposed to check first, so a
    // throw reaching here means the guard is missing.
    if (this.numKeys > 0) throw new Error('cannot set value on a keyframed property');
    if (this.locked) throw new Error('property is locked');
    this._value = v;
    this.writes++;
  }
}

class FakeGroup {
  constructor(props) { this.props = props; }
  property(matchName) { return this.props[matchName] ?? null; }
}

export class FakeLayer {
  constructor(comp, name, kind = 'solid') {
    this.id = nextId++;          // S3: unique, and it survives a rename
    this.comp = comp;
    this.name = name;
    this.comment = '';
    this.kind = kind;
    this.parent = null;
    this.enabled = true;
    this.inPoint = 0;
    this.outPoint = 5;
    this.removed = false;
    this.transform = new FakeGroup({
      'ADBE Anchor Point': new FakeProperty('Anchor Point', [0, 0]),
      'ADBE Position': new FakeProperty('Position', [960, 540]),
      'ADBE Scale': new FakeProperty('Scale', [100, 100]),
      'ADBE Rotate Z': new FakeProperty('Rotation', 0),
      'ADBE Opacity': new FakeProperty('Opacity', 100),
    });
  }
  property(matchName) {
    if (matchName === 'ADBE Transform Group') return this.transform;
    return null;
  }
  prop(name) {
    const map = { anchorPoint: 'ADBE Anchor Point', position: 'ADBE Position',
                  scale: 'ADBE Scale', rotation: 'ADBE Rotate Z', opacity: 'ADBE Opacity' };
    return this.transform.property(map[name]);
  }
  remove() {
    this.removed = true;
    this.comp._layers = this.comp._layers.filter((l) => l !== this);
    this.comp.project.revision++;
  }
}

export class FakeComp {
  constructor(project, name = 'Shot 01') {
    this.project = project;
    this.name = name;
    this.id = 1;
    this.width = 1920;
    this.height = 1080;
    this.duration = 10;
    this.frameRate = 24;
    this._layers = [];
    const self = this;
    this.layers = {
      addSolid(color, name) { return self._add(new FakeLayer(self, name, 'solid')); },
      addNull() { return self._add(new FakeLayer(self, 'Null 1', 'null')); },
      addText() { return self._add(new FakeLayer(self, 'Text', 'text')); },
    };
  }
  _add(layer) { this._layers.push(layer); this.project.revision++; return layer; }
  get numLayers() { return this._layers.length; }
  layer(i) { return this._layers[i - 1]; }
  add(name, { comment = '', props = {} } = {}) {
    const l = this._add(new FakeLayer(this, name));
    l.comment = comment;
    for (const [k, v] of Object.entries(props)) l.prop(k)._value = v;
    return l;
  }
  byTag(tag) { return this._layers.find((l) => l.comment.trim() === `ntl:${tag}`); }
}

export function makeAE() {
  const project = { revision: 1, numItems: 0, item: () => null };
  const comp = new FakeComp(project);
  project.activeItem = comp;

  const undo = { groups: [], open: 0, maxOpen: 0 };

  const app = {
    project,
    beginUndoGroup(label) {
      undo.open++;
      undo.maxOpen = Math.max(undo.maxOpen, undo.open);
      undo.groups.push(label);
    },
    endUndoGroup() {
      // AE tolerates this; the test wants to SEE it, because an unbalanced pair
      // is exactly the bug that swallows the user's next actions into ours.
      if (undo.open === 0) { undo.unbalanced = true; return; }
      undo.open--;
    },
  };

  const sandbox = {
    app,
    CompItem: FakeComp,
    Error,
    isFinite,
    String,
    Number,
    // $.hiresTimer reports microseconds since it was last read.
    $: { get hiresTimer() { return 1000; } },
  };

  const ctx = createContext(sandbox);
  for (const file of ['common.jsx', 'patch.jsx']) {
    runInContext(readFileSync(join(JSX, file), 'utf8'), ctx, { filename: file });
  }

  return {
    app, project, comp, undo, ctx,
    // Run a call the real panel would hand to evalScript, and get the string
    // back exactly as evalScript would.
    eval: (source) => runInContext(source, ctx),
  };
}
