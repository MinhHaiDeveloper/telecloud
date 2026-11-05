const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');
const fs = require('fs');

let db = null;

/**
 * Initialize the SQLite database for music library caching
 * @returns {Database} The database instance
 */
function initDatabase() {
    if (db) return db;

    // Create database in user data directory
    const dbPath = path.join(app.getPath('userData'), 'music-library.db');
    console.log(`[Database] Initializing at: ${dbPath}`);

    db = new Database(dbPath);

    // Enable WAL mode for better concurrent performance
    db.pragma('journal_mode = WAL');

    // Create schema
    createSchema();

    console.log('[Database] Initialized successfully');
    return db;
}

/**
 * Create database schema with tables and indexes
 */
function createSchema() {
    const schema = `
    CREATE TABLE IF NOT EXISTS music_files (
      path TEXT PRIMARY KEY,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      title TEXT,
      artist TEXT,
      album TEXT,
      year INTEGER,
      genre TEXT,
      track_number INTEGER,
      disc_number INTEGER,
      duration REAL,
      bitrate INTEGER,
      sample_rate INTEGER,
      bit_depth INTEGER,
      lyrics TEXT,
      cover TEXT,
      has_cover INTEGER DEFAULT 0,
      cover_hash TEXT,
      last_scanned INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_artist ON music_files(artist);
    CREATE INDEX IF NOT EXISTS idx_album ON music_files(album);
    CREATE INDEX IF NOT EXISTS idx_mtime ON music_files(mtime);
    CREATE INDEX IF NOT EXISTS idx_has_cover ON music_files(has_cover);
  `;

    db.exec(schema);

    // Migration: Add missing columns to existing databases
    try {
        db.exec('ALTER TABLE music_files ADD COLUMN bit_depth INTEGER');
    } catch (e) {
        // Column already exists, ignore
    }
    try {
        db.exec('ALTER TABLE music_files ADD COLUMN cover TEXT');
    } catch (e) {
        // Column already exists, ignore
    }

    // Library: file name/extension and codec details
    for (const col of ['name TEXT', 'ext TEXT', 'codec TEXT', 'lossless INTEGER', 'cloud_cover TEXT', 'album_artist TEXT']) {
        try { db.exec(`ALTER TABLE music_files ADD COLUMN ${col}`); } catch (e) { /* exists */ }
    }

    // TeleCloud Sync: Add cloud storage columns
    try {
        db.exec('ALTER TABLE music_files ADD COLUMN storage_type TEXT DEFAULT "local"');
    } catch (e) {
        // Column already exists
    }
    try {
        db.exec('ALTER TABLE music_files ADD COLUMN telegram_message_id INTEGER');
    } catch (e) {
        // Column already exists
    }
    try {
        db.exec('ALTER TABLE music_files ADD COLUMN telegram_channel_id TEXT');
    } catch (e) {
        // Column already exists
    }
    try {
        db.exec('ALTER TABLE music_files ADD COLUMN cache_path TEXT');
    } catch (e) {
        // Column already exists
    }
    try {
        db.exec('ALTER TABLE music_files ADD COLUMN cloud_checksum TEXT');
    } catch (e) {
        // Column already exists
    }
    try {
        db.exec('ALTER TABLE music_files ADD COLUMN last_synced_at TEXT');
    } catch (e) {
        // Column already exists
    }

    // Create sync_state table for TeleCloud Sync
    const syncStateSchema = `
        CREATE TABLE IF NOT EXISTS sync_state (
            file_path TEXT PRIMARY KEY,
            telegram_message_id INTEGER,
            telegram_channel_id TEXT,
            last_synced_at TEXT,
            local_checksum TEXT,
            cloud_checksum TEXT,
            sync_status TEXT DEFAULT 'pending_upload',
            upload_progress INTEGER DEFAULT 0,
            download_progress INTEGER DEFAULT 0,
            error_message TEXT,
            retry_count INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_sync_status ON sync_state(sync_status);
    `;
    db.exec(syncStateSchema);
}

/**
 * Get cached metadata for a specific file
 * @param {string} filePath - Absolute path to the file
 * @returns {Object|null} Cached file metadata or null if not found
 */
function getFileByPath(filePath) {
    if (!db) initDatabase();

    const stmt = db.prepare('SELECT * FROM music_files WHERE path = ?');
    return stmt.get(filePath);
}

/**
 * Insert or update file metadata in cache.
 * Cloud columns (storage_type, telegram_*, cache_path) are never touched here.
 */
const UPSERT_SQL = `
    INSERT INTO music_files (
      path, name, ext, mtime, size, title, artist, album, album_artist, year, genre,
      track_number, disc_number, duration, bitrate, sample_rate, bit_depth,
      codec, lossless, lyrics, cover, has_cover, cover_hash, last_scanned, created_at
    ) VALUES (
      @path, @name, @ext, @mtime, @size, @title, @artist, @album, @albumArtist, @year, @genre,
      @trackNumber, @discNumber, @duration, @bitrate, @sampleRate, @bitDepth,
      @codec, @lossless, @lyrics, @cover, @hasCover, @coverHash, @lastScanned, @addedAt
    )
    ON CONFLICT(path) DO UPDATE SET
      name = @name,
      ext = @ext,
      codec = @codec,
      lossless = @lossless,
      mtime = @mtime,
      size = @size,
      title = @title,
      artist = @artist,
      album = @album,
      album_artist = @albumArtist,
      year = @year,
      genre = @genre,
      track_number = @trackNumber,
      disc_number = @discNumber,
      duration = @duration,
      bitrate = @bitrate,
      sample_rate = @sampleRate,
      bit_depth = @bitDepth,
      lyrics = @lyrics,
      cover = @cover,
      has_cover = @hasCover,
      cover_hash = @coverHash,
      last_scanned = @lastScanned
  `;
let upsertStmt = null;

function upsertParams(fileData) {
    return {
        path: fileData.path,
        name: fileData.name || path.basename(fileData.path),
        ext: (fileData.ext || path.extname(fileData.path)).toLowerCase(),
        mtime: fileData.mtime || 0,
        size: fileData.size || 0,
        title: fileData.title || null,
        artist: fileData.artist || null,
        album: fileData.album || null,
        // null: not read yet (older library); '' : the file has no such tag
        albumArtist: fileData.albumArtist ?? null,
        year: fileData.year || null,
        genre: fileData.genre || null,
        trackNumber: fileData.trackNumber || null,
        discNumber: fileData.discNumber || null,
        duration: fileData.duration || null,
        bitrate: fileData.bitrate || null,
        sampleRate: fileData.sampleRate || null,
        bitDepth: fileData.bitDepth || null,
        codec: fileData.codec || null,
        lossless: fileData.lossless ?? null,
        lyrics: fileData.lyrics || null,
        cover: fileData.cover || null,
        hasCover: fileData.hasCover ? 1 : 0,
        coverHash: fileData.coverHash || null,
        lastScanned: Date.now(),
        // Only used when the row is first inserted; updates keep the original "added" time
        addedAt: fileData.addedAt || Date.now()
    };
}

function insertOrUpdateFile(fileData) {
    if (!db) initDatabase();
    if (!upsertStmt) upsertStmt = db.prepare(UPSERT_SQL);
    upsertStmt.run(upsertParams(fileData));
}

/** Many upserts in one transaction (one disk sync instead of one per file). */
function insertOrUpdateFilesBatch(filesData) {
    if (!db) initDatabase();
    if (!filesData || filesData.length === 0) return;
    if (!upsertStmt) upsertStmt = db.prepare(UPSERT_SQL);
    db.transaction((list) => { for (const f of list) upsertStmt.run(upsertParams(f)); })(filesData);
}

function countFiles() {
    if (!db) initDatabase();
    return db.prepare('SELECT COUNT(*) AS n FROM music_files').get().n;
}

/** Rows for the given paths (used to send freshly scanned tracks to the UI). */
function getFilesByPaths(paths) {
    if (!db) initDatabase();
    const stmt = db.prepare('SELECT * FROM music_files WHERE path = ?');
    return paths.map(p => stmt.get(p)).filter(Boolean);
}

/**
 * Delete a file from cache
 * @param {string} filePath - Absolute path to the file
 * @returns {void}
 */
function deleteFile(filePath) {
    if (!db) initDatabase();

    const stmt = db.prepare('DELETE FROM music_files WHERE path = ?');
    stmt.run(filePath);
}

/**
 * Delete multiple files in a transaction
 * @param {Array<string>} filePaths - Array of file paths to delete
 * @returns {void}
 */
function deleteFilesBatch(filePaths) {
    if (!db) initDatabase();
    if (!filePaths || filePaths.length === 0) return;

    const stmt = db.prepare('DELETE FROM music_files WHERE path = ?');

    const deleteMany = db.transaction((paths) => {
        for (const path of paths) {
            stmt.run(path);
        }
    });

    deleteMany(filePaths);
}

/**
 * Get all cached files
 * @returns {Array<Object>} Array of all cached file metadata
 */
function getAllFiles() {
    if (!db) initDatabase();

    // Oldest first, so "recently added" is simply the end of the list. Files added in the
    // same scan share one timestamp; within a scan the newest file on disk counts as newest.
    const stmt = db.prepare('SELECT * FROM music_files ORDER BY created_at, mtime, path');
    return stmt.all();
}

/** Mark a track as living only in the cloud (its local copy is gone). */
function setStorageType(filePath, storageType) {
    if (!db) initDatabase();
    db.prepare('UPDATE music_files SET storage_type = ? WHERE path = ?').run(storageType, filePath);
}

/**
 * Get files that need updating based on mtime comparison
 * @param {Array<Object>} currentFiles - Array of {path, mtime, size} from disk
 * @returns {Object} { needsUpdate: Array, cached: Array, deleted: Array }
 */
function getFilesNeedingUpdate(currentFiles) {
    if (!db) initDatabase();

    const needsUpdate = [];
    const cached = [];
    const diskPaths = new Set();

    // Build a map of current files on disk
    const diskMap = {};
    for (const file of currentFiles) {
        diskMap[file.path] = file;
        diskPaths.add(file.path);
    }

    // Get all cached files
    const cachedFiles = getAllFiles();
    const cachedPaths = new Set(cachedFiles.map(f => f.path));

    // Check each file on disk
    for (const file of currentFiles) {
        const cachedFile = cachedFiles.find(cf => cf.path === file.path);

        if (!cachedFile) {
            // New file - needs parsing
            needsUpdate.push(file);
        } else if (cachedFile.mtime !== file.mtime) {
            // File modified - needs re-parsing
            needsUpdate.push(file);
        } else {
            // File unchanged - use cached data
            cached.push(cachedFile);
        }
    }

    // Find deleted files (in cache but not on disk)
    // ☁️ TeleCloud Sync: Don't delete files that are cloud-only or both
    const deleted = cachedFiles
        .filter(cf => !diskPaths.has(cf.path) && cf.storage_type === 'local')
        .map(cf => cf.path);

    return { needsUpdate, cached, deleted };
}

/**
 * Clear all data from database (for debugging)
 * @returns {void}
 */
function clearDatabase() {
    if (!db) initDatabase();

    db.prepare('DELETE FROM music_files').run();
    console.log('[Database] All data cleared');
}

/**
 * Get database statistics
 * @returns {Object} Database statistics
 */
function getStats() {
    if (!db) initDatabase();

    const totalFiles = db.prepare('SELECT COUNT(*) as count FROM music_files').get().count;
    const filesWithCovers = db.prepare('SELECT COUNT(*) as count FROM music_files WHERE has_cover = 1').get().count;
    const filesWithLyrics = db.prepare('SELECT COUNT(*) as count FROM music_files WHERE lyrics IS NOT NULL AND lyrics != ""').get().count;

    return {
        totalFiles,
        filesWithCovers,
        filesWithLyrics
    };
}

/**
 * TeleCloud Sync: Get sync state for a file or all files
 * @param {string} [filePath] - Optional file path to get specific sync state
 * @returns {Object|Array} Sync state object or array of all sync states
 */
function getSyncState(filePath = null) {
    if (!db) initDatabase();

    if (filePath) {
        const stmt = db.prepare('SELECT * FROM sync_state WHERE file_path = ?');
        return stmt.get(filePath);
    } else {
        const stmt = db.prepare('SELECT * FROM sync_state');
        return stmt.all();
    }
}

/**
 * TeleCloud Sync: Update sync state for a file
 * @param {string} filePath - File path
 * @param {Object} stateData - Sync state data
 * @returns {void}
 */
function updateSyncState(filePath, stateData) {
    if (!db) initDatabase();

    const stmt = db.prepare(`
        INSERT INTO sync_state (
            file_path, telegram_message_id, telegram_channel_id,
            last_synced_at, local_checksum, cloud_checksum,
            sync_status, upload_progress, download_progress,
            error_message, retry_count, updated_at
        ) VALUES (
            @filePath, @telegramMessageId, @telegramChannelId,
            @lastSyncedAt, @localChecksum, @cloudChecksum,
            @syncStatus, @uploadProgress, @downloadProgress,
            @errorMessage, @retryCount, CURRENT_TIMESTAMP
        )
        ON CONFLICT(file_path) DO UPDATE SET
            telegram_message_id = @telegramMessageId,
            telegram_channel_id = @telegramChannelId,
            last_synced_at = @lastSyncedAt,
            local_checksum = @localChecksum,
            cloud_checksum = @cloudChecksum,
            sync_status = @syncStatus,
            upload_progress = @uploadProgress,
            download_progress = @downloadProgress,
            error_message = @errorMessage,
            retry_count = @retryCount,
            updated_at = CURRENT_TIMESTAMP
    `);

    stmt.run({
        filePath: filePath,
        telegramMessageId: stateData.telegram_message_id || null,
        telegramChannelId: stateData.telegram_channel_id || null,
        lastSyncedAt: stateData.last_synced_at || null,
        localChecksum: stateData.local_checksum || null,
        cloudChecksum: stateData.cloud_checksum || null,
        syncStatus: stateData.sync_status || 'pending_upload',
        uploadProgress: stateData.upload_progress || 0,
        downloadProgress: stateData.download_progress || 0,
        errorMessage: stateData.error_message || null,
        retryCount: stateData.retry_count || 0
    });
}

/**
 * TeleCloud Sync: Get files by sync status
 * @param {string} status - Sync status to filter by
 * @returns {Array} Array of sync state objects
 */
function getSyncStateByStatus(status) {
    if (!db) initDatabase();

    const stmt = db.prepare('SELECT * FROM sync_state WHERE sync_status = ?');
    return stmt.all(status);
}

/**
 * TeleCloud Sync: Delete sync state for a file
 * @param {string} filePath - File path
 * @returns {void}
 */
function deleteSyncState(filePath) {
    if (!db) initDatabase();

    const stmt = db.prepare('DELETE FROM sync_state WHERE file_path = ?');
    stmt.run(filePath);
}

/**
 * TeleCloud Sync: Update cloud metadata in music_files table
 * @param {string} filePath - File path
 * @param {Object} cloudData - Cloud metadata
 * @returns {void}
 */
function updateCloudMetadata(filePath, cloudData) {
    if (!db) initDatabase();

    // First check if file exists
    const existing = getFileByPath(filePath);

    if (!existing) {
        console.warn(`[Database] updateCloudMetadata: File not found in database: ${filePath}`);
        console.warn(`[Database] Cloud metadata will be lost. Ensure file is scanned before syncing.`);
        return;
    }

    const stmt = db.prepare(`
        UPDATE music_files
        SET
            storage_type = @storageType,
            telegram_message_id = @telegramMessageId,
            telegram_channel_id = @telegramChannelId,
            cache_path = @cachePath,
            cloud_checksum = @cloudChecksum,
            last_synced_at = @lastSyncedAt
        WHERE path = @filePath
    `);

    const result = stmt.run({
        filePath: filePath,
        storageType: cloudData.storage_type || 'both',
        telegramMessageId: cloudData.telegram_message_id || null,
        telegramChannelId: cloudData.telegram_channel_id || null,
        cachePath: cloudData.cache_path || null,
        cloudChecksum: cloudData.cloud_checksum || null,
        lastSyncedAt: cloudData.last_synced_at || null
    });

    if (result.changes > 0) {
        console.log(`[Database] Updated cloud metadata for: ${filePath} (message_id: ${cloudData.telegram_message_id})`);
    } else {
        console.error(`[Database] Failed to update cloud metadata for: ${filePath}`);
    }
}

/**
 * Close database connection
 */
function closeDatabase() {
    if (db) {
        db.close();
        db = null;
        upsertStmt = null;
        console.log('[Database] Connection closed');
    }
}

/**
 * Update metadata for a batch of files.
 * This is optimized for updating only lyrics and covers.
 * @param {Array<Object>} filesToUpdate - Array of file objects with path, lyrics, and cover
 */
function updateMetadataBatch(filesToUpdate) {
    if (!db) initDatabase();
    if (!filesToUpdate || filesToUpdate.length === 0) return;

    const stmt = db.prepare(`
        UPDATE music_files
        SET
            lyrics = @lyrics,
            cover = @cover,
            has_cover = CASE WHEN @cover IS NOT NULL AND @cover != '' THEN 1 ELSE has_cover END
        WHERE path = @path
    `);

    const updateMany = db.transaction((files) => {
        for (const file of files) {
            if (!file.path) continue;
            stmt.run({
                path: file.path,
                lyrics: file.lyrics,
                cover: file.cover
            });
        }
    });

    try {
        updateMany(filesToUpdate);
        console.log(`[Database] Batch updated metadata for ${filesToUpdate.length} files.`);
    } catch (err) {
        console.error('[Database] Batch metadata update failed:', err);
    }
}

module.exports = {
    initDatabase,
    getFileByPath,
    insertOrUpdateFile,
    insertOrUpdateFilesBatch,
    getFilesByPaths,
    countFiles,
    deleteFile,
    deleteFilesBatch,
    getAllFiles,
    setStorageType,
    getFilesNeedingUpdate,
    clearDatabase,
    getStats,
    closeDatabase,
    // TeleCloud Sync functions
    getSyncState,
    updateSyncState,
    getSyncStateByStatus,
    deleteSyncState,
    updateCloudMetadata,
    updateMetadataBatch,
    clearSyncData
};


/**
 * TeleCloud Sync: Clear all sync-related data from the database.
 * This truncates both music_files and sync_state tables.
 * @returns {void}
 */
function clearSyncData() {
    if (!db) initDatabase();

    try {
        db.exec('DELETE FROM music_files');
        db.exec('DELETE FROM sync_state');
        // We also reset the sqlite sequence to ensure new primary keys start from 1
        db.exec("DELETE FROM sqlite_sequence WHERE name IN ('music_files', 'sync_state')");
        console.log('[Database] All TeleCloud sync data has been cleared.');
    } catch (error) {
        console.error('[Database] Failed to clear sync data:', error);
    }
}
