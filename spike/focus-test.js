#!/usr/bin/env node
// Why did the poll sweep come back flat at ~281 ms?
//
// Two candidate explanations, and they need separating before either the sweep
// or the S1 floor can be trusted:
//
//   H1  the cfg op never took effect, so every cell ran at the same interval
//   H2  the interval is irrelevant, because AE only services its idle loop at
//       ~280 ms while it is in the background - and the product's node editor
//       is a separate window, so AE is ALWAYS in the background
//
// H2 would cap live sync at ~281 ms no matter what the transport does in
// ExtendScript, which is a product-shaping result rather than a tuning one.

process.env.EBN_AGENT_PORT = process.env.NTL_SWEEP_PORT || '7880';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const client = require('./client');

const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim();

const cfg = (pollMs, ui) => client.send({ op: 'cfg', pollMs, ui });
const stats = () => client.send({ op: 'stats' });

const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { min: s[0], median: s[Math.floor(s.length / 2)], p90: s[Math.floor(s.length * 0.9)], max: s[s.length - 1] };
};
const ms = (n) => `${n.toFixed(1).padStart(6)} ms`;
const show = (label, s) => console.log(`  ${label.padEnd(26)} min ${ms(s.min)}   median ${ms(s.median)}   p90 ${ms(s.p90)}`);

const aePid = () => Number(ps('(Get-Process AfterFX).Id'));
const focusAE = () => ps(`(New-Object -ComObject WScript.Shell).AppActivate(${aePid()}) | Out-Null; Start-Sleep -Milliseconds 400`);
const focusOther = () => ps('(New-Object -ComObject WScript.Shell).AppActivate((Get-Process -Id $PID).Id) | Out-Null; Start-Sleep -Milliseconds 400');
const foregroundIsAE = () => ps(`
Add-Type -Name W -Namespace N -MemberDefinition '
  [DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(System.IntPtr h, out int p);'
$p = 0; [void][N.W]::GetWindowThreadProcessId([N.W]::GetForegroundWindow(), [ref]$p); $p`) === String(aePid());

async function pings(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push((await client.send({ op: 'ping' })).rttMs);
  return stat(out);
}

// AE's own CPU over a window, as a fraction of one core.
// (Measure-Object cannot sum a TimeSpan - read the property directly.)
function cpuPct(seconds) {
  const q = '(Get-Process AfterFX).TotalProcessorTime.TotalMilliseconds';
  const a = Number(ps(q));
  const t0 = Date.now();
  ps(`Start-Sleep -Milliseconds ${seconds * 1000}`);
  return ((Number(ps(q)) - a) / (Date.now() - t0)) * 100;
}

async function main() {
  const results = { when: new Date().toISOString() };

  // --- H1: does cfg actually do anything? ---------------------------------
  console.log('H1  is the cfg op real?\n');
  const before = (await stats()).result;
  const set4 = (await cfg(4, false)).result;
  const readBack = (await stats()).result;
  console.log(`  before ................ poll ${before.pollMs} ms, ui ${before.ui}`);
  console.log(`  cfg(4, false) returned  poll ${set4.pollMs} ms, ui ${set4.ui}`);
  console.log(`  stats now ............. poll ${readBack.pollMs} ms, ui ${readBack.ui}`);
  const cfgWorks = readBack.pollMs === 4 && readBack.ui === false;
  console.log(`  → cfg ${cfgWorks ? 'IS taking effect. H1 rejected.' : 'is NOT taking effect. H1 CONFIRMED - the sweep measured nothing.'}\n`);
  results.cfgWorks = cfgWorks;

  // --- control: is the CPU probe even alive? ------------------------------
  // Every sweep row said 0.0%. A probe that only ever reads zero is broken
  // until proven otherwise, so make AE work and see if the number moves.
  console.log('control  does the CPU probe respond at all?\n');
  const idle = cpuPct(2);
  const busyPromise = client.send({
    op: 'run',
    script: `var t = $.hiresTimer; var acc = 0; while ($.hiresTimer - t < 2000000) { acc += Math.sqrt(acc + 1); }`
  }, 30000);
  const busy = cpuPct(2);
  await busyPromise;
  console.log(`  AE idle ............... ${idle.toFixed(1)}% of a core`);
  console.log(`  AE spinning ........... ${busy.toFixed(1)}% of a core`);
  console.log(`  → probe ${busy > idle + 5 ? 'responds. The 0.0% rows were real: AE was asleep.' : 'is BROKEN - ignore every idleCpuPct in results-poll.json.'}\n`);
  results.cpu = { idle, busy, probeWorks: busy > idle + 5 };

  // --- H2: focus ----------------------------------------------------------
  console.log('H2  does the floor depend on AE having focus?\n');
  for (const pollMs of [60, 4]) {
    await cfg(pollMs, false);
    for (let i = 0; i < 5; i++) await client.send({ op: 'ping' });

    focusOther();
    const bg = await pings(30);
    focusAE();
    const wasAE = foregroundIsAE();
    const fg = await pings(30);
    focusOther();

    console.log(`  poll ${pollMs} ms   (AE actually came forward: ${wasAE ? 'yes' : 'NO - result void'})`);
    show('AE in background', bg);
    show('AE focused', fg);
    console.log(`    → focus is worth ${ms(bg.median - fg.median)}\n`);
    results[`poll${pollMs}`] = { background: bg, focused: fg, focusConfirmed: wasAE };
  }

  await cfg(60, true);
  const out = path.join(__dirname, 'results-focus.json');
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`Raw numbers: ${out}`);
}

main().catch((e) => { console.error(`\nfocus-test failed: ${e.message}`); process.exit(1); });
