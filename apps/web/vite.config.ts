import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(root, '../..');

/**
 * The web build (§54). It produces the single bundle that both the browser and the
 * desktop shell load: `dist/web`. The API is reached through a relative `/api` path,
 * proxied to the local API in development so the same code works when the desktop app
 * serves it from an in-process server on a random port.
 */
export default defineConfig({
  root,
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^@aido\/types$/, replacement: path.join(repoRoot, 'packages/types/src/index.ts') },
      { find: /^@aido\/ui$/, replacement: path.join(repoRoot, 'packages/ui/src/index.ts') },
      { find: /^@aido\/providers$/, replacement: path.join(repoRoot, 'packages/providers/src/index.ts') },
    ],
  },
  server: {
    host: '0.0.0.0',
    port: Number(process.env.AIDO_WEB_PORT ?? 5173),
    strictPort: false,
    proxy: {
      '/api': {
        target: process.env.AIDO_API_URL ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
        // SSE must not be buffered by the proxy.
        ws: false,
      },
    },
  },
  preview: { host: '0.0.0.0', port: 4173 },
  build: {
    outDir: path.join(repoRoot, 'dist/web'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'chrome120',
    rollupOptions: { output: { manualChunks: { vendor: ['react', 'react-dom', 'react-router-dom'], data: ['@tanstack/react-query'] } } },
  },
});
