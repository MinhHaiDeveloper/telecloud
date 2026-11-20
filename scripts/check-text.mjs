// The text of the interface against its catalog. Every t('…') in src/, and tx('…') in electron/ (the main process: the
// tray, the file pickers, messages), is collected into src/locales/en.json (the file translators start from), and the
// build stops when:
//   - a t() or tx() is given something other than written-out text, so its text cannot be collected
//   - English is written straight into the interface without t(): JSX text, or a title/placeholder/aria-label/alt
// Each translation (src/locales/<language>.json) is counted against the catalog: missing texts show in English.
// Runs on every `vite build` (vite.config.js); also `node scripts/check-text.mjs`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const LOCALES = path.join(SRC, 'locales');
// files that hold no interface text, or keep their own (release notes stay in English)
const SKIP = new Set(['i18n.js', 'utils/whatsNew.js', 'components/Icon.jsx']);

const sourceFiles = () => {
  const out = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { if (f.name !== 'locales') walk(p); } else if (/\.jsx?$/.test(f.name)) out.push(p);
    }
  };
  walk(SRC);
  const src = out.map(p => ({ dir: 'src', rel: path.relative(SRC, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') })).filter(f => !SKIP.has(f.rel));
  // the main process: its messages, the tray and the file pickers' titles use tx()
  const MAIN = path.join(ROOT, 'electron');
  const main = [];
  const walkMain = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { if (f.name !== 'node_modules') walkMain(p); } else if (/\.js$/.test(f.name) && f.name !== 'i18n.js') main.push(p);
    }
  };
  walkMain(MAIN);
  return [...src, ...main.map(p => ({ dir: 'electron', rel: path.relative(MAIN, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') }))];
};

const lineOf = (text, i) => text.slice(0, i).split('\n').length;
const unquote = (s) => s.replace(/\\(.)/g, (m, c) => (c === 'n' ? '\n' : c));
const CALL = {
  src: /(?<![\w.$])t\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|([^\s)'"]))/g,
  electron: /(?<![\w.$])tx\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|([^\s)'"]))/g,
};
// English in the interface without t(): text between tags, and the attributes a person reads
const RAW_TEXT = />([^<>{}]*[a-z]{2,}[^<>{}]*)</g;
const RAW_ATTR = /\s(title|placeholder|aria-label|alt)="([^"]*[a-z]{2,}[^"]*)"/g;
const WORDS_OK = /^(TeleCloud( Beta)?|Telegram|Last\.fm|ListenBrainz|Discord|AutoEQ|Squiglink|YouTube|Cadence|Beta|Hz|kHz|kbps|dB|ms|px)$/;

export function checkText({ write = false } = {}) {
  const problems = [];
  const keys = new Set();
  for (const { dir, rel, text } of sourceFiles()) {
    // JSX text sits only in .jsx; skip code between backticks and comments to keep the check honest
    const plain = text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, (m, a) => a + ' '.repeat(m.length - a.length));
    for (const m of plain.matchAll(CALL[dir])) {
      if (m[3] !== undefined) { problems.push(`${dir}/${rel}:${lineOf(text, m.index)} ${dir === 'src' ? 't' : 'tx'}() needs the text written out, not a value: ${text.slice(m.index, m.index + 40)}…`); continue; }
      keys.add(unquote(m[1] ?? m[2]));
    }
    if (dir !== 'src' || !rel.endsWith('.jsx')) continue;
    for (const m of plain.matchAll(RAW_TEXT)) {
      const s = m[1].trim();
      // => and >= inside code look like a tag end: only text that starts a line or follows a tag counts
      // code between two tags (t('…', { b: <b>…</b>, span: <span>…</span> }), a ? <a/> : <b/>, x >= y) is not text
      if (!s || WORDS_OK.test(s) || /[=;(?]|&&|\|\||=>|\)\s*$|:\s*$/.test(m[1]) || /^\s*[-+*/%?:,]/.test(m[1]) || /^[\w.]+\.\w+$/.test(s)) continue;
      problems.push(`src/${rel}:${lineOf(text, m.index)} text without t(): "${s.slice(0, 70)}"`);
    }
    for (const m of plain.matchAll(RAW_ATTR)) {
      if (WORDS_OK.test(m[2].trim())) continue;
      problems.push(`src/${rel}:${lineOf(text, m.index)} ${m[1]} without t(): "${m[2].slice(0, 70)}"`);
    }
  }

  // the catalog, sorted so a diff shows what changed
  const catalog = Object.fromEntries([...keys].sort((a, b) => a.localeCompare(b, 'en')).map(k => [k, k]));
  const file = path.join(LOCALES, 'en.json');
  const next = `${JSON.stringify(catalog, null, 2)}\n`;
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const changed = prev.replace(/\r\n/g, '\n') !== next;
  if (changed && write) { fs.mkdirSync(LOCALES, { recursive: true }); fs.writeFileSync(file, next); }

  // terms stay as they are in every language (src/locales/terms.json): a translation that drops one fails the build
  const { terms = [] } = JSON.parse(fs.readFileSync(path.join(LOCALES, 'terms.json'), 'utf8'));
  const translations = fs.existsSync(LOCALES) ? fs.readdirSync(LOCALES).filter(f => f.endsWith('.json') && f !== 'en.json' && f !== 'terms.json') : [];
  const languages = translations.map(f => {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(path.join(LOCALES, f), 'utf8')); } catch (e) { problems.push(`src/locales/${f} is not valid JSON: ${e.message}`); }
    for (const [k, v] of Object.entries(data)) {
      if (typeof v !== 'string' || !v || !(k in catalog)) continue;
      for (const term of terms) {
        const has = (s) => s.toLowerCase().split(term.toLowerCase()).length - 1;
        if (has(k) > has(v)) problems.push(`src/locales/${f}: keep "${term}" as it is in: "${v.slice(0, 80)}"`);
      }
    }
    const done = Object.keys(catalog).filter(k => typeof data[k] === 'string' && data[k]).length;
    const stale = Object.keys(data).filter(k => !(k in catalog)).length;
    return { code: f.replace(/\.json$/, ''), done, stale };
  });
  return { problems, texts: keys.size, changed, languages };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dry = process.argv.includes('--dry');
  const r = checkText({ write: !dry });
  for (const l of r.languages) console.log(`  ${l.code}: ${l.done} of ${r.texts} translated${l.stale ? `, ${l.stale} no longer used` : ''}`);
  if (r.problems.length) {
    console.error(`Interface text: ${r.problems.length} problem(s)\n  ${r.problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`Interface text: ${r.texts} texts${r.changed ? `, src/locales/en.json ${dry ? 'is out of date' : 'updated'}` : ''}.`);
}
