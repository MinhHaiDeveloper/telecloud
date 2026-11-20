// Text the main process shows (the tray menu, the titles of Windows' file pickers, messages sent to the window) in the
// app's language. tx('English text', { name: value }) works like t() in src/i18n.js, plurals included, and its texts
// are collected into the same catalog (src/locales/en.json) at build time. The window sends the language and its
// catalog when it starts and whenever it changes (i18n:set): the main process keeps no copy of the translations.
// Called tx, not t: plenty of code here uses t for a time or a track.
const { ipcMain } = require('electron');

let language = 'en';
let catalog = {};
let rules = new Intl.PluralRules('en');
let categories = ['one', 'other'];
const listeners = new Set();
const ORDER = ['zero', 'one', 'two', 'few', 'many', 'other'];
const ACCENT = { a: 'á', e: 'é', i: 'î', o: 'ö', u: 'ü', c: 'ç', n: 'ñ', s: 'ś', y: 'ý', A: 'Å', E: 'É', I: 'Î', O: 'Ö', U: 'Ü' };
let keep = /\{[^{}]*\}|./g; // terms that stay as they are (src/locales/terms.json, sent with the language)
const pseudo = (s) => `⟦${s.replace(keep, m => (m.length > 1 ? m : ACCENT[m] || m))}⟧`;

function tx(text, vars) {
  let s = (catalog && typeof catalog[text] === 'string' && catalog[text]) || text;
  if (language === 'pseudo') s = pseudo(s);
  if (!vars) return s;
  s = s.replace(/\{(\w+)\|([^{}]*)\}/g, (m, k, forms) => {
    const list = forms.split('|');
    const shown = typeof vars[k] === 'number' ? vars[k].toLocaleString(language === 'en' || language === 'pseudo' ? undefined : language) : String(vars[k]);
    return (list[categories.indexOf(rules.select(Number(vars[k])))] ?? list[list.length - 1]).replace(/#/g, shown);
  });
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? (vars[k] == null || typeof vars[k] === 'boolean' ? '' : String(vars[k])) : m));
}

/** Runs fn whenever the language changes (the tray rebuilds its menu) */
function onLanguage(fn) { listeners.add(fn); return () => listeners.delete(fn); }

ipcMain.handle('i18n:set', (e, next) => {
  const code = typeof next?.language === 'string' ? next.language.slice(0, 20) : 'en';
  const changed = code !== language;
  language = code;
  catalog = next?.catalog && typeof next.catalog === 'object' ? next.catalog : {};
  const terms = Array.isArray(next?.terms) ? next.terms.filter(x => typeof x === 'string' && x.length < 40) : [];
  keep = new RegExp(`\\{[^{}]*\\}|${[...terms.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '.'].join('|')}`, 'gi');
  try { rules = new Intl.PluralRules(code === 'pseudo' ? 'en' : code); } catch { rules = new Intl.PluralRules('en'); }
  categories = rules.resolvedOptions().pluralCategories.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  if (changed) console.log(`[Language] ${code}`);
  for (const fn of listeners) { try { fn(code); } catch (err) { console.warn('[Language] listener:', err.message); } }
});

module.exports = { tx, onLanguage, language: () => language };
