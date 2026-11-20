import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { checkSettingsIndex } from './scripts/check-settings-index.mjs';

// Every build checks the Settings search index against the code and stops when a setting is missing from it
const settingsIndexCheck = () => ({
  name: 'settings-index-check',
  apply: 'build',
  async buildStart() {
    const { problems, rows, entries } = await checkSettingsIndex();
    if (problems.length) this.error(`Settings search index: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
    this.info?.(`settings search index: ${entries} entries, ${rows} row titles covered`);
  },
});

export default defineConfig({
  plugins: [react(), settingsIndexCheck()],
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
