import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// A CEP panel is loaded from the filesystem, not from a server, so every asset
// path has to be relative - an absolute /assets/… resolves to the drive root and
// the panel comes up blank with nothing in any log.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The panel is read straight off disk by a browser engine with no source
    // server, so a sourcemap is the difference between a stack trace and a
    // minified one when something fails inside After Effects.
    sourcemap: true,
  },
  server: { port: 5273 },
  resolve: {
    alias: {
      // The reconciler lives outside the panel, and is shared with the offline
      // test suite. It is imported by relative path rather than copied: two
      // copies of graph.js would be two definitions of what a node is.
      '@model': resolve(import.meta.dirname, '../src'),
    },
  },
});
