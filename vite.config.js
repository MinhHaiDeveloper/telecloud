import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { checkSettingsIndex } from './scripts/check-settings-index.mjs';
import { checkText } from './scripts/check-text.mjs';

// Every build checks the code first and stops on a problem: the Settings search index against the settings, and the
// interface text against its catalog (which it brings up to date, src/locales/en.json)
const buildChecks = () => ({
  name: 'build-checks',
  apply: 'build',
  async buildStart() {
    const index = await checkSettingsIndex();
    if (index.problems.length) this.error(`Settings search index: ${index.problems.length} problem(s)\n  ${index.problems.join('\n  ')}`);
    const text = checkText({ write: true });
    if (text.problems.length) this.error(`Interface text: ${text.problems.length} problem(s)\n  ${text.problems.join('\n  ')}`);
    this.info?.(`settings search index: ${index.entries} entries, ${index.rows} row titles covered`);
    this.info?.(`interface text: ${text.texts} texts${text.changed ? ', catalog updated' : ''}${text.languages.map(l => `, ${l.code} ${l.done}/${text.texts}`).join('')}`);
  },
});

export default defineConfig({
  plugins: [react(), buildChecks()],
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
