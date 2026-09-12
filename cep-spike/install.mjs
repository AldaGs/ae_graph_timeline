// Installs the spike panel into the Adobe CEP extensions folder so After
// Effects loads it as an unsigned dev panel. Adapted from ExtendBlueNode's
// scripts/install-cep.mjs.
//
// Requires PlayerDebugMode = 1 (see `npm run cep:enable-debug` in
// _extendBlueNode, or the reg commands this script prints if it is missing).
//
// Symlinking on Windows needs Developer Mode or an elevated terminal; this
// falls back to copying, which is fine for a static spike with no build step.

import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, cpSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE_ID = 'com.nodetimeline.spike';

function cepExtensionsDir() {
  if (platform() === 'win32') {
    const appData = process.env.APPDATA || resolve(homedir(), 'AppData/Roaming');
    return resolve(appData, 'Adobe/CEP/extensions');
  }
  return resolve(homedir(), 'Library/Application Support/Adobe/CEP/extensions');
}

// An unsigned panel is silently ignored without this, with no error anywhere -
// so check it before installing rather than debugging an empty Extensions menu.
function checkDebugMode() {
  if (platform() !== 'win32') return true;
  const versions = ['11', '10'];
  const missing = [];
  for (const v of versions) {
    try {
      const out = execFileSync('reg', ['query', `HKCU\\Software\\Adobe\\CSXS.${v}`, '/v', 'PlayerDebugMode'], { encoding: 'utf8' });
      if (!/PlayerDebugMode\s+REG_SZ\s+1/.test(out)) missing.push(v);
    } catch {
      missing.push(v);
    }
  }
  if (missing.length === versions.length) {
    console.warn('\n  PlayerDebugMode is not set. After Effects will ignore this panel.');
    console.warn('  Run once, then restart AE:\n');
    for (const v of versions) {
      console.warn(`    reg add "HKCU\\Software\\Adobe\\CSXS.${v}" /v PlayerDebugMode /t REG_SZ /d 1 /f`);
    }
    console.warn('');
    return false;
  }
  if (missing.length) console.log(`  PlayerDebugMode set (missing only for CSXS.${missing.join(', CSXS.')} — fine)`);
  else console.log('  PlayerDebugMode set for CSXS.10 and CSXS.11');
  return true;
}

const target = resolve(cepExtensionsDir(), BUNDLE_ID);

checkDebugMode();

if (lstatSync(target, { throwIfNoEntry: false })) {
  console.log(`  Removing existing: ${target}`);
  rmSync(target, { recursive: true, force: true });
}
mkdirSync(dirname(target), { recursive: true });

try {
  symlinkSync(__dirname, target, 'junction');
  console.log(`  Linked  ${__dirname}\n       -> ${target}`);
} catch (err) {
  console.warn(`  Symlink failed (${err.code}); copying instead.`);
  cpSync(__dirname, target, { recursive: true });
  console.log(`  Copied  ${__dirname}\n       -> ${target}`);
  console.log('  (a copy, so re-run this after any edit)');
}

console.log('\n  Next: restart After Effects, then Window > Extensions > Node Timeline Spike');
console.log('  DevTools while the panel is open: http://localhost:8090\n');
