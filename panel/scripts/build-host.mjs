// Bundles the host side into one ExtendScript file.
//
// CEP's ScriptPath takes exactly one file, and `#include` resolves relative to
// wherever the panel is INSTALLED - which, once the panel is junctioned into the
// CEP extensions folder, is no longer next to the repo's jsx/ directory. So the
// three files are concatenated here instead, in dependency order, and the result
// is the only thing the manifest points at.
//
// They are concatenated rather than copied because the panel must run the SAME
// text the offline suite runs and the in-AE checks ran. A copy would be a fourth
// place for common.jsx to drift.
//
// This runs AFTER vite build, not before: Vite empties dist/ on the way in, so a
// host.jsx written first is deleted a second later. The symptom is a panel that
// loads, draws, and cannot talk to After Effects - with nothing in any log.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const JSX = resolve(here, '../../jsx');
const OUT = resolve(here, '../dist/host.jsx');

// Order matters: common.jsx declares the JSON emitter, the tag helpers and the
// property table that the others call.
const FILES = ['common.jsx', 'reader.jsx', 'patch.jsx', 'select.jsx'];

const banner = `// GENERATED - do not edit.
//
// Built by panel/scripts/build-host.mjs from jsx/${FILES.join(', jsx/')}.
// Edit those; this file is rebuilt on every panel build.
//
// Built ${new Date().toISOString()}
`;

const parts = FILES.map((file) => {
  const text = readFileSync(resolve(JSX, file), 'utf8');
  return `\n// ===================================================== jsx/${file}\n\n${text}`;
});

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, banner + parts.join('\n'), 'utf8');

const lines = (banner + parts.join('\n')).split('\n').length;
console.log(`  host.jsx  ${FILES.join(' + ')}  ->  dist/host.jsx  (${lines} lines)`);
