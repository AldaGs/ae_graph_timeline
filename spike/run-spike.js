#!/usr/bin/env node
// Write-path latency spike.
//
// Question: if a node graph is the source of truth and continuously patches a
// real AE comp, how long does a patch take to land? Everything else about the
// project is downstream of this number.
//
// Requires: After Effects open, with the EBN Agent panel listening on 7879
// (Window > EBN Agent, from ExtendBlueNode's jsx/agent.jsx).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ping, run, PORT } = require('./client');
const jsx = require('./jsx');

const REPORT = process.env.NTL_REPORT || path.join(os.tmpdir(), 'ntl-spike.json');
const LAYERS = Number(process.env.NTL_LAYERS) || 200;

const readReport = () => {
  try { return JSON.parse(fs.readFileSync(REPORT, 'utf8')); }
  catch (e) { return { reportError: e.message }; }
};

// Run a payload and pair the client-side RTT with the in-AE breakdown.
async function measure(script) {
  try { fs.unlinkSync(REPORT); } catch { /* first run */ }
  const { rttMs, result } = await run(script);
  if (!result.ok) throw new Error(`AE error: ${result.message} (line ${result.line})`);
  return { rttMs, ...readReport() };
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { min: s[0], median: at(0.5), p90: at(0.9), max: s[s.length - 1] };
};

const ms = (n) => (n == null ? '   n/a' : `${n.toFixed(1).padStart(6)} ms`);
const us = (n) => (n == null ? '  n/a' : `${n.toFixed(0).padStart(5)} µs`);

async function main() {
  const results = { when: new Date().toISOString(), layers: LAYERS };

  process.stdout.write(`Contacting AE agent on 127.0.0.1:${PORT} ... `);
  const first = await ping();
  console.log(`ok, AE ${first.result.version}\n`);

  // --- M0: transport floor -------------------------------------------------
  // A ping does no AE work at all, so this is pure socket + the agent's
  // scheduleTask poll interval (60 ms in agent.jsx). Nothing can beat it.
  const pings = [];
  for (let i = 0; i < 30; i++) pings.push((await ping()).rttMs);
  results.ping = stats(pings);
  console.log('M0  transport floor (ping, no AE work)');
  console.log(`      min ${ms(results.ping.min)}   median ${ms(results.ping.median)}   p90 ${ms(results.ping.p90)}   max ${ms(results.ping.max)}\n`);

  // --- setup ---------------------------------------------------------------
  process.stdout.write(`Building "${jsx.COMP_NAME}" with ${LAYERS} layers ... `);
  const s = await measure(jsx.setup(LAYERS));
  console.log(`${s.layers} layers ready\n`);
  results.setup = s;

  // --- M1: eval overhead ---------------------------------------------------
  const noops = [];
  for (let i = 0; i < 15; i++) noops.push((await measure(jsx.noop())).rttMs);
  results.noop = stats(noops);
  console.log('M1  round trip for an empty script (eval + report file, no AE work)');
  console.log(`      min ${ms(results.noop.min)}   median ${ms(results.noop.median)}   p90 ${ms(results.noop.p90)}\n`);

  // --- M2: property writes -------------------------------------------------
  console.log('M2  property writes (opacity), batched in one round trip');
  console.log('      n     rtt        in-AE        per write   undo group');
  results.writes = [];
  for (const n of [1, 10, 50, 200]) {
    if (n > LAYERS) continue;
    for (const undo of [true, false]) {
      const r = await measure(jsx.writeProps(n, undo, 50 + (n % 7)));
      results.writes.push({ n, undo, ...r });
      console.log(`   ${String(n).padStart(4)}  ${ms(r.rttMs)}  ${ms(r.writeUs / 1000)}   ${us(r.usPerWrite)}   ${undo ? 'yes' : 'no'}`);
    }
  }
  console.log();

  // --- M3: the differ ------------------------------------------------------
  // What a reconciler actually does: resolve, read, write only on change.
  console.log('M3  diff pass: resolve + read every property, write only on change');
  console.log('      n     rtt        in-AE        per prop    writes');
  results.diff = [];
  for (const n of [50, 200]) {
    if (n > LAYERS) continue;
    for (const changed of [false, true]) {
      const r = await measure(jsx.diffPass(n, changed));
      results.diff.push({ n, changed, ...r });
      console.log(`   ${String(n).padStart(4)}  ${ms(r.rttMs)}  ${ms(r.totalUs / 1000)}   ${us(r.usPerProp)}   ${String(r.writes).padStart(4)}${changed ? '' : '   (clean graph)'}`);
    }
  }
  console.log();

  // --- M4: structural churn ------------------------------------------------
  console.log('M4  structural: add then remove n solids');
  console.log('      n     rtt        per add     per remove');
  results.structural = [];
  for (const n of [1, 10, 50]) {
    const r = await measure(jsx.structural(n));
    results.structural.push({ n, ...r });
    console.log(`   ${String(n).padStart(4)}  ${ms(r.rttMs)}  ${us(r.usPerAdd)}   ${us(r.usPerRemove)}`);
  }
  console.log();

  const out = path.join(__dirname, 'results.json');
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  verdict(results);
  console.log(`\nRaw numbers: ${out}`);
}

// The go/no-go. A live node view needs a graph edit to land in AE inside the
// interaction budget; anything slower means the graph can only commit on demand.
function verdict(r) {
  const floor = r.ping.median;
  const w = r.writes.find((x) => x.n === 50 && x.undo);
  const cleanDiff = r.diff.find((x) => x.n === 200 && !x.changed);
  console.log('─'.repeat(64));
  console.log(`transport floor .................. ${ms(floor)}  (agent polls every 60 ms)`);
  if (w) console.log(`50-property patch, round trip .... ${ms(w.rttMs)}`);
  if (cleanDiff) console.log(`clean 200-property diff, in AE ... ${ms(cleanDiff.totalUs / 1000)}`);
  const budget = w ? w.rttMs : Infinity;
  console.log('─'.repeat(64));
  if (budget < 100) {
    console.log('VERDICT: live sync is viable on the ExtendScript transport.');
  } else if (budget < 400) {
    console.log('VERDICT: usable for a debounced live view, not for dragging a');
    console.log('         value and watching it track. A native AEGP transport');
    console.log('         is the upgrade path if that is the bar.');
  } else {
    console.log('VERDICT: too slow for live sync. Either move the write path into');
    console.log('         a C++ AEGP with an idle hook, or make the graph commit');
    console.log('         on demand instead of continuously.');
  }
}

main().catch((err) => {
  console.error(`\nSpike failed: ${err.message}`);
  if (/ECONNREFUSED|timeout/.test(err.message)) {
    console.error('\nIs After Effects open with the EBN Agent panel running?');
    console.error('  Window > EBN Agent   (installs from ExtendBlueNode: npm run ... / copy');
    console.error('  jsx/agent.jsx to <AE>/Support Files/Scripts/ScriptUI Panels/)');
  }
  process.exit(1);
});
