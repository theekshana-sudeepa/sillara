import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: {
    port: 5273,
    proxy: { '/api': { target: 'http://localhost:4100', changeOrigin: true } },
  },
  // `vite preview` serves the real production build. Without the same proxy
  // every API call 404s, which makes the one build you would actually install
  // as a desktop app the one build you cannot try locally.
  preview: {
    port: 5273,
    proxy: { '/api': { target: 'http://localhost:4100', changeOrigin: true } },
  },
  build: { target: 'es2022', sourcemap: true },
});
