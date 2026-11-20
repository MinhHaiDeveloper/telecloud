// Playlists as .m3u / .m3u8 files, the plain lists most players read and write.
// Import: each line is a file (absolute, relative to the playlist, or a file:// URL); the ones in the library
// make the playlist, the others are listed back so nothing goes missing without a word.
// Export: UTF-8 (.m3u8), with #EXTINF for length, artist and title, and paths relative to the playlist when
// they share a drive. Tracks only in TeleCloud have no file to point at; they are counted and left out.
const { ipcMain, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const database = require('./database');
const { tx } = require('./i18n');

const key = (p) => path.resolve(p).replace(/\//g, '\\').toLowerCase(); // Windows paths ignore case

/** Text of a playlist file: UTF-8 when it is, otherwise the Windows code page most old .m3u files use */
function readText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  try { return new TextDecoder('windows-1252').decode(buf); } catch { return buf.toString('latin1'); }
}

/** The entries of an .m3u: { path, line, title } for each track line, comments read for their titles */
function parse(text, dir) {
  const out = [];
  let info = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const m = /^#EXTINF:[^,]*,(.*)$/i.exec(line);
      if (m) info = m[1].trim();
      continue;
    }
    let p = line;
    try {
      if (/^file:\/\//i.test(p)) p = fileURLToPath(p);
      else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) { out.push({ path: null, line, title: info }); info = null; continue; } // a web address: not a file
      else if (!path.isAbsolute(p)) p = path.resolve(dir, p.replace(/\//g, path.sep));
    } catch { p = null; }
    out.push({ path: p, line, title: info });
    info = null;
  }
  return out;
}

async function importFile(win) {
  const r = await dialog.showOpenDialog(win, {
    title: tx('Import a playlist'),
    filters: [{ name: tx('Playlists'), extensions: ['m3u8', 'm3u'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  const file = r.filePaths[0];
  const entries = parse(readText(await fs.promises.readFile(file)), path.dirname(file));
  const library = new Map(database.getAllFiles().map(f => [key(f.path), f.path]));
  const found = [];
  const missing = [];
  for (const e of entries) {
    const hit = e.path && library.get(key(e.path));
    if (hit) found.push(hit);
    else missing.push(e.title ? `${e.title} (${e.line})` : e.line);
  }
  const name = path.basename(file).replace(/\.m3u8?$/i, '');
  console.log(`[Playlists] Imported "${path.basename(file)}": ${found.length} found, ${missing.length} not in the library`);
  return { success: true, name, paths: found, missing, total: entries.length };
}

async function exportFile(win, { name, paths }) {
  const safe = String(name || 'Playlist').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'Playlist';
  const r = await dialog.showSaveDialog(win, {
    title: tx('Export the playlist'),
    defaultPath: `${safe}.m3u8`,
    filters: [{ name: tx('Playlist (UTF-8)'), extensions: ['m3u8'] }, { name: tx('Playlist'), extensions: ['m3u'] }],
  });
  if (r.canceled || !r.filePath) return { canceled: true };
  const dir = path.dirname(r.filePath);
  const rows = new Map(database.getAllFiles().map(f => [f.path, f]));
  const lines = ['#EXTM3U'];
  let written = 0, cloudOnly = 0;
  for (const p of paths || []) {
    const row = rows.get(p);
    if (!row || String(p).startsWith('tc://') || row.storage_type === 'cloud') { cloudOnly++; continue; }
    const secs = Math.round(Number(row.duration) || -1);
    const who = row.artist ? `${row.artist} - ` : '';
    lines.push(`#EXTINF:${secs},${who}${row.title || path.basename(p, path.extname(p))}`);
    // relative when on the same drive, so the playlist and its music can move together
    const rel = path.parse(p).root.toLowerCase() === path.parse(dir).root.toLowerCase() ? path.relative(dir, p) : p;
    lines.push(rel);
    written++;
  }
  await fs.promises.writeFile(r.filePath, `${lines.join('\r\n')}\r\n`, 'utf8');
  console.log(`[Playlists] Exported ${written} tracks${cloudOnly ? `, ${cloudOnly} only in TeleCloud left out` : ''}`);
  return { success: true, path: r.filePath, written, cloudOnly };
}

ipcMain.handle('playlists:import', async (e) => {
  try { return await importFile(BrowserWindow.fromWebContents(e.sender)); } catch (err) { console.error('[Playlists] Import failed:', err.message); return { success: false, error: err.message }; }
});
ipcMain.handle('playlists:export', async (e, opts = {}) => {
  try { return await exportFile(BrowserWindow.fromWebContents(e.sender), opts); } catch (err) { console.error('[Playlists] Export failed:', err.message); return { success: false, error: err.message }; }
});

module.exports = { parse, readText, importFile, exportFile };
