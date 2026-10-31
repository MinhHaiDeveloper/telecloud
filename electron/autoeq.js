// Headphone measurements and target curves for AutoEQ, from the AutoEq project
// (github.com/jaakkopasanen/AutoEq). The list of headphones ships with the app; the curves are
// downloaded on first use and cached, so they keep working offline afterwards.

const { ipcMain, app, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const RAW_BASE = 'https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/';
const cacheDir = () => path.join(app.getPath('userData'), 'autoeq-cache');

// Targets worth offering, in the order shown; the index lists every target in the repository
const TARGETS = [
  'Harman in-ear 2019', 'Harman in-ear 2019 without bass', 'Harman over-ear 2018', 'Harman over-ear 2018 without bass',
  'AutoEq in-ear', 'Diffuse field 5128 -1dB per octave', 'Diffuse field 5128', 'LMG 5128 0.6', 'Diffuse field GRAS KEMAR',
  'Diffuse field ISO 11904-1', 'oratory1990 in-ear', 'oratory1990 optimum hifi over-ear', 'JM-1 with Harman filters',
  'Harman over-ear 2015', 'Harman over-ear 2013', 'zero',
];

let index = null;
function loadIndex() {
  if (index) return index;
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'autoeq-index.json'), 'utf8'));
  const targets = new Set(data.targets);
  index = {
    items: data.items.map((it, id) => ({ id, ...it, search: `${it.n} ${it.s}`.toLowerCase() })),
    targets: TARGETS.filter(t => targets.has(t)),
  };
  return index;
}

const repoPath = (it) => `measurements/${it.s}/data/${it.k}/${it.r ? `${it.r}/` : ''}${it.n}.csv`;
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

/** "frequency,raw" CSV (also plain "f y" pairs) → [{ x, y }] sorted by frequency */
function parseCurve(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const parts = line.trim().split(/[\s,;\t]+/);
    const x = parseFloat(parts[0]);
    const y = parseFloat(parts[1]);
    if (Number.isFinite(x) && Number.isFinite(y) && x > 0) out.push({ x, y });
  }
  return out.sort((a, b) => a.x - b.x);
}

async function fetchCached(repoFile) {
  const file = path.join(cacheDir(), `${crypto.createHash('sha1').update(repoFile).digest('hex')}.csv`);
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch { /* not cached yet */ }
  const res = await net.fetch(RAW_BASE + encodePath(repoFile));
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const text = await res.text();
  if (text.length > 2 * 1024 * 1024) throw new Error('Unexpectedly large file');
  await fs.promises.mkdir(cacheDir(), { recursive: true });
  await fs.promises.writeFile(file, text, 'utf8');
  return text;
}

const publicItem = (it) => ({ id: it.id, name: it.n, source: it.s, kind: it.k, rig: it.r || '' });

ipcMain.handle('autoeq:search', (event, query) => {
  const { items } = loadIndex();
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!words.length) return [];
  const hits = [];
  for (const it of items) {
    if (!words.every(w => it.search.includes(w))) continue;
    const name = it.n.toLowerCase();
    // exact model name first, then names starting with the query, then the rest
    const score = (name === words.join(' ') ? 0 : name.startsWith(words[0]) ? 1 : 2) * 1000 + it.n.length;
    hits.push([score, it]);
  }
  hits.sort((a, b) => a[0] - b[0]);
  return hits.slice(0, 60).map(h => publicItem(h[1]));
});

ipcMain.handle('autoeq:measurement', async (event, id) => {
  const it = loadIndex().items[Number(id)];
  if (!it) throw new Error('Unknown headphone');
  const data = parseCurve(await fetchCached(repoPath(it)));
  if (data.length < 10) throw new Error('This measurement has no usable data');
  return { ...publicItem(it), data };
});

ipcMain.handle('autoeq:targets', () => loadIndex().targets);

ipcMain.handle('autoeq:target', async (event, name) => {
  if (!loadIndex().targets.includes(name)) throw new Error('Unknown target');
  const data = parseCurve(await fetchCached(`targets/${name}.csv`));
  if (data.length < 10) throw new Error('This target has no usable data');
  return { name, data };
});

module.exports = { parseCurve };
