import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Single source of truth: read version from the root package.json at build
// time so the GUI never drifts from the released package version.
const pkgVersion = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')).version;

export default defineConfig({
  // Relative asset paths so the built index.html loads correctly under
  // Electron's file:// loading (absolute "/assets/..." resolves to fs root).
  base: './',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:21317',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Split vendor deps into a stable chunk for better long-term caching
        // and to keep each entry under the 500 kB chunk-size warning.
        manualChunks(id) {
          if (id.includes('node_modules')) return 'vendor';
          return undefined;
        },
      },
    },
  },
});
