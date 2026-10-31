const { contextBridge, ipcRenderer } = require('electron');

// Only these channels can be reached from the renderer. Anything else is rejected,
// so a compromised page cannot call arbitrary main-process handlers.
const INVOKE_CHANNELS = new Set([
    'analysis:cancel',
    'autoeq:measurement',
    'autoeq:search',
    'autoeq:target',
    'autoeq:targets',
    'analysis:spectrum',
    'apply-audio-settings',
    'check-file-exists',
    'clear-database-and-cache',
    'delete-song',
    'download-song',
    'get-audio-devices',
    'get-audio-settings',
    'get-temp-path',
    'library:cancel',
    'library:sync',
    'load-library',
    'load-store',
    'open-external',
    'pause-audio',
    'play-audio',
    'player:set-next',
    'save-store',
    'seek-audio',
    'select-music-folder',
    'set-audio-device',
    'set-eq',
    'set-mute',
    'set-volume',
    'start-watching',
    'stop-audio',
    'stop-watching',
    'telecloud-sync:check-auth',
    'telecloud-sync:check-sync-status',
    'telecloud-sync:complete-setup',
    'telecloud-sync:delete-all',
    'telecloud-sync:disconnect',
    'telecloud-sync:cache-track',
    'telecloud-sync:check-password',
    'telecloud-sync:clear-cache',
    'telecloud-sync:get-recovery-key',
    'telecloud-sync:queue-state',
    'telecloud-sync:resume',
    'telecloud-sync:set-options',
    'telecloud-sync:set-recovery-key',
    'telecloud-sync:speed-test',
    'telecloud-sync:storages',
    'telecloud-sync:storage-candidates',
    'telecloud-sync:storage-add',
    'telecloud-sync:storage-rename',
    'telecloud-sync:storage-default',
    'telecloud-sync:storage-remove',
    'telecloud-sync:backup-to',
    'telecloud-sync:move-to',
    'telecloud-sync:remove-from-cloud',
    'telecloud-sync:stream-track',
    'telecloud-sync:restore-from-cloud',
    'telecloud-sync:save-index',
    'telecloud-sync:save-temp-credentials',
    'telecloud-sync:send-code',
    'telecloud-sync:stop-sync',
    'telecloud-sync:sync-now',
    'telecloud-sync:verify-code',
]);

const EVENT_CHANNELS = new Set([
    'analysis:progress',
    'library:partial',
    'playback-error',
    'player:advanced',
    'player:audio-out',
    'player:restarted',
    'player:state',
    'scan-progress',
    'time-pos',
    'track-ended',
    'telecloud-sync:progress',
    'telecloud-sync:stopped',
    'telecloud-sync:queue',
    'telecloud-sync:stream',
    'telecloud-sync:queue-error',
    'telecloud-sync:download-progress',
]);

function assertChannel(allowed, channel) {
    if (!allowed.has(channel)) {
        throw new Error(`IPC channel not allowed: ${channel}`);
    }
}

contextBridge.exposeInMainWorld('ipcRenderer', {
    invoke: (channel, ...args) => {
        assertChannel(INVOKE_CHANNELS, channel);
        return ipcRenderer.invoke(channel, ...args);
    },
    on: (channel, listener) => {
        assertChannel(EVENT_CHANNELS, channel);
        ipcRenderer.on(channel, listener);
    },
    off: (channel, listener) => {
        assertChannel(EVENT_CHANNELS, channel);
        ipcRenderer.off(channel, listener);
    },
    removeListener: (channel, listener) => {
        assertChannel(EVENT_CHANNELS, channel);
        ipcRenderer.removeListener(channel, listener);
    },
    removeAllListeners: (channel) => {
        assertChannel(EVENT_CHANNELS, channel);
        ipcRenderer.removeAllListeners(channel);
    },
});

contextBridge.exposeInMainWorld('electronAPI', {
    clearDatabaseAndCache: () => ipcRenderer.invoke('clear-database-and-cache'),
});
