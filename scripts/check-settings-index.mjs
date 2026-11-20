// The Settings search index (src/utils/settingsIndex.js) against the code: every SettingRow with a written title
// must be in the index (or in its IGNORED list), and every entry in the index must still be on a Settings page.
// Runs on every `vite build` (vite.config.js) and fails the build with the list; also `node scripts/check-settings-index.mjs`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPONENTS = path.join(ROOT, 'src', 'components');

const decode = (t) => t.replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const unquote = (s) => s.replace(/\\(.)/g, '$1');

export async function checkSettingsIndex() {
  // the index is an ES module in a CommonJS package: read it as plain JavaScript, which keeps Node from warning;
  // its t() gives the English text, which is what the code is written in
  const code = fs.readFileSync(path.join(ROOT, 'src', 'utils', 'settingsIndex.js'), 'utf8').replace(/^export\s+/gm, '').replace(/^import .*$/gm, '');
  const { SETTINGS, IGNORED } = vm.runInNewContext(`${code}\n;({ SETTINGS, IGNORED })`, { t: (s) => s, tKnown: (s) => s }, { filename: 'settingsIndex.js' });
  const files = fs.readdirSync(COMPONENTS).filter(f => f.endsWith('.jsx'));
  const sources = files.map(f => ({ file: f, text: fs.readFileSync(path.join(COMPONENTS, f), 'utf8') }));
  const indexed = new Set(SETTINGS.map(s => s.title));
  const ignored = new Set(IGNORED);
  const problems = [];

  // 1. every SettingRow title written out in the code is indexed: title="…", title={'…'} or title={t('…')}
  const rowTitle = /<SettingRow\b[^>]*?\btitle=(?:"([^"]+)"|\{'([^']+)'\}|\{"([^"]+)"\}|\{t\('((?:[^'\\]|\\.)+)'\)\})/g;
  const seen = new Set();
  for (const { file, text } of sources) {
    for (const m of text.matchAll(rowTitle)) {
      const title = decode(m[1] || m[2] || m[3] || unquote(m[4]));
      seen.add(title);
      if (!indexed.has(title) && !ignored.has(title)) {
        const line = text.slice(0, m.index).split('\n').length;
        problems.push(`missing from the index: "${title}" (src/components/${file}:${line}). Add it to SETTINGS in src/utils/settingsIndex.js, or to IGNORED if it is not a setting.`);
      }
    }
  }

  // 2. every index entry is still somewhere: a row title, a section heading, or a block heading
  const all = sources.map(s => s.text).join('\n');
  const present = (title) => {
    if (seen.has(title)) return true;
    const re = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const t = re.replace(/&/g, '(?:&|&amp;)').replace(/ /g, '\\s+');
    return new RegExp(`>\\s*${t}\\s*(?:<|\\{|$)`, 'm').test(all) || new RegExp(`title="${t}"`).test(all)
      || new RegExp(`\\bt\\('${re.replace(/'/g, "\\\\'")}'`).test(all);
  };
  for (const s of SETTINGS) if (!present(s.title)) problems.push(`in the index but not in the code: "${s.title}" (tab ${s.tab}). Rename or remove it in src/utils/settingsIndex.js.`);
  for (const t of IGNORED) if (!seen.has(t)) problems.push(`IGNORED but not a SettingRow any more: "${t}". Remove it from IGNORED.`);

  // 3. entries point at real tabs
  const tabs = new Set([...fs.readFileSync(path.join(COMPONENTS, 'SettingsView.jsx'), 'utf8').matchAll(/\{ id: '([a-z]+)', (?:label:|get label\(\))/g)].map(m => m[1]));
  for (const s of SETTINGS) if (!tabs.has(s.tab)) problems.push(`"${s.title}" names a tab that does not exist: ${s.tab}`);

  return { problems, rows: seen.size, entries: SETTINGS.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkSettingsIndex().then(({ problems, rows, entries }) => {
    if (problems.length) {
      console.error(`Settings search index: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
      process.exit(1);
    }
    console.log(`Settings search index: ${entries} entries, all ${rows} written row titles covered.`);
  });
}
