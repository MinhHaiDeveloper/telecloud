// Artist biographies from two sources that complete each other: Last.fm (in English, strongest for Western
// music, with tags, listeners and similar artists) and QQ Music (in Chinese, strongest for Chinese and other
// Asian artists, often where Last.fm has nothing). The card shows Last.fm's when it says enough, QQ Music's
// otherwise, and lets the reader switch when both have one.
const { ipcMain, app } = require('electron');
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const QQ_SEARCH = process.env.QQ_SEARCH_URL || 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp';
const QQ_API = process.env.QQ_API_URL || 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const ENOUGH = 300; // characters of Last.fm text that make it the one shown first
const WEEK = 7 * 86400000;

async function get(url, { method = 'GET', body, timeout = 8000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { method, body, signal: ctl.signal, headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/', ...(body ? { 'Content-Type': 'application/json' } : {}) } });
    if (!r.ok) throw require('./httpError')(r, url);
    return await r.json();
  } finally { clearTimeout(t); }
}

const clean = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const fold = (s) => clean(s).replace(/[倫]/g, '伦'); // the commonest traditional/simplified pair in names

// ---- QQ Music: the singer's wiki text, kept a week (an answer of "none" a day)
const cacheFile = () => path.join(app.getPath('userData'), 'artist-info-qq.json');
let cache = null;
const load = () => { if (!cache) { try { cache = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) || {}; } catch { cache = {}; } } return cache; };
const keep = (k, info) => { load()[k] = { at: Date.now(), info }; try { fs.writeFileSync(cacheFile(), JSON.stringify(cache)); } catch { /* cache only */ } };

function wikiText(xml) {
  const desc = /<desc><!\[CDATA\[([\s\S]*?)\]\]><\/desc>/.exec(xml || '')?.[1] || '';
  return desc.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

async function qqBio(name) {
  if (!name) return null;
  const k = fold(name);
  const hit = load()[k];
  if (hit && Date.now() - hit.at < (hit.info ? WEEK : 86400000)) return hit.info;
  const p = new URLSearchParams({ w: name, format: 'json', n: '5', p: '1', cr: '1', t: '9' });
  const r = await get(`${QQ_SEARCH}?${p}`);
  // only the artist named: the same name, or its Latin name on QQ ("周杰伦" or "Jay Chou")
  const singer = (r?.data?.singer?.list || []).find(s => fold(s.singerName) === k || (s.singerTransName && fold(s.singerTransName) === k));
  let info = null;
  if (singer?.singerMID) {
    const body = { comm: { ct: 24, cv: 0 }, req: { module: 'music.musichallSinger.SingerInfoInter', method: 'GetSingerDetail', param: { singer_mids: [singer.singerMID], ex_info: 1, wiki_singer: 1, group_singer: 0, pic: 0, photos: 0 } } };
    const d = await get(QQ_API, { method: 'POST', body: JSON.stringify(body) });
    const s = d?.req?.data?.singer_list?.[0];
    const text = wikiText(s?.wiki);
    if (text.length >= 40) {
      const summary = text.split('\n').map(x => x.trim()).filter(Boolean)[0];
      info = { name: s.basic_info?.name || singer.singerName, summary, content: text, url: /^https:\/\/wiki\.y\.qq\.com\//.test(s.basic_info?.wikiurl || '') ? s.basic_info.wikiurl : null, lang: 'zh' };
    }
  }
  keep(k, info);
  return info;
}

/** Both, and which one to show first */
async function bio(name) {
  const lastfm = require('./lastfm');
  const [lf, qq] = await Promise.all([
    lastfm.artistInfo(name).catch(() => null),
    qqBio(name).catch((err) => { console.warn(`[Artist] QQ Music biography not reached: ${err.message}`); return null; }),
  ]);
  const lfText = (lf?.content || lf?.summary || '').trim();
  const lfInfo = lfText ? lf : null;
  const primary = lfInfo && lfText.length >= ENOUGH ? 'lastfm' : qq ? 'qq' : lfInfo ? 'lastfm' : null;
  return { primary, lastfm: lfInfo, qq };
}

ipcMain.handle('artist:bio', async (e, name) => { try { return { success: true, ...(await bio(String(name || '').slice(0, 200))) }; } catch (err) { return { success: false, error: err.message }; } });

module.exports = { bio, qqBio, _wikiText: wikiText };
