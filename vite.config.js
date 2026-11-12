import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    target: 'chrome120',
    // the app, and the page TeleCloud Remote serves to other devices
    rollupOptions: { input: { main: 'index.html', remote: 'remote.html' } },
  },
  server: {
    port: 3000,
  }
});
