import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
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
