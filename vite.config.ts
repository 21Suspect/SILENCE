import { defineConfig } from 'vite';

// A static site: index.html, game/ and public/. `npm run build` writes dist/, which any static host can serve.
export default defineConfig({
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
  // The terrain worker is started with { type: 'module' }.
  worker: { format: 'es' },
});
