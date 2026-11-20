// Smart playlists: a playlist that is a set of rules instead of a list. Its tracks are worked out from the
// library each time it is shown, so it keeps itself up to date: a new album, a play, a favourite, and it
// changes by itself. Stored with the other playlists as { id, name, smart: { match, rules, sort, limit }, songs: [] }.
import { qualityOf, storageOf } from './audio';
import { t } from '../i18n';

const DAY = 86400000;
const lc = (s) => String(s ?? '').trim().toLowerCase();

const TEXT_OPS = [
  { value: 'contains', get label() { return t('contains'); } },
  { value: 'not-contains', get label() { return t('does not contain'); } },
  { value: 'is', get label() { return t('is'); } },
  { value: 'is-not', get label() { return t('is not'); } },
  { value: 'starts', get label() { return t('starts with'); } },
];
const NUM_OPS = [
  { value: 'gte', get label() { return t('is at least'); } },
  { value: 'lte', get label() { return t('is at most'); } },
  { value: 'is', get label() { return t('is'); } },
  { value: 'between', get label() { return t('is between'); } },
];
const DATE_OPS = [
  { value: 'in-last', get label() { return t('in the last'); } },
  { value: 'not-in-last', get label() { return t('not in the last'); } },
];
const CHOICE_OPS = [
  { value: 'is', get label() { return t('is'); } },
  { value: 'is-not', get label() { return t('is not'); } },
];

/** Every field a rule can look at: how to read it from a track, and what it can be compared with */
export const FIELDS = [
  { value: 'artist', get label() { return t('Artist'); }, kind: 'text', get: (f) => f.metadata?.artist },
  { value: 'albumArtist', get label() { return t('Album artist'); }, kind: 'text', get: (f) => f.metadata?.albumArtist || f.metadata?.artist },
  { value: 'album', get label() { return t('Album'); }, kind: 'text', get: (f) => f.metadata?.album },
  { value: 'title', get label() { return t('Title'); }, kind: 'text', get: (f) => f.metadata?.title || f.name },
  { value: 'genre', get label() { return t('Genre'); }, kind: 'text', get: (f) => f.metadata?.genre },
  { value: 'year', get label() { return t('Year'); }, kind: 'number', get: (f) => Number(f.metadata?.year) || null },
  { value: 'plays', get label() { return t('Plays'); }, kind: 'number', get: (f, c) => c.playCounts?.[f.path] || 0 },
  { value: 'lastPlayed', get label() { return t('Last played'); }, kind: 'date', get: (f, c) => c.lastPlayed?.[f.path] || null, never: true },
  { value: 'added', get label() { return t('Date added'); }, kind: 'date', get: (f) => (f.added_at ? new Date(f.added_at).getTime() : null) },
  { value: 'favourite', get label() { return t('Favourite'); }, kind: 'choice', choices: [{ value: 'yes', get label() { return t('yes'); } }, { value: 'no', get label() { return t('no'); } }], get: (f, c) => (c.favorites?.has(f.path) ? 'yes' : 'no') },
  { value: 'quality', get label() { return t('Quality'); }, kind: 'choice', choices: [{ value: 'hires', get label() { return t('Hi-Res'); } }, { value: 'lossless', get label() { return t('Lossless (CD)'); } }, { value: 'lossy', get label() { return t('Lossy'); } }], get: (f) => qualityOf(f).tier },
  { value: 'format', get label() { return t('Format'); }, kind: 'choice', choices: ['flac', 'wav', 'aiff', 'alac', 'dsd', 'mp3', 'aac', 'ogg', 'opus'].map(v => ({ value: v, label: v === 'dsd' ? 'DSD' : v.toUpperCase() })), get: (f) => formatOf(f) },
  { value: 'bitDepth', get label() { return t('Bit depth'); }, kind: 'number', unit: 'bit', get: (f) => Number(f.metadata?.bitsPerSample) || null },
  { value: 'sampleRate', get label() { return t('Sample rate'); }, kind: 'number', unit: 'kHz', get: (f) => (f.metadata?.sampleRate ? f.metadata.sampleRate / 1000 : null) },
  { value: 'mqa', label: 'MQA', kind: 'choice', choices: [{ value: 'yes', get label() { return t('yes'); } }, { value: 'studio', get label() { return t('MQA Studio'); } }, { value: 'no', get label() { return t('no'); } }], get: (f) => (f.mqa === 2 ? 'studio' : f.mqa > 0 ? 'yes' : 'no') },
  { value: 'source', get label() { return t('Where'); }, kind: 'choice', choices: [{ value: 'local', get label() { return t('On this computer'); } }, { value: 'cloud', get label() { return t('Only in TeleCloud'); } }, { value: 'backed', get label() { return t('Backed up to TeleCloud'); } }], get: (f) => sourceOf(f) },
];
export const FIELD = Object.fromEntries(FIELDS.map(f => [f.value, f]));
export const opsFor = (field) => {
  const f = FIELD[field];
  if (!f) return TEXT_OPS;
  if (f.kind === 'number') return NUM_OPS;
  if (f.kind === 'date') return f.never ? [...DATE_OPS, { value: 'never', label: t('never') }] : DATE_OPS;
  if (f.kind === 'choice') return CHOICE_OPS;
  return TEXT_OPS;
};

function formatOf(f) {
  const ext = String(f.ext || f.path?.split('.').pop() || '').replace('.', '').toLowerCase();
  if (ext === 'dsf' || ext === 'dff') return 'dsd';
  if (ext === 'm4a') return f.metadata?.bitsPerSample ? 'alac' : 'aac';
  if (ext === 'aif' || ext === 'aiff') return 'aiff';
  return ext;
}
function sourceOf(f) {
  const s = storageOf(f);
  if (s === 'cloud' || s === 'cached' || String(f.path || '').startsWith('tc://')) return 'cloud';
  return f.telegram_message_id ? 'backed' : 'local';
}
/** Is a track's source this choice? A backed-up track is also on this computer */
const sourceIs = (have, want) => have === want || (want === 'local' && have === 'backed');

/** A new rule with sensible starting values for its field */
export function newRule(field = 'artist') {
  const f = FIELD[field] || FIELDS[0];
  const op = opsFor(f.value)[0].value;
  if (f.kind === 'number') return { field: f.value, op, value: f.value === 'plays' ? 5 : f.value === 'year' ? new Date().getFullYear() - 10 : f.value === 'bitDepth' ? 24 : f.value === 'sampleRate' ? 88.2 : 1, value2: '' };
  if (f.kind === 'date') return { field: f.value, op, value: 30, value2: '' };
  if (f.kind === 'choice') return { field: f.value, op, value: f.choices[0].value, value2: '' };
  return { field: f.value, op, value: '', value2: '' };
}

/** Does a track pass one rule? */
function passes(file, rule, ctx) {
  const f = FIELD[rule.field];
  if (!f) return true;
  const v = f.get(file, ctx);
  if (f.kind === 'text') {
    const want = lc(rule.value);
    if (!want) return true; // an empty rule doesn't hide anything while it is being typed
    // a track with several artists ("A, B feat. C") counts as each of them for "is"
    const have = lc(v);
    const parts = have.split(/\s*(?:[,;、]|\s[&/x]\s|\sfeat\.?\s|\sft\.?\s|\sfeaturing\s)\s*/).filter(Boolean);
    switch (rule.op) {
      case 'not-contains': return !have.includes(want);
      case 'is': return have === want || parts.includes(want);
      case 'is-not': return have !== want && !parts.includes(want);
      case 'starts': return have.startsWith(want);
      default: return have.includes(want);
    }
  }
  if (f.kind === 'number') {
    const a = Number(rule.value), b = Number(rule.value2);
    if (v == null) return false;
    switch (rule.op) {
      case 'lte': return v <= a;
      case 'is': return Math.abs(v - a) < 1e-6;
      case 'between': return v >= Math.min(a, b) && v <= Math.max(a, b);
      default: return v >= a;
    }
  }
  if (f.kind === 'date') {
    if (rule.op === 'never') return !v;
    const since = ctx.now - Math.max(0, Number(rule.value) || 0) * DAY;
    const within = !!v && v >= since;
    return rule.op === 'not-in-last' ? !within : within;
  }
  if (f.kind === 'choice') {
    const same = rule.field === 'source' ? sourceIs(v, rule.value) : rule.field === 'mqa' && rule.value === 'yes' ? v !== 'no' : v === rule.value;
    return rule.op === 'is-not' ? !same : same;
  }
  return true;
}

export const SORTS = [
  { value: 'artist', get label() { return t('Artist, album, track'); } },
  { value: 'title', get label() { return t('Title'); } },
  { value: 'added', get label() { return t('Newest added'); } },
  { value: 'year', get label() { return t('Newest year'); } },
  { value: 'plays', get label() { return t('Most played'); } },
  { value: 'lastPlayed', get label() { return t('Last played'); } },
  { value: 'random', get label() { return t('Random'); } },
];

// a mixed-up order that stays the same while the playlist shows (and changes only when it is reshuffled)
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/** The tracks of a smart playlist, in its order and up to its limit */
export function smartTracks(smart, files, ctx = {}) {
  const c = { now: Date.now(), ...ctx };
  const rules = (smart?.rules || []).filter(r => FIELD[r.field]);
  const any = smart?.match === 'any';
  let list = rules.length ? files.filter(f => (any ? rules.some(r => passes(f, r, c)) : rules.every(r => passes(f, r, c)))) : [];
  const by = (get, dir = 1) => (a, b) => { const x = get(a), y = get(b); return (x === y ? 0 : x == null ? 1 : y == null ? -1 : x > y ? 1 : -1) * dir; };
  const name = (f) => lc(f.metadata?.title || f.name);
  const artistOrder = (a, b) => lc(a.metadata?.albumArtist || a.metadata?.artist).localeCompare(lc(b.metadata?.albumArtist || b.metadata?.artist))
    || lc(a.metadata?.album).localeCompare(lc(b.metadata?.album))
    || (a.metadata?.disc || 0) - (b.metadata?.disc || 0) || (a.metadata?.track || 0) - (b.metadata?.track || 0) || name(a).localeCompare(name(b));
  switch (smart?.sort) {
    case 'title': list = [...list].sort((a, b) => name(a).localeCompare(name(b))); break;
    case 'added': list = [...list].sort(by(f => FIELD.added.get(f), -1)); break;
    case 'year': list = [...list].sort((a, b) => by(f => FIELD.year.get(f), -1)(a, b) || artistOrder(a, b)); break;
    case 'plays': list = [...list].sort((a, b) => (FIELD.plays.get(b, c) - FIELD.plays.get(a, c)) || artistOrder(a, b)); break;
    case 'lastPlayed': list = [...list].sort(by(f => FIELD.lastPlayed.get(f, c), -1)); break;
    case 'random': { const seed = String(smart.seed || 0); list = [...list].sort((a, b) => hash(seed + a.path) - hash(seed + b.path)); break; }
    default: list = [...list].sort(artistOrder);
  }
  const limit = Math.max(0, Number(smart?.limit) || 0);
  return limit ? list.slice(0, limit) : list;
}

/** The rules in words, for under the playlist's name */
export function describe(smart) {
  const rules = smart?.rules || [];
  if (!rules.length) return t('No rules yet');
  const one = (r) => {
    const f = FIELD[r.field];
    if (!f) return '';
    const op = opsFor(r.field).find(o => o.value === r.op)?.label || r.op;
    if (r.op === 'never') return t('{label} never', { label: f.label });
    if (f.kind === 'date') return t('{label} {op} {value} days', { label: f.label, op, value: r.value });
    if (f.kind === 'choice') return `${f.label} ${op} ${f.choices.find(c => c.value === r.value)?.label || r.value}`;
    if (r.op === 'between') return t('{label} {op} {value} and {value2}{value3}', { label: f.label, op, value: r.value, value2: r.value2, value3: f.unit ? ` ${f.unit}` : '' });
    return `${f.label} ${op} ${f.kind === 'text' ? `“${r.value}”` : `${r.value}${f.unit ? ` ${f.unit}` : ''}`}`;
  };
  const text = rules.map(one).filter(Boolean).join(smart.match === 'any' ? ', or ' : ', and ');
  const limit = Number(smart.limit) > 0 ? t(' · up to {limit} tracks', { limit: smart.limit }) : '';
  return `${text}${limit}`;
}

/** What a smart playlist keeps on disk (its tracks are always worked out again) */
export const forSaving = (playlists) => playlists.map(p => (p.smart ? { ...p, songs: [] } : p));
