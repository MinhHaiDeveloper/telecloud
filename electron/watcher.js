// Watches the music folders with one native recursive watcher per folder (ReadDirectoryChangesW
// on Windows): no per-file handles, so starting it costs nothing even for 10k+ tracks.
// Events are only a hint: after things settle we run a normal refresh, which works out what was
// added, changed, moved or deleted (including whole folders) from the database diff.

const fs = require('fs');
const path = require('path');
const { AUDIO_EXTENSIONS } = require('./paths');

const QUIET_MS = 1500;   // wait for copies to settle before refreshing
const MAX_WAIT_MS = 6000; // but refresh at least this often during a long copy
const FALLBACK_POLL_MS = 60000;

class MusicFolderWatcher {
    constructor(folders, onChange) {
        this.folders = folders.map(f => path.resolve(f));
        this.onChange = onChange;
        this.watchers = [];
        this.timer = null;
        this.firstEventAt = 0;
        this.pollTimer = null;
    }

    start() {
        if (this.watchers.length || this.pollTimer) return;
        let needsPolling = false;
        for (const folder of this.folders) {
            try {
                const w = fs.watch(folder, { recursive: true, persistent: false }, (eventType, filename) => this.handle(filename));
                w.on('error', (err) => {
                    console.error(`[Watcher] ${folder}: ${err.message}; falling back to periodic refresh`);
                    this.startPolling();
                });
                this.watchers.push(w);
            } catch (err) {
                // e.g. a network share that doesn't support change notifications
                console.error(`[Watcher] Cannot watch ${folder}: ${err.message}`);
                needsPolling = true;
            }
        }
        if (needsPolling) this.startPolling();
    }

    handle(filename) {
        if (filename) {
            const name = String(filename);
            const base = path.basename(name);
            if (base.startsWith('.')) return;
            const ext = path.extname(name).toLowerCase();
            // Audio files matter; extension-less names may be folders being moved in or out
            if (ext && !AUDIO_EXTENSIONS.has(ext)) return;
        }
        const now = Date.now();
        if (!this.timer) this.firstEventAt = now;
        clearTimeout(this.timer);
        const wait = Math.max(0, Math.min(QUIET_MS, this.firstEventAt + MAX_WAIT_MS - now));
        this.timer = setTimeout(() => {
            this.timer = null;
            this.onChange();
        }, wait);
    }

    startPolling() {
        if (this.pollTimer) return;
        this.pollTimer = setInterval(() => this.onChange(), FALLBACK_POLL_MS);
    }

    stop() {
        this.watchers.forEach(w => { try { w.close(); } catch { /* already closed */ } });
        this.watchers = [];
        clearTimeout(this.timer);
        this.timer = null;
        clearInterval(this.pollTimer);
        this.pollTimer = null;
    }
}

module.exports = MusicFolderWatcher;
