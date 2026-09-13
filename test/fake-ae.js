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

// After Effects is one JavaScript realm; a VM context is a second one, and
// `value instanceof Array` is false across the boundary. common.jsx uses exactly
// that test to decide whether a property value is a value the graph can diff, so
// an array this file built in Node's realm would read back as unreadable - and
// every array-valued property (position, scale, anchor point) would vanish from
// the read. Array values are therefore built with the CONTEXT's Array.
//
// Not a fidelity compromise: it removes a difference between the fake and AE
// rather than adding one. Set by makeAE, before any layer exists.
let realmArray = Array;
const inRealm = (v) => (Array.isArray(v) ? realmArray.from(v) : v);

class FakeProperty {
  constructor(name, value, over = {}) {
    this.name = name;
    this.matchName = name;
    this._value = inRealm(value);
    this.numKeys = 0;
    this.canSetExpression = true;
    this.expressionEnabled = false;
    this._expression = '';
    this.propertyType = 'PROPERTY';
    this.writes = 0;
    Object.assign(this, over);
  }
  get value() { return this._value; }
  // AE enables a property's expression as a side effect of setting its text, and
  // the reader only reads an expression it believes is enabled. Modelled here,
  // because a fake where the writer's expression is invisible to the reader would
  // make every expression edge look like drift on the next pass.
  get expression() { return this._expression; }
  set expression(text) {
    this._expression = String(text ?? '');
    this.expressionEnabled = this._expression.length > 0;
  }
  setValue(v) {
    // AE throws on both of these; the writer is supposed to check first, so a
    // throw reaching here means the guard is missing.
    if (this.numKeys > 0) throw new Error('cannot set value on a keyframed property');
    if (this.locked) throw new Error('property is locked');
    this._value = inRealm(v);
    this.writes++;
    // Every change to a project moves app.project.revision - S4 measured the
    // read at 2.3 µs and P1.4's whole drift guard is built on it. A fake whose
    // revision only moved when layers came and went would let a guard that
    // never noticed a property edit pass.
    if (this.comp) this.comp.project.revision++;
  }
}

class FakeGroup {
  constructor(props) { this.props = props; }
  property(matchName) { return this.props[matchName] ?? null; }
}

class FakeEffectParade {
  constructor(layer) {
    this.layer = layer;
    this.effects = [];
  }
  get numProperties() { return this.effects.length; }
  property(i) { return this.effects[i - 1] ?? null; }
  canAddProperty(matchName) { return true; }
  addProperty(matchName) {
    const effect = new FakeEffect(this, matchName);
    this.effects.push(effect);
    if (this.layer.comp) this.layer.comp.project.revision++;
    return effect;
  }
}

class FakeEffect {
  constructor(parade, matchName) {
    this.parade = parade;
    this.matchName = matchName;
    this.name = matchName;
    this.props = [];
  }
  get index() { return this.parade.effects.indexOf(this) + 1; }
  get numProperties() { return this.props.length; }
  property(key) {
    if (typeof key === 'number') return this.props[key - 1] ?? null;
    let prop = this.props.find(p => p.matchName === key);
    if (!prop) {
      prop = new FakeProperty(key, 0);
      prop.matchName = key;
      prop.comp = this.parade.layer.comp;
      this.props.push(prop);
    }
    return prop;
  }
  remove() {
    this.parade.effects = this.parade.effects.filter(e => e !== this);
    if (this.parade.layer.comp) this.parade.layer.comp.project.revision++;
  }
}

export class FakeLayer {
  constructor(comp, name, kind = 'solid') {
    this.id = nextId++;          // S3: unique, and it survives a rename
    this.comp = comp;
    this.name = name;
    this.comment = '';
    this.kind = kind;
    this.parent = null;
    this.nullLayer = kind === 'null';
    this.source = null;
    this.enabled = true;
    this.inPoint = 0;
    this.outPoint = 5;
    this.removed = false;
    this._blendingMode = 5220;
    this._label = 0;
    this.effectParade = new FakeEffectParade(this);
    this.transform = new FakeGroup({
      'ADBE Anchor Point': new FakeProperty('Anchor Point', [0, 0]),
      'ADBE Position': new FakeProperty('Position', [960, 540]),
      'ADBE Scale': new FakeProperty('Scale', [100, 100]),
      'ADBE Rotate Z': new FakeProperty('Rotation', 0),
      'ADBE Opacity': new FakeProperty('Opacity', 100),
    });
    for (const p of Object.values(this.transform.props)) p.comp = comp;
  }
  get blendingMode() { return this._blendingMode; }
  set blendingMode(v) { this._blendingMode = v; if (this.comp) this.comp.project.revision++; }
  get label() { return this._label; }
  set label(v) { this._label = v; if (this.comp) this.comp.project.revision++; }
  
  // A position, not an identity - which is exactly why nothing in the reconciler
  // addresses a layer by it. Derived rather than stored so a remove() cannot
  // leave a stale one behind.
  get index() { return this.comp._layers.indexOf(this) + 1; }
  property(matchName) {
    if (matchName === 'ADBE Transform Group') return this.transform;
    if (matchName === 'ADBE Effect Parade') return this.effectParade;
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
    for (const [k, v] of Object.entries(props)) l.prop(k)._value = inRealm(v);
    return l;
  }
  byTag(tag) { return this._layers.find((l) => l.comment.trim() === `ntl:${tag}`); }
}

export function makeAE() {
  const project = { revision: 1 };
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

  // reader.jsx asks what kind of layer it is holding. Nothing in this fake is an
  // instance of these, which is the right answer: a solid IS a footage layer in
  // After Effects, so 'footage' is what a real read returns for one.
  class CameraLayer {}
  class LightLayer {}
  class TextLayer {}
  class ShapeLayer {}

  const sandbox = {
    app,
    CompItem: FakeComp,
    CameraLayer,
    LightLayer,
    TextLayer,
    ShapeLayer,
    PropertyType: { PROPERTY: 'PROPERTY', INDEXED_GROUP: 'INDEXED_GROUP', NAMED_GROUP: 'NAMED_GROUP' },
    BlendingMode: { NORMAL: 5220, MULTIPLY: 5222, SCREEN: 5223, ADD: 5224, LIGHTEN: 5225 },
    Date,
    Error,
    isFinite,
    String,
    Number,
    // $.hiresTimer reports microseconds since it was last read.
    $: { get hiresTimer() { return 1000; } },
  };

  const ctx = createContext(sandbox);

  // The comp is built only now: its property values have to come from the
  // context's Array, and the context has to exist first.
  realmArray = runInContext('Array', ctx);
  const comp = new FakeComp(project);
  project.activeItem = comp;
  // The reader and the writer both find a comp BY NAME when given one, walking
  // app.project.item(i). A fake with no item list would silently exercise only
  // the activeItem path.
  project.numItems = 1;
  project.item = (i) => (i === 1 ? comp : null);
  project.layerByID = (id) => comp._layers.find((l) => l.id === id) ?? null;

  for (const file of ['common.jsx', 'reader.jsx', 'patch.jsx']) {
    runInContext(readFileSync(join(JSX, file), 'utf8'), ctx, { filename: file });
  }

  const api = {
    app, project, comp, undo, ctx,
    // Run a call the real panel would hand to evalScript, and get the string
    // back exactly as evalScript would.
    eval: (source) => runInContext(source, ctx),
  };

  // The CEP bridge's shape, so src/loop.js can be driven offline against the
  // real reader and the real writer. evalScript is asynchronous in CEP and
  // returns a string; both are modelled, because the loop's whole job is
  // sequencing those round trips.
  api.host = {
    calls: [],
    async evalScript(source) {
      api.host.calls.push(source);
      if (api.host.before) {
        // A hook returning a string stands in for the host's reply, which is how
        // a transport failure actually presents: evalScript does not reject, it
        // hands back a string that is not JSON.
        const stubbed = await api.host.before(source);
        if (typeof stubbed === 'string') return stubbed;
      }
      let out;
      try {
        out = runInContext(source, ctx);
      } catch (e) {
        // evalScript reports a host-side throw as this exact string, and the
        // panel is supposed to survive it rather than see an exception.
        return 'EvalScript error.';
      }
      return typeof out === 'string' ? out : String(out);
    },
  };

  return api;
}
