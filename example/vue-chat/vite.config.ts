import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  // PGlite ships WebAssembly and locates it relative to its own module URL,
  // which dependency pre-bundling breaks.
  optimizeDeps: {
    exclude: ['@electric-sql/pglite', '@electric-sql/pglite/live', '@electric-sql/pglite/worker'],
  },
  // The multi-tab worker has to stay an ES module in the production build.
  worker: {
    format: 'es',
  },
  // `src/pglite.ts` opens the database with a top-level `await`.
  build: {
    target: 'esnext',
  },
  // Fixed so the two-tab walkthrough in the README always uses the same URL.
  server: {
    port: 5173,
    strictPort: true,
  },
});
