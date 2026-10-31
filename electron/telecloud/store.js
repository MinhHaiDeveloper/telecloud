// TeleCloud tables (same SQLite file as the library):
//   storages      Telegram chats used as storage (up to 5): peer id + access hash, so they can be
//                 reached after a restart without searching the dialog list
//   cloud_index   one row per TeleCloud file message: checksum, size, encryption IV, track info
//   upload_queue  backups waiting / running / failed; survives restarts

const database = require('../database');

// tables are (re)checked whenever the database connection changes (e.g. after it was cleared)
let readyFor = null;
function db() {
  const d = database.initDatabase();
  if (readyFor !== d) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS storages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,              -- 'channel' | 'self'
        peer_id TEXT NOT NULL UNIQUE,
        access_hash TEXT,
        title TEXT,
        is_default INTEGER DEFAULT 0,
        last_indexed_id INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
      );
      CREATE TABLE IF NOT EXISTS cloud_index (
        storage_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        sha256 TEXT,
        size INTEGER,
        name TEXT,
        iv TEXT,
        info TEXT,
        date INTEGER,
        PRIMARY KEY (storage_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_sha ON cloud_index(sha256);
      CREATE TABLE IF NOT EXISTS upload_queue (
        path TEXT PRIMARY KEY,
        storage_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued', -- queued | uploading | done | error
        attempts INTEGER DEFAULT 0,
        error TEXT,
        size INTEGER,
        added_at INTEGER,
        updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_queue_status ON upload_queue(status);
      CREATE TABLE IF NOT EXISTS cloud_covers (
        storage_id INTEGER NOT NULL,
        cover_key TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        iv TEXT,
        PRIMARY KEY (storage_id, cover_key)
      );
    `);
    for (const col of ['manifest_id INTEGER', 'manifest_at INTEGER', 'manifest_iv TEXT']) {
      try { d.exec(`ALTER TABLE storages ADD COLUMN ${col}`); } catch { /* already there */ }
    }
    // anything "uploading" when the app closed starts over
    d.prepare("UPDATE upload_queue SET status = 'queued' WHERE status = 'uploading'").run();
    readyFor = d;
  }
  return d;
}

const toPeer = (s) => (s ? { kind: s.kind, id: s.peer_id, accessHash: s.access_hash } : null);

const storages = {
  all: () => db().prepare('SELECT * FROM storages ORDER BY id').all(),
  get: (id) => db().prepare('SELECT * FROM storages WHERE id = ?').get(id),
  byPeer: (peerId) => db().prepare('SELECT * FROM storages WHERE peer_id = ?').get(String(peerId)),
  default: () => db().prepare('SELECT * FROM storages ORDER BY is_default DESC, id LIMIT 1').get(),
  add({ kind, peerId, accessHash, title, isDefault }) {
    const d = db();
    if (isDefault) d.prepare('UPDATE storages SET is_default = 0').run();
    d.prepare(`INSERT INTO storages (kind, peer_id, access_hash, title, is_default) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(peer_id) DO UPDATE SET access_hash = excluded.access_hash, title = excluded.title, is_default = MAX(is_default, excluded.is_default)`)
      .run(kind, String(peerId), accessHash ? String(accessHash) : null, title || null, isDefault ? 1 : 0);
    return storages.byPeer(peerId);
  },
  setIndexed: (id, messageId) => db().prepare('UPDATE storages SET last_indexed_id = MAX(last_indexed_id, ?) WHERE id = ?').run(messageId, id),
  resetIndex: (id) => db().prepare('UPDATE storages SET last_indexed_id = 0 WHERE id = ?').run(id),
  /** Remember the newest manifest message seen in the chat */
  setManifest: (id, messageId, iv, at) => db().prepare('UPDATE storages SET manifest_id = ?, manifest_iv = ?, manifest_at = ? WHERE id = ? AND (manifest_id IS NULL OR manifest_id <= ?)').run(messageId, iv || null, at || Date.now(), id, messageId),
  clearManifest: (id) => db().prepare('UPDATE storages SET manifest_id = NULL, manifest_iv = NULL, manifest_at = NULL WHERE id = ?').run(id),
  clear: () => db().prepare('DELETE FROM storages').run(),
  count: () => db().prepare('SELECT COUNT(*) AS n FROM storages').get().n,
  setDefault: (id) => db().transaction(() => {
    db().prepare('UPDATE storages SET is_default = 0').run();
    db().prepare('UPDATE storages SET is_default = 1 WHERE id = ?').run(id);
  })(),
  rename: (id, title) => db().prepare('UPDATE storages SET title = ? WHERE id = ?').run(title, id),
  /** Forget a storage on this computer (its Telegram messages stay) */
  remove(id) {
    const d = db();
    d.transaction(() => {
      d.prepare('DELETE FROM cloud_index WHERE storage_id = ?').run(id);
      d.prepare('DELETE FROM cloud_covers WHERE storage_id = ?').run(id);
      d.prepare('DELETE FROM upload_queue WHERE storage_id = ?').run(id);
      const wasDefault = d.prepare('SELECT is_default FROM storages WHERE id = ?').get(id)?.is_default;
      d.prepare('DELETE FROM storages WHERE id = ?').run(id);
      if (wasDefault) d.prepare('UPDATE storages SET is_default = 1 WHERE id = (SELECT MIN(id) FROM storages)').run();
    })();
  },
  /** Tracks and bytes per storage, from the library rows linked to it */
  stats: () => db().prepare("SELECT telegram_channel_id AS peer, COUNT(*) AS tracks, COALESCE(SUM(size), 0) AS bytes FROM music_files WHERE telegram_message_id IS NOT NULL GROUP BY telegram_channel_id").all(),
};

const index = {
  put(storageId, e) {
    db().prepare(`INSERT INTO cloud_index (storage_id, message_id, sha256, size, name, iv, info, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(storage_id, message_id) DO UPDATE SET sha256 = excluded.sha256, size = excluded.size, name = excluded.name, iv = excluded.iv, info = excluded.info`)
      .run(storageId, e.messageId, e.sha256 || null, e.size || null, e.name || null, e.iv || null, e.info ? JSON.stringify(e.info) : null, e.date || Date.now());
  },
  get: (storageId, messageId) => db().prepare('SELECT * FROM cloud_index WHERE storage_id = ? AND message_id = ?').get(storageId, messageId),
  bySha: (storageId, sha) => db().prepare('SELECT * FROM cloud_index WHERE storage_id = ? AND sha256 = ? LIMIT 1').get(storageId, sha),
  /** The same audio already in any storage (each track is kept in one place only) */
  byShaAnywhere: (sha) => db().prepare('SELECT * FROM cloud_index WHERE sha256 = ? ORDER BY storage_id LIMIT 1').get(sha),
  all: (storageId) => db().prepare('SELECT * FROM cloud_index WHERE storage_id = ? ORDER BY message_id').all(storageId),
  remove: (storageId, ids) => {
    const st = db().prepare('DELETE FROM cloud_index WHERE storage_id = ? AND message_id = ?');
    db().transaction(() => ids.forEach(id => st.run(storageId, id)))();
  },
  clear: () => db().prepare('DELETE FROM cloud_index').run(),
  stats: () => db().prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM cloud_index').get(),
};

const coversStore = {
  get: (storageId, key) => db().prepare('SELECT * FROM cloud_covers WHERE storage_id = ? AND cover_key = ?').get(storageId, key),
  put: (storageId, key, messageId, iv) => db().prepare(`INSERT INTO cloud_covers (storage_id, cover_key, message_id, iv) VALUES (?, ?, ?, ?)
    ON CONFLICT(storage_id, cover_key) DO UPDATE SET message_id = excluded.message_id, iv = excluded.iv`).run(storageId, key, messageId, iv || null),
  all: (storageId) => db().prepare('SELECT * FROM cloud_covers WHERE storage_id = ?').all(storageId),
  remove: (storageId, key) => db().prepare('DELETE FROM cloud_covers WHERE storage_id = ? AND cover_key = ?').run(storageId, key),
  clear: () => db().prepare('DELETE FROM cloud_covers').run(),
};

const queue = {
  add(paths, storageId) {
    const now = Date.now();
    const st = db().prepare(`INSERT INTO upload_queue (path, storage_id, status, attempts, added_at, updated_at) VALUES (?, ?, 'queued', 0, ?, ?)
      ON CONFLICT(path) DO UPDATE SET status = CASE WHEN status = 'uploading' THEN status ELSE 'queued' END, attempts = 0, error = NULL, storage_id = excluded.storage_id, updated_at = excluded.updated_at`);
    db().transaction(() => paths.forEach(p => st.run(p, storageId, now, now)))();
  },
  next: () => db().prepare("SELECT * FROM upload_queue WHERE status = 'queued' ORDER BY added_at, path LIMIT 1").get(),
  set: (p, status, extra = {}) => db().prepare('UPDATE upload_queue SET status = ?, error = ?, attempts = attempts + ?, size = COALESCE(?, size), updated_at = ? WHERE path = ?')
    .run(status, extra.error || null, extra.attempt ? 1 : 0, extra.size ?? null, Date.now(), p),
  counts() {
    const rows = db().prepare('SELECT status, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM upload_queue GROUP BY status').all();
    const out = { queued: 0, uploading: 0, done: 0, error: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  },
  errors: () => db().prepare("SELECT path, error FROM upload_queue WHERE status = 'error' ORDER BY updated_at DESC LIMIT 50").all(),
  retryErrors: () => db().prepare("UPDATE upload_queue SET status = 'queued', attempts = 0, error = NULL WHERE status = 'error'").run(),
  clearDone: () => db().prepare("DELETE FROM upload_queue WHERE status = 'done'").run(),
  clear: () => db().prepare('DELETE FROM upload_queue').run(),
};

/** Cloud columns of the library */
const library = {
  row: (p) => database.getFileByPath(p),
  linkUpload(p, { storage, messageId, sha256 }) {
    const now = new Date().toISOString();
    db().prepare(`UPDATE music_files SET storage_type = CASE WHEN storage_type = 'cloud' THEN 'cloud' ELSE 'both' END,
      telegram_message_id = ?, telegram_channel_id = ?, cloud_checksum = ?, last_synced_at = ? WHERE path = ?`)
      .run(messageId, storage.peer_id, sha256, now, p);
    database.updateSyncState(p, { telegram_message_id: messageId, telegram_channel_id: storage.peer_id, cloud_checksum: sha256, local_checksum: sha256, sync_status: 'synced', upload_progress: 100, last_synced_at: now });
  },
  /** Local tracks with no cloud copy yet */
  notUploaded: () => db().prepare("SELECT path FROM music_files WHERE (storage_type IS NULL OR storage_type = 'local') AND path NOT LIKE 'tc://%'").all().map(r => r.path),
  linkedMessages: (peerId) => new Set(db().prepare('SELECT telegram_message_id AS id FROM music_files WHERE telegram_channel_id = ?').all(String(peerId)).map(r => r.id)),
  byChecksum: (sha) => db().prepare('SELECT * FROM music_files WHERE cloud_checksum = ? LIMIT 1').get(sha),
  setCache: (p, cachePath) => db().prepare('UPDATE music_files SET cache_path = ? WHERE path = ?').run(cachePath, p),
  setCover: (p, key) => db().prepare('UPDATE music_files SET cloud_cover = ? WHERE path = ?').run(key, p),
  /** Backed-up local tracks of this chat that have no cloud cover recorded yet */
  withoutCover: (peerId) => db().prepare("SELECT path FROM music_files WHERE telegram_channel_id = ? AND storage_type = 'both' AND (cloud_cover IS NULL OR cloud_cover = '') AND path NOT LIKE 'tc://%'").all(String(peerId)).map(r => r.path),
  /** Unlink every track of a removed storage: cloud-only rows go, local ones become plain local */
  unlinkStorage(peerId) {
    const d = db();
    const gone = d.prepare("SELECT path FROM music_files WHERE telegram_channel_id = ? AND (storage_type = 'cloud' OR path LIKE 'tc://%')").all(String(peerId)).map(r => r.path);
    const kept = d.prepare("SELECT path FROM music_files WHERE telegram_channel_id = ? AND NOT (storage_type = 'cloud' OR path LIKE 'tc://%')").all(String(peerId)).map(r => r.path);
    d.transaction(() => {
      d.prepare("DELETE FROM music_files WHERE telegram_channel_id = ? AND (storage_type = 'cloud' OR path LIKE 'tc://%')").run(String(peerId));
      d.prepare("UPDATE music_files SET storage_type = 'local', telegram_message_id = NULL, telegram_channel_id = NULL, cloud_checksum = NULL, cloud_cover = NULL, last_synced_at = NULL WHERE telegram_channel_id = ?").run(String(peerId));
    })();
    return { gone, kept };
  },
  /** Point a track at its copy in another storage (after a move) */
  relink: (p, peerId, messageId) => db().prepare('UPDATE music_files SET telegram_channel_id = ?, telegram_message_id = ? WHERE path = ?').run(String(peerId), messageId, p),
  /** Library rows linked to a message of this chat (the most complete info we have about it) */
  byMessage: (peerId, messageId) => db().prepare("SELECT * FROM music_files WHERE telegram_channel_id = ? AND telegram_message_id = ? ORDER BY (storage_type = 'cloud') LIMIT 1").get(String(peerId), messageId),
  coverUsers: (peerId, key) => db().prepare('SELECT COUNT(*) AS n FROM music_files WHERE telegram_channel_id = ? AND cloud_cover = ?').get(String(peerId), key).n,
  linkCount: (peerId, messageId) => db().prepare('SELECT COUNT(*) AS n FROM music_files WHERE telegram_channel_id = ? AND telegram_message_id = ?').get(String(peerId), messageId).n,
  cached: () => db().prepare("SELECT path, cache_path FROM music_files WHERE cache_path IS NOT NULL AND cache_path != ''").all(),
  syncedStats: () => db().prepare("SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM music_files WHERE telegram_message_id IS NOT NULL").get(),
  /** Earlier versions stored restored tracks as "restored/<file name>"; give them stable tc:// paths */
  migrateLegacyPaths() {
    const rows = db().prepare("SELECT path, telegram_channel_id AS peer, telegram_message_id AS id FROM music_files WHERE path LIKE 'restored%' AND telegram_message_id IS NOT NULL").all();
    const st = db().prepare('UPDATE OR IGNORE music_files SET path = ? WHERE path = ?');
    db().transaction(() => rows.forEach(r => st.run(`tc://${r.peer}/${r.id}`, r.path)))();
    return rows.length;
  },
  /** Every track with a cloud link or a cached copy (what "Delete backup" changes) */
  cloudRows: () => db().prepare(`SELECT path, (storage_type = 'cloud' OR path LIKE 'tc://%') AS cloudOnly FROM music_files
    WHERE telegram_message_id IS NOT NULL OR storage_type IN ('cloud', 'both') OR (cache_path IS NOT NULL AND cache_path != '') OR path LIKE 'tc://%'`).all(),
  /** Delete all: forget every cloud link but keep the local library */
  resetCloud() {
    const d = db();
    d.transaction(() => {
      d.prepare("DELETE FROM music_files WHERE storage_type = 'cloud' OR path LIKE 'tc://%'").run();
      d.prepare("UPDATE music_files SET storage_type = 'local', telegram_message_id = NULL, telegram_channel_id = NULL, cloud_checksum = NULL, cache_path = NULL, last_synced_at = NULL, cloud_cover = NULL").run();
      d.prepare('DELETE FROM cloud_covers').run();
      d.prepare('UPDATE storages SET manifest_id = NULL, manifest_iv = NULL, manifest_at = NULL').run();
      d.prepare('DELETE FROM sync_state').run();
    })();
  },
};

module.exports = { db, storages, index, queue, library, covers: coversStore, toPeer };
