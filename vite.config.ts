import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '127.0.0.1', allowedHosts: ['127.0.0.1', 'localhost'] },
  build: { outDir: 'dist' },
});
