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
    // Opt in for local diagnosis; installed builds omit source maps.
    sourcemap: process.env.NTL_SOURCEMAPS === '1',
  },
  server: { port: 5273 },
  test: {
    environment: 'jsdom',
    restoreMocks: true,
    clearMocks: true,
  },
  resolve: {
    alias: {
      // The reconciler lives outside the panel, and is shared with the offline
      // test suite. It is imported by relative path rather than copied: two
      // copies of graph.js would be two definitions of what a node is.
      '@model': resolve(import.meta.dirname, '../src'),
    },
  },
});
