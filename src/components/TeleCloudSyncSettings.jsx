import React, { useState, useEffect, useCallback } from 'react';
import Icon from './Icon';
import { Field, Callout, Progress, Select, SettingRow, BackButton, Toggle, MoreMenu, Dialog, confirmDialog, alertDialog } from './ui';
import { formatBytes } from '../utils/audio';

const SETUP_STEPS = [
    { id: 'credentials', label: 'API keys' },
    { id: 'phone', label: 'Phone' },
    { id: 'otp', label: 'Code' },
    { id: 'config', label: 'Storage' },
];
const RATE_OPTIONS = [0, 512, 1024, 2048, 5120, 10240].map(v => ({ value: v, label: v ? `${v >= 1024 ? `${v / 1024} MB/s` : `${v} KB/s`}` : 'Unlimited' }));
const ipc = () => window.ipcRenderer;

const Stepper = ({ step }) => {
    const idx = SETUP_STEPS.findIndex(s => s.id === (step === 'password' ? 'otp' : step));
    return (
        <div className="steps">
            {SETUP_STEPS.map((s, i) => (
                <React.Fragment key={s.id}>
                    {i > 0 && <span className={`bar ${i <= idx ? 'done' : ''}`} />}
                    <span className={`step ${i === idx ? 'on' : ''} ${i < idx ? 'done' : ''}`}>
                        <i>{i < idx ? '✓' : i + 1}</i>{s.label}
                    </span>
                </React.Fragment>
            ))}
        </div>
    );
};

const eta = (bytesLeft, speed) => {
    if (!speed || speed < 1) return '';
    const s = Math.round(bytesLeft / speed);
    return s < 60 ? `${s}s left` : s < 3600 ? `${Math.round(s / 60)} min left` : `${(s / 3600).toFixed(1)} h left`;
};

/** What to do (and not do) so a backup always completes and stays restorable */
const TIPS = {
    do: [
        ['Leave TeleCloud open until the queue says everything is backed up.', 'Quitting mid-upload is safe, but the file in progress starts over next time.'],
        ['Press Pause before quitting in the middle of a backup.', 'Pausing saves the library index (tags, lyrics, covers) for what is already up.'],
        ['Keep your recovery key outside this computer.', 'Without it, encrypted tracks cannot be opened after a reinstall or on another computer.'],
        ['Keep the computer awake during long backups.', 'Sleep drops the connection; the current file restarts when it wakes.'],
        ['Remove, move or back up tracks from inside the app.', 'Use the track menu, Ctrl/Shift+click to pick several, or the album and playlist menus.'],
    ],
    dont: [
        ['Delete, edit or forward TeleCloud files in Telegram yourself.', 'The app cannot see those changes and the tracks stop playing.'],
        ['Delete library.tcm from a storage chat.', 'It is the index another computer restores from. Save now writes a new one.'],
        ['Leave or delete a storage channel or group in Telegram.', 'Remove the storage in Settings instead, so the library stays consistent.'],
        ['Disconnect or Delete all while a backup is running.', 'Pause first, then wait for the queue to stop.'],
        ['Move or rename your music folders during a backup.', 'Those files are skipped and retried; finish the backup first.'],
        ['Restart the app when Telegram says “waiting”.', 'That is Telegram’s rate limit. TeleCloud waits and continues by itself.'],
    ],
};
const showTips = () => alertDialog({
    title: 'Using TeleCloud safely',
    tone: 'info',
    message: (
        <div className="tc-tips">
            {[['do', 'Do', 'check'], ['dont', 'Don’t', 'close']].map(([k, label, icon]) => (
                <div key={k} className={`tc-tips-col ${k}`}>
                    <b>{label}</b>
                    <ul>{TIPS[k].map(([t, d]) => <li key={t}><Icon name={icon} /><div><span>{t}</span><small>{d}</small></div></li>)}</ul>
                </div>
            ))}
        </div>
    ),
});

/** Live backup queue: current file, speed, counts, pause/resume */
const BackupCard = ({ queue, onSync, onPause, onResume, rate, onRate }) => {
    const total = queue.queued + queue.done + queue.error + (queue.active ? 1 : 0);
    const a = queue.active;
    const busy = queue.running;
    const waiting = queue.queued > 0 && !busy;
    return (
        <>
            <SettingRow icon="refresh" title="Back up your library" desc="Uploads local tracks that are not in TeleCloud yet. Runs in the background and continues after a restart.">
                {busy
                    ? <button className="btn-outline" onClick={onPause}><Icon name="pause" />Pause</button>
                    : waiting
                        ? <button className="btn-primary" onClick={onResume}><Icon name="play" />Resume</button>
                        : <button className="btn-primary" onClick={onSync}>Back up now</button>}
            </SettingRow>
            {(busy || waiting || queue.error > 0) && (
                <div className="set-sub">
                    <div className="sync-live">
                        <div className="row">
                            {busy ? <span className="ring" /> : <Icon name={waiting ? 'pause' : 'alert'} />}
                            <b>
                                {busy ? (a?.stage === 'checking' ? 'Checking for duplicates…' : a?.stage === 'waiting' ? 'Telegram asked us to slow down, waiting…' : a?.stage === 'manifest' ? 'Saving tags, lyrics and covers…' : `Uploading ${queue.done + queue.error + 1} of ${total}`)
                                    : waiting ? `Paused · ${queue.queued.toLocaleString()} waiting` : `${queue.error} failed`}
                            </b>
                            <span className="mono" style={{ marginLeft: 'auto', color: 'var(--text-3)', fontSize: 12 }}>
                                {queue.done.toLocaleString()} done{queue.error ? ` · ${queue.error} failed` : ''}
                            </span>
                        </div>
                        <Progress value={total ? ((queue.done + queue.error) / total) * 100 : 0} />
                        {busy && a && a.size > 0 && (
                            <>
                                <div className="row">
                                    <span className="file">{a.name}</span>
                                    <span className="mono" style={{ color: 'var(--text-3)', fontSize: 12 }}>
                                        {formatBytes(a.done || 0)} / {formatBytes(a.size)}{a.speed ? ` · ${formatBytes(a.speed)}/s · ${eta(a.size - (a.done || 0), a.speed)}` : ''}
                                    </span>
                                </div>
                                <Progress value={((a.done || 0) / a.size) * 100} tone="ok" />
                            </>
                        )}
                        {queue.errors?.length > 0 && !busy && (
                            <details className="tc-errors">
                                <summary>Why did {queue.error === 1 ? 'one file' : 'some files'} fail?</summary>
                                {queue.errors.map(e => <div key={e.path} className="row"><span className="file">{e.path.split(/[\\/]/).pop()}</span><span className="err">{e.error}</span></div>)}
                                <button className="btn-ghost sm" onClick={onResume}>Retry failed</button>
                            </details>
                        )}
                    </div>
                </div>
            )}
            <SettingRow icon="sort" title="Upload speed limit" desc="Leave room for the rest of your connection while a big backup runs.">
                <Select value={rate} onChange={onRate} options={RATE_OPTIONS} align="right" />
            </SettingRow>
        </>
    );
};

/** The chats TeleCloud stores music in (up to 5) */
const StoragesSection = ({ onChanged }) => {
    const [list, setList] = useState([]);
    const [max, setMax] = useState(5);
    const [adding, setAdding] = useState(null); // null | { mode, name, chats, chatId, busy, error }
    const [renaming, setRenaming] = useState(null);
    const load = useCallback(async () => {
        const r = await ipc().invoke('telecloud-sync:storages');
        if (r.success) { setList(r.storages); setMax(r.max); }
    }, []);
    useEffect(() => { load(); }, [load]);
    const after = async (r, msg) => {
        if (!r.success) { alertDialog({ title: 'Storage', message: r.error, tone: 'danger' }); return; }
        await load();
        onChanged?.();
        if (msg) alertDialog({ title: 'Storage', message: msg, tone: 'ok' });
    };
    const openAdd = async () => {
        setAdding({ mode: 'new', name: '', chats: null, chatId: '', busy: false });
        const r = await ipc().invoke('telecloud-sync:storage-candidates');
        setAdding(a => a && { ...a, chats: r.success ? r.chats : [], error: r.success ? '' : r.error });
    };
    const add = async () => {
        setAdding(a => ({ ...a, busy: true, error: '' }));
        const r = await ipc().invoke('telecloud-sync:storage-add', adding.mode === 'new' ? { title: adding.name } : { chatId: adding.chatId });
        if (!r.success) { setAdding(a => ({ ...a, busy: false, error: r.error })); return; }
        setAdding(null);
        const found = r.existingFiles ? ` It already holds ${r.existingFiles} TeleCloud tracks: use Restore to add them to this library.` : '';
        const locked = r.needKey ? ` ${r.needKey} of its tracks need the recovery key from the computer that uploaded them.` : '';
        await after({ success: true }, `“${r.storage.title}” is ready.${found}${locked}`);
    };
    const remove = async (st) => {
        const ok = await confirmDialog({ title: `Stop using “${st.title}”?`, message: `TeleCloud forgets this chat on this computer. Its ${st.tracks} tracks stay in Telegram; cloud-only ones leave this library and the rest become plain local tracks. You can add the chat again later.`, confirmLabel: 'Stop using it', danger: true });
        if (ok) after(await ipc().invoke('telecloud-sync:storage-remove', { id: st.id }));
    };
    const saveName = async () => {
        const r = await ipc().invoke('telecloud-sync:storage-rename', { id: renaming.id, title: renaming.title });
        setRenaming(null);
        after(r);
    };
    const kindLabel = (k) => (k === 'self' ? 'Saved Messages' : k === 'group' ? 'Private group' : 'Private channel');
    return (
        <section className="set-section">
            <h3>Storages</h3>
            <div className="card set-card">
                {list.map(st => (
                    <SettingRow key={st.id} icon={st.kind === 'self' ? 'heart' : 'cloud'}
                        title={<>{st.title}{st.isDefault && <span className="badge b-local" style={{ marginLeft: 8 }}>Default</span>}</>}
                        desc={`${kindLabel(st.kind)} · ${st.tracks.toLocaleString()} tracks · ${formatBytes(st.bytes)}`}>
                        <MoreMenu items={[
                            ...(!st.isDefault ? [{ label: 'Use as default', icon: 'check', onClick: async () => after(await ipc().invoke('telecloud-sync:storage-default', { id: st.id })) }] : []),
                            ...(st.kind !== 'self' ? [{ label: 'Rename', icon: 'lyrics', onClick: () => setRenaming({ id: st.id, title: st.title }) }] : []),
                            ...(list.length > 1 ? [{ sep: true }, { label: 'Stop using', icon: 'trash', danger: true, onClick: () => remove(st) }] : []),
                        ]} />
                    </SettingRow>
                ))}
                <SettingRow icon="plus" title="Add a storage" desc={`Keep albums or playlists in separate chats, up to ${max}. “Back up now” fills the default one; use “Back up to…” on an album, playlist or track to pick another.`}>
                    <button className="btn-ghost" onClick={openAdd} disabled={list.length >= max}>{list.length >= max ? `${max} of ${max}` : 'Add'}</button>
                </SettingRow>
            </div>

            {adding && (
                <Dialog open title="Add a storage" icon="cloud" width={500} onClose={() => setAdding(null)}
                    actions={<>
                        <button className="btn-ghost" onClick={() => setAdding(null)}>Cancel</button>
                        <button className="btn-primary" onClick={add} disabled={adding.busy || (adding.mode === 'new' ? !adding.name.trim() : !adding.chatId)}>{adding.busy ? 'Adding…' : 'Add storage'}</button>
                    </>}>
                    <label className={`radio-card ${adding.mode === 'new' ? 'on' : ''}`}>
                        <input type="radio" checked={adding.mode === 'new'} onChange={() => setAdding(a => ({ ...a, mode: 'new' }))} />
                        <span className="radio-dot" />
                        <div><b>New private channel</b><span>Created in your Telegram account, visible only to you.</span></div>
                    </label>
                    {adding.mode === 'new' && <input className="input" style={{ margin: '8px 0 12px' }} autoFocus placeholder="e.g. Hi-Res Vault" value={adding.name} onChange={e => setAdding(a => ({ ...a, name: e.target.value }))} onKeyDown={e => e.key === 'Enter' && add()} />}
                    <label className={`radio-card ${adding.mode === 'existing' ? 'on' : ''}`} style={{ marginTop: 8 }}>
                        <input type="radio" checked={adding.mode === 'existing'} onChange={() => setAdding(a => ({ ...a, mode: 'existing' }))} />
                        <span className="radio-dot" />
                        <div><b>A chat you already have</b><span>Saved Messages, or a channel / private group you own. TeleCloud files already in it are found.</span></div>
                    </label>
                    {adding.mode === 'existing' && (
                        <div className="storage-pick" style={{ marginTop: 8 }}>
                            {adding.chats === null ? <div className="empty">Loading your chats…</div>
                                : adding.chats.length === 0 ? <div className="empty">No other chats you own.</div>
                                    : adding.chats.map(c => (
                                        <label key={c.id} className={`radio-card ${adding.chatId === c.id ? 'on' : ''}`}>
                                            <input type="radio" checked={adding.chatId === c.id} onChange={() => setAdding(a => ({ ...a, chatId: c.id }))} />
                                            <span className="radio-dot" />
                                            <div><b>{c.title}</b><span>{kindLabel(c.kind)}</span></div>
                                        </label>
                                    ))}
                        </div>
                    )}
                    {adding.error && <Callout tone="danger">{adding.error}</Callout>}
                </Dialog>
            )}
            {renaming && (
                <Dialog open title="Rename storage" icon="cloud" onClose={() => setRenaming(null)}
                    actions={<><button className="btn-ghost" onClick={() => setRenaming(null)}>Cancel</button><button className="btn-primary" onClick={saveName} disabled={!renaming.title.trim()}>Rename</button></>}>
                    <input className="input" autoFocus value={renaming.title} onChange={e => setRenaming(r => ({ ...r, title: e.target.value }))} onKeyDown={e => e.key === 'Enter' && saveName()} />
                    <span className="field-hint">The Telegram channel is renamed too.</span>
                </Dialog>
            )}
        </section>
    );
};

/** The pinned library index: what lets another computer show tags, lyrics and covers */
const IndexRow = ({ index, onSaved }) => {
    const [busy, setBusy] = useState(false);
    const save = async () => {
        setBusy(true);
        const r = await ipc().invoke('telecloud-sync:save-index');
        setBusy(false);
        if (!r.success) alertDialog({ title: 'Could not save the library index', message: r.error, tone: 'danger' });
        onSaved?.();
    };
    const desc = !index ? 'Tags, lyrics and album covers for your other computers.'
        : index.savedAt ? `Saved ${new Date(index.savedAt).toLocaleString()} · ${index.tracks.toLocaleString()} tracks · ${index.covers.toLocaleString()} covers${index.pending ? ' · changes waiting' : ''}`
            : index.tracks ? 'Not saved yet: other computers would only get basic track info.' : 'Saved automatically after each backup.';
    return (
        <SettingRow icon="disc" title="Library index" desc={desc}>
            <button className="btn-ghost" onClick={save} disabled={busy || !index?.tracks}>{busy ? 'Saving…' : 'Save now'}</button>
        </SettingRow>
    );
};

// Average bit rates of common lossless formats (bytes/s) and the margin a stream needs on top
const FORMATS = [['CD 16/44.1', 0.12], ['24/96', 0.55], ['24/192', 1.1], ['DSD128', 1.45]].map(([label, mb]) => ({ label, need: mb * 1048576 * 1.5 }));

/** Downloads part of a cloud track and says which formats will stream without waiting */
const SpeedTest = () => {
    const [state, setState] = useState(null);
    const run = async () => {
        setState({ running: true });
        const r = await ipc().invoke('telecloud-sync:speed-test');
        setState(r.success ? r : { error: r.error });
    };
    return (
        <>
            <SettingRow icon="spectrum" title="Streaming speed" desc="Downloads a few MB from your TeleCloud to see which formats play without waiting.">
                <button className="btn-ghost" onClick={run} disabled={state?.running}>{state?.running ? 'Testing…' : 'Test'}</button>
            </SettingRow>
            {state && !state.running && (
                <div className="set-sub">
                    {state.error ? <Callout tone="danger">{state.error}</Callout> : (
                        <>
                            <div className="speed-result"><b className="mono">{(state.bytesPerSec / 1048576).toFixed(1)} MB/s</b><span>first data after {state.firstByteMs} ms</span></div>
                            <div className="speed-formats">
                                {FORMATS.map(f => (
                                    <span key={f.label} className={`badge ${state.bytesPerSec >= f.need ? 'b-lossless' : 'b-lossy'}`}>{state.bytesPerSec >= f.need ? '✓' : '✕'} {f.label}</span>
                                ))}
                            </div>
                            {FORMATS.some(f => state.bytesPerSec < f.need) && <span className="field-hint">Formats marked ✕ still play: they buffer first, and the next track is downloaded ahead.</span>}
                        </>
                    )}
                </div>
            )}
        </>
    );
};

const RecoveryKey = ({ status, onChanged }) => {
    const [key, setKey] = useState(null);
    const [shown, setShown] = useState(false);
    const [entering, setEntering] = useState(false);
    const [draft, setDraft] = useState('');
    const [error, setError] = useState('');
    const load = async () => { const r = await ipc().invoke('telecloud-sync:get-recovery-key'); setKey(r.key); };
    useEffect(() => { load(); }, []);
    const copy = async () => { await navigator.clipboard.writeText(key); alertDialog({ title: 'Copied', message: 'Store it somewhere safe outside this computer (a password manager is ideal).', tone: 'ok' }); };
    const save = async () => {
        setError('');
        const r = await ipc().invoke('telecloud-sync:set-recovery-key', { key: draft });
        if (!r.success) { setError(r.error); return; }
        setEntering(false); setDraft(''); await load(); onChanged?.();
        const ok = await confirmDialog({ title: 'Recovery key saved', message: 'Add the tracks from your TeleCloud channel to this library now?', confirmLabel: 'Restore library' });
        if (ok) onChanged?.('restore');
    };
    return (
        <>
            <SettingRow icon="info" title="Recovery key" desc="Needed to open your encrypted files on another computer or after reinstalling. Without it they can't be decrypted, by anyone.">
                <button className="btn-ghost" onClick={() => setShown(s => !s)} disabled={!key}>{shown ? 'Hide' : 'Show'}</button>
            </SettingRow>
            {shown && key && (
                <div className="set-sub">
                    <div className="recovery-key mono">{key}</div>
                    <div className="btn-row">
                        <button className="btn-primary" onClick={copy}><Icon name="check" />Copy</button>
                        <span className="field-hint" style={{ alignSelf: 'center' }}>Key id {status.encryption?.fingerprint}</span>
                    </div>
                </div>
            )}
            <SettingRow icon="folder" title="Use the key from another computer" desc="If this library was backed up from somewhere else, enter that recovery key here.">
                <button className="btn-ghost" onClick={() => setEntering(e => !e)}>{entering ? 'Cancel' : 'Enter key'}</button>
            </SettingRow>
            {entering && (
                <div className="set-sub">
                    {error && <Callout tone="danger">{error}</Callout>}
                    <input className="input mono" value={draft} onChange={e => setDraft(e.target.value)} placeholder="XXXX-XXXX-XXXX-…" autoFocus />
                    <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn-primary" onClick={save} disabled={draft.replace(/[^a-z0-9]/gi, '').length < 52}>Use this key</button>
                    </div>
                </div>
            )}
        </>
    );
};

const TeleCloudSyncSettings = () => {
    const [step, setStep] = useState('loading');
    const [isLoading, setIsLoading] = useState(false);
    const [apiId, setApiId] = useState('');
    const [apiHash, setApiHash] = useState('');
    const [phoneNumber, setPhoneNumber] = useState('');
    const [otpCode, setOtpCode] = useState('');
    const [password, setPassword] = useState('');
    const [storageLocation, setStorageLocation] = useState('private_channel');
    const [encrypt, setEncrypt] = useState(true);
    const [cacheLimit, setCacheLimit] = useState(5);
    const [status, setStatus] = useState(null);
    const [queue, setQueue] = useState({ queued: 0, done: 0, error: 0, running: false, active: null, errors: [] });
    const [error, setError] = useState('');

    const refresh = useCallback(async () => {
        const r = await ipc().invoke('telecloud-sync:check-auth');
        if (r?.success && r.isAuthenticated) {
            setStatus(r);
            if (r.queue) setQueue(r.queue);
            setStep('connected');
        } else {
            setStep(s => (s === 'loading' || s === 'connected' ? 'info' : s));
        }
    }, []);

    useEffect(() => {
        refresh();
        const onQueue = (e, q) => setQueue(q);
        const onStopped = () => refresh();
        const onQueueError = (e, { error: msg }) => alertDialog({ title: 'Backup stopped', message: msg, tone: 'danger' });
        ipc().on('telecloud-sync:queue', onQueue);
        ipc().on('telecloud-sync:stopped', onStopped);
        ipc().on('telecloud-sync:queue-error', onQueueError);
        return () => {
            ipc().off('telecloud-sync:queue', onQueue);
            ipc().off('telecloud-sync:stopped', onStopped);
            ipc().off('telecloud-sync:queue-error', onQueueError);
        };
    }, [refresh]);

    // counts in the Account card follow the backup as it goes
    useEffect(() => { if (step === 'connected' && queue.done) refresh(); }, [queue.done]); // eslint-disable-line react-hooks/exhaustive-deps

    const goTo = (s) => { setStep(s); setError(''); };
    const run = async (fn) => {
        setIsLoading(true);
        setError('');
        try { await fn(); } catch (err) { setError(err.message); } finally { setIsLoading(false); }
    };

    const submitCredentials = () => run(async () => {
        const r = await ipc().invoke('telecloud-sync:save-temp-credentials', { apiId: apiId.trim(), apiHash: apiHash.trim() });
        if (!r.success) throw new Error(r.error);
        setStep('phone');
    });
    const sendCode = () => run(async () => {
        if (!phoneNumber) throw new Error('Enter your phone number with the country code.');
        const r = await ipc().invoke('telecloud-sync:send-code', { phoneNumber: phoneNumber.replace(/\s+/g, '') });
        if (!r.success) throw new Error(r.error || 'Failed to send code');
        setStep('otp');
    });
    const verifyCode = () => run(async () => {
        const r = await ipc().invoke('telecloud-sync:verify-code', { code: otpCode, phoneNumber: phoneNumber.replace(/\s+/g, '') });
        if (!r.success) throw new Error(/PHONE_CODE_INVALID/.test(r.error || '') ? 'That code is not right. Check Telegram and try again.' : r.error);
        setStep(r.passwordNeeded ? 'password' : 'config');
    });
    const checkPassword = () => run(async () => {
        const r = await ipc().invoke('telecloud-sync:check-password', { password });
        if (!r.success) throw new Error(/PASSWORD_HASH_INVALID/.test(r.error || '') ? 'Wrong password.' : r.error);
        setPassword('');
        setStep('config');
    });
    const finishSetup = () => run(async () => {
        const r = await ipc().invoke('telecloud-sync:complete-setup', { storageLocation, encrypt, cacheLimitGB: cacheLimit });
        if (!r.success) throw new Error(r.error || 'Setup failed');
        await refresh();
        if (r.needKey > 0) {
            alertDialog({ title: 'Encrypted files found', message: `Your ${r.storage.title} already holds ${r.needKey} encrypted tracks from another computer. Enter that recovery key under Encryption to use them.`, tone: 'info' });
        } else if (r.existingFiles > 0) {
            const ok = await confirmDialog({ title: 'Existing TeleCloud library found', message: `${r.existingFiles} tracks are already in ${r.storage.title}. Add them to this library?`, confirmLabel: 'Restore' });
            if (ok) restore(true);
        }
    });

    const disconnect = async () => {
        const ok = await confirmDialog({ title: 'Disconnect TeleCloud?', message: 'This signs this app out of Telegram and forgets the encryption key on this computer. Your files stay in Telegram; keep your recovery key to read them later.', confirmLabel: 'Disconnect' });
        if (!ok) return;
        await run(async () => { await ipc().invoke('telecloud-sync:disconnect'); setStatus(null); setStep('info'); });
    };

    const sync = async () => { const r = await ipc().invoke('telecloud-sync:sync-now'); if (!r.success) alertDialog({ title: 'Backup failed', message: r.error, tone: 'danger' }); else if (!r.queued) alertDialog({ title: 'All backed up', message: 'Every local track is already in TeleCloud.', tone: 'ok' }); };
    const pause = () => ipc().invoke('telecloud-sync:stop-sync');
    const resume = () => ipc().invoke('telecloud-sync:resume');
    const setOption = async (patch) => { const r = await ipc().invoke('telecloud-sync:set-options', patch); if (r.success) setStatus(s => ({ ...s, options: r.options, cacheBytes: r.cacheBytes })); };

    const restore = async (skipConfirm) => {
        if (!skipConfirm) {
            const ok = await confirmDialog({ title: 'Restore library from TeleCloud?', message: 'Every track in TeleCloud is added to this library as a cloud track. Audio is downloaded when you play it.', confirmLabel: 'Restore' });
            if (!ok) return;
        }
        await run(async () => {
            const r = await ipc().invoke('telecloud-sync:restore-from-cloud');
            if (!r.success) throw new Error(r.error);
            const extra = r.needKey ? `\n${r.needKey} encrypted tracks need the recovery key from the computer that uploaded them.` : '';
            const parts = [`Added ${r.restoredCount} tracks with their tags, lyrics and covers.`];
            if (r.updatedCount) parts.push(`Filled in the info of ${r.updatedCount} cloud tracks.`);
            if (r.skippedCount) parts.push(`${r.skippedCount} were already here.`);
            alertDialog({ title: 'Library restored', message: parts.join(' ') + extra, tone: r.needKey ? 'info' : 'ok' });
            refresh();
        });
    };
    const clearCache = async () => { await ipc().invoke('telecloud-sync:clear-cache'); refresh(); };
    const deleteAll = async () => {
        const ok = await confirmDialog({ title: 'Delete your TeleCloud backup?', message: 'Every file TeleCloud uploaded is deleted from Telegram. Other messages in the chat, and your local music files, are not touched. This cannot be undone.', confirmLabel: 'Delete backup', danger: true });
        if (!ok) return;
        await run(async () => {
            const r = await ipc().invoke('telecloud-sync:delete-all');
            if (!r.success) throw new Error(r.error);
            alertDialog({ title: 'Backup deleted', message: `Deleted ${r.deletedCount} files from Telegram.`, tone: 'ok' });
            refresh();
        });
    };

    const openPortal = () => ipc().invoke('open-external', 'https://my.telegram.org/apps');
    const onEnter = (fn) => (e) => { if (e.key === 'Enter') fn(); };
    const errorBox = error && <Callout tone="danger">{error}</Callout>;

    if (step === 'loading') return <div className="empty">Loading…</div>;

    if (step === 'info') {
        return (
            <div className="tc-wrap">
                <div className="card tc-hero">
                    <div className="set-icon" style={{ background: 'var(--accent-soft)', color: 'var(--accent)', width: 46, height: 46 }}><Icon name="cloud" /></div>
                    <div>
                        <h2>Use your Telegram as cloud storage</h2>
                        <p style={{ marginTop: 6 }}>Back up your library to a private Telegram channel and play it on any computer. Files stay in your own account, encrypted with a key only you have.</p>
                    </div>
                    <div className="feature-grid">
                        <div className="feature"><div className="set-icon"><Icon name="check" /></div><div><b>No subscription</b><span>No total size limit</span></div></div>
                        <div className="feature"><div className="set-icon"><Icon name="user" /></div><div><b>Encrypted</b><span>Telegram can't read your files</span></div></div>
                        <div className="feature"><div className="set-icon"><Icon name="monitor" /></div><div><b>Any computer</b><span>Restore the library anywhere</span></div></div>
                        <div className="feature"><div className="set-icon"><Icon name="disc" /></div><div><b>Lossless</b><span>Bit-for-bit, checked on download</span></div></div>
                    </div>
                    <Callout tone="info">You'll need a Telegram <b>API ID and hash</b> from my.telegram.org, and your phone number.</Callout>
                    <div className="btn-row">
                        <button className="btn-primary" onClick={() => goTo('credentials')}>Start setup<Icon name="chevron" style={{ transform: 'rotate(-90deg)' }} /></button>
                        <button className="btn-ghost" onClick={openPortal}>Get API credentials</button>
                    </div>
                </div>
            </div>
        );
    }

    if (['credentials', 'phone', 'otp', 'password', 'config'].includes(step)) {
        const back = { credentials: 'info', phone: 'credentials', otp: 'phone', password: 'otp' }[step];
        return (
            <div className="tc-wrap">
                <div className="page-head" style={{ margin: 0 }}>
                    {back && <BackButton onClick={() => goTo(back)} />}
                    <h2 style={{ fontSize: 20 }}>Set up TeleCloud</h2>
                </div>
                <Stepper step={step} />

                {step === 'credentials' && (
                    <div className="card form-card">
                        {errorBox}
                        <Field label="API ID"><input className="input mono" value={apiId} onChange={e => setApiId(e.target.value)} placeholder="12345678" onKeyDown={onEnter(submitCredentials)} autoFocus /></Field>
                        <Field label="API hash"><input className="input mono" value={apiHash} onChange={e => setApiHash(e.target.value)} placeholder="0123456789abcdef…" onKeyDown={onEnter(submitCredentials)} /></Field>
                        <Callout tone="info">Create an app at <button className="btn-link" onClick={openPortal}>my.telegram.org/apps</button> to get these. They are stored on this computer only, protected by Windows.</Callout>
                        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                            <button className="btn-ghost" onClick={() => goTo('info')}>Cancel</button>
                            <button className="btn-primary" onClick={submitCredentials} disabled={isLoading}>{isLoading ? 'Saving…' : 'Continue'}</button>
                        </div>
                    </div>
                )}

                {step === 'phone' && (
                    <div className="card form-card">
                        {errorBox}
                        <Field label="Phone number" hint="Include the country code, e.g. +84 for Vietnam.">
                            <input className="input mono" type="tel" value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} placeholder="+84 912 345 678" onKeyDown={onEnter(sendCode)} autoFocus />
                        </Field>
                        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                            <button className="btn-primary" onClick={sendCode} disabled={isLoading}>{isLoading ? 'Sending…' : 'Send code'}</button>
                        </div>
                    </div>
                )}

                {step === 'otp' && (
                    <div className="card form-card">
                        {errorBox}
                        <div style={{ color: 'var(--text-2)', fontSize: 13.5 }}>Telegram sent a login code to your Telegram app (not SMS).</div>
                        <input className="input code" value={otpCode} onChange={e => setOtpCode(e.target.value.replace(/\D/g, ''))} placeholder="•••••" maxLength={6} inputMode="numeric" onKeyDown={onEnter(verifyCode)} autoFocus />
                        <div className="btn-row" style={{ justifyContent: 'space-between' }}>
                            <button className="btn-link" onClick={sendCode} disabled={isLoading}>Resend code</button>
                            <button className="btn-primary" onClick={verifyCode} disabled={isLoading || otpCode.length < 5}>{isLoading ? 'Verifying…' : 'Verify'}</button>
                        </div>
                    </div>
                )}

                {step === 'password' && (
                    <div className="card form-card">
                        {errorBox}
                        <Field label="Two-step verification password" hint="Your account has a cloud password. It is sent to Telegram only as a proof, never stored.">
                            <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={onEnter(checkPassword)} autoFocus />
                        </Field>
                        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                            <button className="btn-primary" onClick={checkPassword} disabled={isLoading || !password}>{isLoading ? 'Checking…' : 'Sign in'}</button>
                        </div>
                    </div>
                )}

                {step === 'config' && (
                    <div className="card form-card">
                        {errorBox}
                        <Callout tone="ok">Signed in as <b>{phoneNumber}</b></Callout>
                        <div className="field">
                            <span className="field-label">Where should the library go?</span>
                            {[
                                { id: 'private_channel', title: 'Private channel (recommended)', desc: 'A channel only you can see, created for you (or reused if you set TeleCloud up before). No total size limit; files up to 2 GB.' },
                                { id: 'saved_messages', title: 'Saved Messages', desc: 'Also unlimited, but your music sits between your own saved notes.' },
                            ].map(o => (
                                <label key={o.id} className={`radio-card ${storageLocation === o.id ? 'on' : ''}`}>
                                    <input type="radio" name="storage" checked={storageLocation === o.id} onChange={() => setStorageLocation(o.id)} />
                                    <span className="radio-dot" />
                                    <div><b>{o.title}</b><span>{o.desc}</span></div>
                                </label>
                            ))}
                        </div>
                        <SettingRow icon="user" title="Encrypt files (recommended)" desc="Files are encrypted on this computer before upload. You'll get a recovery key to open them elsewhere.">
                            <Toggle checked={encrypt} onChange={setEncrypt} />
                        </SettingRow>
                        <Field label="Cache for cloud tracks" hint="Played cloud tracks are kept here so replays don't download again. The oldest are removed when it is full.">
                            <div className="row-gap"><input className="input mono" type="number" min="0.5" max="2000" step="0.5" value={cacheLimit} onChange={e => setCacheLimit(Number(e.target.value))} style={{ width: 110 }} /><span className="muted">GB</span></div>
                        </Field>
                        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                            <button className="btn-primary" onClick={finishSetup} disabled={isLoading}>{isLoading ? 'Setting up…' : 'Finish setup'}</button>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    const opts = status?.options || {};
    const cacheLimitBytes = (opts.cacheLimitGB || 5) * 1024 ** 3;
    return (
        <div className="tc-wrap">
            {error && <Callout tone="danger">{error}</Callout>}
            <section className="set-section">
                <h3 className="h3-row">Account
                    <button className="btn-ghost sm" onClick={showTips} title="What to do and avoid so backups complete"><Icon name="info" />Do's &amp; don'ts</button>
                </h3>
                <div className="card set-card">
                    <SettingRow icon="cloud" title={<>Connected <span className="badge b-lossless" style={{ marginLeft: 6 }}>Online</span></>} desc={`${status?.phoneNumber || 'Telegram account'} · ${status?.storage?.title || 'no storage chat'}`}>
                        <button className="btn-outline danger" onClick={disconnect} disabled={isLoading}>Disconnect</button>
                    </SettingRow>
                    <div className="set-sub" style={{ background: 'transparent' }}>
                        <div className="stat-grid">
                            <div className="stat-box"><small>Tracks in cloud</small><b>{(status?.syncedItems || 0).toLocaleString()}</b></div>
                            <div className="stat-box"><small>Stored</small><b>{formatBytes(status?.storageUsed || 0)}</b></div>
                            <div className="stat-box"><small>Last backup</small><b style={{ fontSize: 14 }}>{status?.lastSync ? new Date(status.lastSync).toLocaleString() : 'Never'}</b></div>
                        </div>
                    </div>
                </div>
            </section>

            <StoragesSection onChanged={refresh} />

            <section className="set-section">
                <h3>Backup</h3>
                <div className="card set-card">
                    <BackupCard queue={queue} onSync={sync} onPause={pause} onResume={resume} rate={opts.rateKBps || 0} onRate={(v) => setOption({ rateKBps: v })} />
                    <IndexRow index={status?.index} onSaved={refresh} />
                    <SpeedTest />
                    <SettingRow icon="download" title="Restore library from cloud" desc="On a new computer, add every cloud track to this library. Audio downloads when you play it.">
                        <button className="btn-ghost" onClick={() => restore(false)} disabled={isLoading}>Restore</button>
                    </SettingRow>
                </div>
            </section>

            <section className="set-section">
                <h3>Encryption</h3>
                <div className="card set-card">
                    <SettingRow icon="user" title="Encrypt new uploads" desc="Turning this off only affects files uploaded from now on.">
                        <Toggle checked={!!opts.encrypt} onChange={(v) => setOption({ encrypt: v })} />
                    </SettingRow>
                    {status && <RecoveryKey status={status} onChanged={(what) => (what === 'restore' ? restore(true) : refresh())} />}
                </div>
            </section>

            <section className="set-section">
                <h3>Cache</h3>
                <div className="card set-card">
                    <SettingRow icon="disc" title="Cache size" desc={`${formatBytes(status?.cacheBytes || 0)} used of ${formatBytes(cacheLimitBytes)}. The least recently played tracks are removed first.`}>
                        <div className="row-gap">
                            <input className="input mono" type="number" min="0.5" max="2000" step="0.5" defaultValue={opts.cacheLimitGB || 5} key={opts.cacheLimitGB}
                                onBlur={e => { const v = Number(e.target.value); if (v > 0 && v !== opts.cacheLimitGB) setOption({ cacheLimitGB: v }); }}
                                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} style={{ width: 90 }} />
                            <span className="muted">GB</span>
                        </div>
                    </SettingRow>
                    <div className="set-sub" style={{ background: 'transparent', paddingTop: 0 }}>
                        <Progress value={Math.min(100, ((status?.cacheBytes || 0) / cacheLimitBytes) * 100)} />
                    </div>
                    <SettingRow icon="trash" title="Clear cache" desc="Cloud tracks download again the next time you play them.">
                        <button className="btn-ghost" onClick={clearCache} disabled={!status?.cacheBytes}>Clear</button>
                    </SettingRow>
                </div>
            </section>

            <section className="set-section">
                <h3>Danger zone</h3>
                <div className="card set-card">
                    <SettingRow icon="trash" title="Delete the TeleCloud backup" desc="Deletes the files TeleCloud uploaded. Your other Telegram messages and local music are not touched.">
                        <button className="btn-outline danger" onClick={deleteAll} disabled={isLoading}>Delete backup…</button>
                    </SettingRow>
                </div>
            </section>
        </div>
    );
};

export default TeleCloudSyncSettings;
