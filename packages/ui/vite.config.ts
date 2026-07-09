import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.MO_API_TARGET || 'http://localhost:4318';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/v1': { target, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
