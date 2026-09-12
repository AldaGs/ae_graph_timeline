#!/usr/bin/env node
// Poll sweep — how much of the ~94 ms transport floor is just the agent's
// scheduleTask interval and its per-request ScriptUI redraw?
//
// The main spike showed a 200-property patch costs 107 ms, of which only ~13 ms
// is After Effects doing work. This sweeps the two knobs on the other 94 ms:
//
//   pollMs   app.scheduleTask interval (jsx/agent.jsx hardcodes 60)
//   ui       whether the panel redraws its status inside every request
//
// and prices the tax a tight poll puts on an idle AE.
//
// Requires: AE open, and agent-poll.jsx running (File > Scripts > Run Script File).

process.env.EBN_AGENT_PORT = process.env.NTL_SWEEP_PORT || '7880';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const client = require('./client');
const { run } = client;

const COMP = 'NTL Spike';
const POLLS = (process.env.NTL_POLLS || '60,30,16,8,4').split(',').map(Number);
const PROPS = Number(process.env.NTL_PROPS) || 50;

const cfg = (pollMs, ui) => client.send({ op: 'cfg', pollMs, ui });
const ping = () => client.send({ op: 'ping' });
const stats = () => client.send({ op: 'stats' });

// A realistic value patch: one undo group, n opacity writes, no report file.
// The main spike proved the undo group is the faster shape at this size.
const patch = (n, value) => `
var proj = app.project, comp = null;
for (var i = 1; i <= proj.numItems; i++) {
  var it = proj.item(i);
  if (it instanceof CompItem && it.name === ${JSON.stringify(COMP)}) { comp = it; break; }
}
if (comp === null) throw new Error('comp ${COMP} missing - run run-spike.js first');
var n = Math.min(${n}, comp.numLayers);
app.beginUndoGroup('NTL poll sweep');
for (var j = 1; j <= n; j++) {
  comp.layer(j).property('ADBE Transform Group').property('ADBE Opacity').setValue(${value});
}
app.endUndoGroup();
`;

const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { min: s[0], median: at(0.5), p90: at(0.9), max: s[s.length - 1] };
};

// Fraction of one core AE burns while nobody is talking to it.
//
// NOTE: the original used Measure-Object -Sum over TotalProcessorTime, which is
// a TimeSpan and cannot be summed - it errors and yields 0. Every idleCpuPct in
// results-poll.json is therefore 0.0 and MEANINGLESS, not a real measurement.
function idleCpuPercent(seconds = 3) {
  const q = "(Get-Process AfterFX).TotalProcessorTime.TotalMilliseconds";
  const read = () => Number(execFileSync('powershell', ['-NoProfile', '-Command', q], { encoding: 'utf8' }).trim());
  const a = read();
  const t0 = Date.now();
  execFileSync('powershell', ['-NoProfile', '-Command', `Start-Sleep -Milliseconds ${seconds * 1000}`]);
  const b = read();
  return ((b - a) / (Date.now() - t0)) * 100;
}

const ms = (n) => `${n.toFixed(1).padStart(6)} ms`;

async function main() {
  const first = await ping();
  console.log(`Sweep agent up on 127.0.0.1:${client.PORT} (poll ${first.result.pollMs} ms)\n`);

  console.log(`Each cell: 40 pings for the floor, 8 patches of ${PROPS} properties.`);
  console.log('idle% is one core, AE untouched for 3 s.\n');
  console.log('  poll   ui    ping median      p90       patch median      p90     idle%');
  console.log('  ' + '─'.repeat(74));

  const rows = [];
  for (const pollMs of POLLS) {
    for (const uiOn of [true, false]) {
      await cfg(pollMs, uiOn);
      // let the rescheduled task settle before trusting a number
      for (let i = 0; i < 5; i++) await ping();

      const pings = [];
      for (let i = 0; i < 40; i++) pings.push((await ping()).rttMs);

      const patches = [];
      for (let i = 0; i < 8; i++) patches.push((await run(patch(PROPS, 40 + i))).rttMs);

      const idle = idleCpuPercent(3);
      const row = { pollMs, ui: uiOn, ping: stat(pings), patch: stat(patches), idleCpuPct: idle };
      rows.push(row);
      console.log(
        `  ${String(pollMs).padStart(4)}   ${uiOn ? 'on ' : 'off'}  ${ms(row.ping.median)}  ${ms(row.ping.p90)}` +
        `    ${ms(row.patch.median)}  ${ms(row.patch.p90)}   ${idle.toFixed(1).padStart(5)}`
      );
    }
  }

  const served = (await stats()).result;
  console.log(`\n  agent served ${served.requests} requests\n`);

  // Restore the default so a later run does not inherit a tuned agent.
  await cfg(60, true);

  const best = rows.reduce((a, b) => (b.patch.median < a.patch.median ? b : a));
  const base = rows.find((r) => r.pollMs === 60 && r.ui);
  const out = path.join(__dirname, 'results-poll.json');
  fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), props: PROPS, rows }, null, 2));

  console.log('─'.repeat(76));
  if (base) console.log(`shipping config (poll 60, ui on) .... ${ms(base.patch.median)} per ${PROPS}-property patch`);
  console.log(`best config (poll ${best.pollMs}, ui ${best.ui ? 'on' : 'off'}) ....... ${ms(best.patch.median)}   idle ${best.idleCpuPct.toFixed(1)}% of a core`);
  if (base) {
    const gain = base.patch.median - best.patch.median;
    console.log(`\ntuning the transport alone buys ${ms(gain)} (${(100 * gain / base.patch.median).toFixed(0)}%), with no C++.`);
  }
  if (best.patch.median < 40) {
    console.log('VERDICT: fast enough to drag a value and watch AE track it.');
  } else if (best.patch.median < 100) {
    console.log('VERDICT: a good debounced live view. Drag-tracking needs the native transport.');
  } else {
    console.log('VERDICT: the floor is not the poll loop. Look elsewhere before porting.');
  }
  console.log(`\nRaw numbers: ${out}`);
}

main().catch((err) => {
  console.error(`\nSweep failed: ${err.message}`);
  if (/ECONNREFUSED|timeout/.test(err.message)) {
    console.error('\nRun agent-poll.jsx in AE:  File > Scripts > Run Script File...');
    console.error(`  ${path.join(__dirname, 'agent-poll.jsx')}`);
  }
  process.exit(1);
});
