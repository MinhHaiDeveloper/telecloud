// Text in the interface. t('English text', { name: value }) gives the text in the chosen language, English when the
// language has no translation for it. The English text is the key; every t() is collected into src/locales/en.json
// at build time (scripts/check-text.mjs), and a translation is a file beside it, e.g. vi.json, with the same keys.
//   {name}             the value of `name`
//   {n|# track|# tracks}  a plural: the forms in the order of the language's plural categories (English: one,
//                      other; Vietnamese, Chinese, Japanese: just one form), # is the number written the local way
// A value that is a React element makes t() give a fragment instead of a string, so links and bold text can sit inside.
// The language changes in place: App re-renders its views (useLanguage), text kept in modules is read through getters,
// and the main process gets the same catalog for the tray, its dialogs and its messages (electron/i18n.js).
import { createElement, Fragment, useSyncExternalStore } from 'react';
import TERMS from './locales/terms.json';

const KEY = 'tc-language';
const FILES = import.meta.glob(['./locales/*.json', '!./locales/en.json', '!./locales/terms.json'], { eager: true, import: 'default' });
const CATALOGS = Object.fromEntries(Object.entries(FILES).map(([p, c]) => [p.match(/([\w-]+)\.json$/)[1], c]));
if (import.meta.env.DEV) CATALOGS.pseudo = null; // accents every text, to see what is not translated and what overflows

const nameOf = (code) => (code === 'pseudo' ? 'Pseudo (test)' : new Intl.DisplayNames([code], { type: 'language' }).of(code) || code);
/** The languages there are translations for, English first */
export const LANGUAGES = ['en', ...Object.keys(CATALOGS)].map(code => ({ code, name: nameOf(code) }));

/** 'auto' follows Windows */
export const chosenLanguage = () => { try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; } };
const pick = () => {
  const chosen = chosenLanguage();
  if (chosen !== 'auto') return chosen in CATALOGS || chosen === 'en' ? chosen : 'en';
  for (const want of navigator.languages || [navigator.language]) {
    const hit = Object.keys(CATALOGS).find(c => c.toLowerCase() === want.toLowerCase()) || Object.keys(CATALOGS).find(c => c.split('-')[0] === want.split('-')[0]);
    if (hit && hit !== 'pseudo') return hit;
  }
  return 'en';
};

const ORDER = ['zero', 'one', 'two', 'few', 'many', 'other'];
let language, catalog, rules, categories, numberLocale;
const apply = (code) => {
  language = code;
  catalog = CATALOGS[code] || null;
  rules = new Intl.PluralRules(code === 'pseudo' ? 'en' : code);
  categories = rules.resolvedOptions().pluralCategories.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  numberLocale = code === 'pseudo' || code === 'en' ? undefined : code; // English keeps Windows' number style
  if (typeof document !== 'undefined') document.documentElement.lang = code === 'pseudo' ? 'en' : code;
  // the main window tells the main process; the floating lyrics window only follows
  if (window.location.hash !== '#floating-lyrics') window.ipcRenderer?.invoke('i18n:set', { language: code, catalog: catalog || {}, terms: TERMS.terms }).catch(() => {});
};
apply(pick());

const listeners = new Set();
const changed = () => { for (const fn of listeners) fn(); };
export const getLanguage = () => language;
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
/** The language now; a component that calls it draws again when it changes */
export const useLanguage = () => useSyncExternalStore(subscribe, getLanguage);

let changedAt = 0;
export const setLanguage = (code) => {
  try { if (code === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, code); } catch { /* storage off */ }
  changedAt = Date.now();
  apply(pick());
  changed();
};
/** True for a moment after the language changed: a view drawn again then can come back where it was (Settings' tab) */
export const justRelabeled = () => Date.now() - changedAt < 1500;
// another window of the app (the floating lyrics) changed it
window.addEventListener('storage', (e) => { if (e.key === KEY || e.key === null) { apply(pick()); changed(); } });

const ACCENT = { a: 'á', e: 'é', i: 'î', o: 'ö', u: 'ü', c: 'ç', n: 'ñ', s: 'ś', y: 'ý', A: 'Å', E: 'É', I: 'Î', O: 'Ö', U: 'Ü' };
// terms stay as they are, as in a real translation (locales/terms.json)
const KEEP = new RegExp(`\\{[^{}]*\\}|${TERMS.terms.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}|.`, 'gi');
const pseudo = (s) => `⟦${s.replace(KEEP, m => (m.length > 1 ? m : ACCENT[m] || m))}⟧`;

/** t() for a text that a t('…') somewhere else already gives, so the catalog has it (a setting's title in the
 *  search index is the row's own title, a message from the main process). The build does not collect from it. */
export const tKnown = (text, vars) => t(text, vars);

export function t(text, vars) {
  let s = catalog?.[text] || text;
  if (language === 'pseudo') s = pseudo(s);
  if (!vars) return s;
  s = s.replace(/\{(\w+)\|([^{}]*)\}/g, (m, k, forms) => {
    const n = Number(vars[k]);
    const list = forms.split('|');
    const shown = typeof vars[k] === 'number' ? vars[k].toLocaleString(numberLocale) : String(vars[k]);
    return (list[categories.indexOf(rules.select(n))] ?? list[list.length - 1]).replace(/#/g, shown);
  });
  // like JSX: null, undefined, true and false show nothing; elements and lists of them make a fragment
  const parts = s.split(/\{(\w+)\}/);
  const value = (p) => (p in vars ? vars[p] : `{${p}}`);
  if (!parts.some((p, i) => i % 2 && vars[p] !== null && typeof vars[p] === 'object')) {
    return parts.map((p, i) => { if (!(i % 2)) return p; const v = value(p); return v == null || typeof v === 'boolean' ? '' : String(v); }).join('');
  }
  return createElement(Fragment, null, ...parts.map((p, i) => (i % 2 ? value(p) : p)));
}

/** Draws its children again from scratch when the language changes, so text kept in state and memos is made anew.
 *  The component that uses it keeps its own state (App keeps what is playing, the queue and the page). */
export const Relabel = ({ children }) => createElement(Fragment, { key: useLanguage() }, children);
