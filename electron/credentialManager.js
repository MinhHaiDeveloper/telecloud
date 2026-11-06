// TeleCloud Sync credential storage.
// Secrets are encrypted with Electron safeStorage (Windows DPAPI: the key is bound to the
// Windows user account and never stored next to the data). Values written by the old
// AES scheme, whose key sat in the same file, are decrypted once and re-saved.

const crypto = require('crypto');
const { safeStorage } = require('electron');

const PREFIX = 'v2:';
const SECRET_FIELDS = ['apiId', 'apiHash', 'session', 'masterKey'];

class CredentialManager {
    constructor(store) {
        this.store = store;
        this.migrateLegacy();
    }

    canEncrypt() {
        return safeStorage.isEncryptionAvailable();
    }

    encrypt(text) {
        if (text === undefined || text === null || text === '') return null;
        if (!this.canEncrypt()) throw new Error('OS-level encryption is not available on this system');
        return PREFIX + safeStorage.encryptString(String(text)).toString('base64');
    }

    decrypt(value) {
        if (!value) return null;
        try {
            if (value.startsWith(PREFIX)) {
                return safeStorage.decryptString(Buffer.from(value.slice(PREFIX.length), 'base64'));
            }
            return this.decryptLegacy(value);
        } catch (error) {
            console.error('[Credentials] Decryption failed:', error.message);
            return null;
        }
    }

    // Old format: "ivHex:cipherHex" with an AES-256-CBC key stored in the same store
    decryptLegacy(value) {
        const key = this.store.get('_encryptionKey');
        if (!key) return null;
        const [ivHex, data] = value.split(':');
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'hex'), Buffer.from(ivHex, 'hex'));
        return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8');
    }

    migrateLegacy() {
        const raw = this.store.get('teleCloudSync');
        const legacy = raw && SECRET_FIELDS.some(f => raw[f] && !String(raw[f]).startsWith(PREFIX));
        if (!legacy && !this.store.has('_encryptionKey')) return;
        if (!this.canEncrypt()) return; // keep old data until the OS can protect it
        try {
            if (legacy) this.saveCredentials(this.getCredentials());
            this.store.delete('_encryptionKey');
            console.log('[Credentials] Migrated to OS-protected storage');
        } catch (err) {
            console.error('[Credentials] Migration failed:', err.message);
        }
    }

    saveCredentials(credentials) {
        this.store.set('teleCloudSync', {
            apiId: this.encrypt(credentials.apiId?.toString()),
            apiHash: this.encrypt(credentials.apiHash),
            phoneNumber: credentials.phoneNumber,
            session: this.encrypt(credentials.session),
            masterKey: this.encrypt(credentials.masterKey),
            enabled: credentials.enabled || false,
            autoSync: credentials.autoSync || false,
            syncAudioFiles: credentials.syncAudioFiles || false,
            storageLocation: credentials.storageLocation || 'private_channel',
            channelId: credentials.channelId || null,
            playbackMode: credentials.playbackMode || 'stream',
            cacheLimit: credentials.cacheLimit || 50,
            lastSync: credentials.lastSync || null,
            musicFolders: credentials.musicFolders || []
        });
    }

    getCredentials() {
        const encrypted = this.store.get('teleCloudSync');
        if (!encrypted) return null;
        const creds = {
            apiId: this.decrypt(encrypted.apiId),
            apiHash: this.decrypt(encrypted.apiHash),
            phoneNumber: encrypted.phoneNumber,
            session: this.decrypt(encrypted.session),
            masterKey: this.decrypt(encrypted.masterKey),
            enabled: encrypted.enabled || false,
            autoSync: encrypted.autoSync || false,
            syncAudioFiles: encrypted.syncAudioFiles || false,
            storageLocation: encrypted.storageLocation || 'private_channel',
            channelId: encrypted.channelId || null,
            playbackMode: encrypted.playbackMode || 'stream',
            cacheLimit: encrypted.cacheLimit || 50,
            lastSync: encrypted.lastSync || null,
            musicFolders: encrypted.musicFolders || []
        };
        // these must never reach the log, wherever they might turn up
        require('./logger').addSecrets([creds.apiHash, creds.phoneNumber, creds.session, creds.masterKey]);
        return creds;
    }

    updateCredentials(updates) {
        const current = this.getCredentials() || {};
        this.saveCredentials({ ...current, ...updates });
    }

    deleteCredentials() {
        this.store.delete('teleCloudSync');
    }

    hasCredentials() {
        return this.store.has('teleCloudSync');
    }

    isAuthenticated() {
        const creds = this.getCredentials();
        return !!(creds && creds.session && creds.apiId && creds.apiHash);
    }
}

module.exports = CredentialManager;
