import React, { useState, useEffect, useCallback } from 'react';
import Icon from './Icon';
import { Field, Callout, Progress, Select, SettingRow, BackButton, Toggle, MoreMenu, Dialog, confirmDialog, alertDialog } from './ui';
import { formatBytes } from '../utils/audio';
import BackupCheck from './BackupCheck';
import { AutoBackupRows, ScheduleSection, OfflineRows } from './BackupAutomation';
import { ipcOn, ipcOff } from '../utils/ipc';
import { t } from '../i18n';

const SETUP_STEPS = [
    { id: 'credentials', get label() { return t('API keys'); } },
    { id: 'phone', get label() { return t('Phone'); } },
    { id: 'otp', get label() { return t('Code'); } },
    { id: 'config', get label() { return t('Storage'); } },
];
const RATE_OPTIONS = [0, 512, 1024, 2048, 5120, 10240].map(v => ({ value: v, label: v ? `${v >= 1024 ? `${v / 1024} MB/s` : `${v} KB/s`}` : t('Unlimited') }));
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
    return s < 60 ? `${s}s left` : s < 3600 ? t('{round} min left', { round: Math.round(s / 60) }) : `${(s / 3600).toFixed(1)} h left`;
};

/** What to do (and not do) so a backup always completes and stays restorable */
const TIPS = {
    get do() { return [
        [t('Back up a little at a time: an album, or a playlist you made.'), t('It is gentler on Telegram’s limits, and a lighter channel restores faster. When you stop listening to something, it can leave TeleCloud too.')],
        [t('Leave TeleCloud open until the queue says everything is backed up.'), t('Quitting mid-upload is safe, but the file in progress starts over next time.')],
        [t('Press Pause before quitting in the middle of a backup.'), t('Pausing saves the library index (tags, lyrics, covers) for what is already up.')],
        [t('Keep your recovery key outside this computer.'), t('Without it, encrypted tracks cannot be opened after a reinstall or on another computer.')],
        [t('Keep the computer awake during long backups.'), t('Sleep drops the connection; the current file restarts when it wakes.')],
        [t('Remove, move or back up tracks from inside the app.'), t('Use the track menu, Ctrl/Shift+click to pick several, or the album and playlist menus.')],
    ]; },
    get dont() { return [
        [t('Delete, edit or forward TeleCloud files in Telegram yourself.'), t('The app cannot see those changes and the tracks stop playing.')],
        [t('Delete library.tcm from a storage chat.'), t('It is the index another computer restores from. Save now writes a new one.')],
        [t('Leave or delete a storage channel or group in Telegram.'), t('Remove the storage in Settings instead, so the library stays consistent.')],
        [t('Disconnect or Delete all while a backup is running.'), t('Pause first, then wait for the queue to stop.')],
        [t('Move or rename your music folders during a backup.'), t('Those files are skipped and retried; finish the backup first.')],
        [t('Restart the app when Telegram says “waiting”.'), t('That is Telegram’s rate limit. TeleCloud waits and continues by itself.')],
    ]; },
};
const showTips = () => alertDialog({
    title: t('Using TeleCloud safely'),
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
const BackupCard = ({ queue, onSync, onPause, onResume, onAnyway, rate, onRate }) => {
    const total = queue.queued + queue.done + queue.error + (queue.active ? 1 : 0);
    const a = queue.active;
    const busy = queue.running;
    const waiting = queue.queued > 0 && !busy;
    // not paused: the rest waits for the upload window (Upload schedule)
    const forWindow = waiting && !queue.paused && queue.held > 0;
    return (
        <>
            <SettingRow icon="refresh" title={t('Back up your library')} desc={t('Uploads local tracks that are not in TeleCloud yet. Runs in the background and continues after a restart.')}>
                {busy
                    ? <button className="btn-outline" onClick={onPause}><Icon name="pause" />{t('Pause')}</button>
                    : forWindow
                        ? <button className="btn-ghost" onClick={onAnyway} title={t('Start the waiting backups now, this once')}>{t('Back up now anyway')}</button>
                    : waiting
                        ? <button className="btn-primary" onClick={onResume}><Icon name="play" />{t('Resume')}</button>
                        : <button className="btn-primary" onClick={onSync}>{t('Back up now')}</button>}
            </SettingRow>
            {(busy || waiting || queue.error > 0) && (
                <div className="set-sub">
                    <div className="sync-live">
                        <div className="row">
                            {busy ? <span className="ring" /> : <Icon name={forWindow ? 'clock' : waiting ? 'pause' : 'alert'} />}
                            <b>
                                {busy ? (a?.stage === 'checking' ? t('Checking for duplicates…') : a?.stage === 'waiting' ? t('Telegram asked us to slow down, waiting…') : a?.stage === 'manifest' ? t('Saving tags, lyrics and covers…') : t('Uploading {value} of {total}', { value: queue.done + queue.error + 1, total }))
                                    : forWindow ? t('{n} waiting for the upload window, {from} to {to}', { n: queue.held.toLocaleString(), from: queue.windowFrom, to: queue.windowTo }) : waiting ? t('Paused · {queued} waiting', { queued: queue.queued.toLocaleString() }) : t('{error} failed', { error: queue.error })}
                            </b>
                            <span className="mono" style={{ marginLeft: 'auto', color: 'var(--text-3)', fontSize: 12 }}>
                                {t('{done} done{value}', { done: queue.done.toLocaleString(), value: queue.error ? t(' · {error} failed', { error: queue.error }) : '' })}
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
                                <summary>{t('Why did {value} fail?', { value: queue.error === 1 ? t('one file') : t('some files') })}</summary>
                                {queue.errors.map(e => <div key={e.path} className="row"><span className="file">{e.path.split(/[\\/]/).pop()}</span><span className="err">{e.error}</span></div>)}
                                <button className="btn-ghost sm" onClick={onResume}>{t('Retry failed')}</button>
                            </details>
                        )}
                    </div>
                </div>
            )}
            <SettingRow icon="sort" title={t('Upload speed limit')} desc={t('Leave room for the rest of your connection while a big backup runs.')}>
                <Select value={rate} onChange={onRate} options={RATE_OPTIONS} align="right" />
            </SettingRow>
        </>
    );
};

/** The chats TeleCloud stores music in (up to 5) */
const StoragesSection = ({ onChanged, telegram = true }) => {
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
        if (!r.success) { alertDialog({ title: t('Storage'), message: r.error, tone: 'danger' }); return; }
        await load();
        onChanged?.();
        if (msg) alertDialog({ title: t('Storage'), message: msg, tone: 'ok' });
    };
    const openAdd = async () => {
        // without a Telegram account only folders can be added
        setAdding({ mode: telegram ? 'new' : 'folder', name: '', chats: null, chatId: '', folder: '', busy: false });
        if (!telegram) return;
        const r = await ipc().invoke('telecloud-sync:storage-candidates');
        setAdding(a => a && { ...a, chats: r.success ? r.chats : [], error: r.success ? '' : r.error });
    };
    const pickFolder = async () => {
        const r = await ipc().invoke('telecloud-sync:pick-folder');
        if (r?.folder) setAdding(a => a && { ...a, mode: 'folder', folder: r.folder });
    };
    const ready = adding && (adding.mode === 'new' ? !!adding.name.trim() : adding.mode === 'folder' ? !!adding.folder : !!adding.chatId);
    const add = async () => {
        if (!ready) return;
        setAdding(a => ({ ...a, busy: true, error: '' }));
        const r = await ipc().invoke('telecloud-sync:storage-add', adding.mode === 'new' ? { title: adding.name } : adding.mode === 'folder' ? { folder: adding.folder, title: adding.name } : { chatId: adding.chatId });
        if (!r.success) { setAdding(a => ({ ...a, busy: false, error: r.error })); return; }
        setAdding(null);
        const found = r.existingFiles ? t(' It already holds {existingFiles} TeleCloud tracks: use Restore to add them to this library.', { existingFiles: r.existingFiles }) : '';
        const locked = r.needKey ? t(' {needKey} of its tracks need the recovery key from the computer that uploaded them.', { needKey: r.needKey }) : '';
        await after({ success: true }, t('“{title}” is ready.{found}{locked}', { title: r.storage.title, found, locked }));
    };
    const remove = async (st) => {
        const message = st.kind === 'folder'
            ? t('TeleCloud forgets this folder on this computer. Its {tracks} tracks stay in the folder; cloud-only ones leave this library and the rest become plain local tracks. You can add the folder again later.', { tracks: st.tracks })
            : t('TeleCloud forgets this chat on this computer. Its {tracks} tracks stay in Telegram; cloud-only ones leave this library and the rest become plain local tracks. You can add the chat again later.', { tracks: st.tracks });
        const ok = await confirmDialog({ title: t('Stop using “{title}”?', { title: st.title }), message, confirmLabel: t('Stop using it'), danger: true });
        if (ok) after(await ipc().invoke('telecloud-sync:storage-remove', { id: st.id }));
    };
    const saveName = async () => {
        const r = await ipc().invoke('telecloud-sync:storage-rename', { id: renaming.id, title: renaming.title });
        setRenaming(null);
        after(r);
    };
    const kindLabel = (k) => (k === 'self' ? t('Saved Messages') : k === 'group' ? t('Private group') : k === 'folder' ? t('Folder') : t('Private channel'));
    return (
        <section className="set-section">
            <h3>{t('Storages')}</h3>
            <div className="card set-card">
                {list.map(st => (
                    <SettingRow key={st.id} icon={st.kind === 'self' ? 'heart' : st.kind === 'folder' ? 'folder' : 'cloud'}
                        title={<>{st.title}{st.isDefault && <span className="badge b-local" style={{ marginLeft: 8 }}>{t('Default')}</span>}</>}
                        desc={t('{kindLabel} · {tracks} tracks · {bytes}', { kindLabel: st.location ? `${kindLabel(st.kind)} · ${st.location}` : kindLabel(st.kind), tracks: st.tracks.toLocaleString(), bytes: formatBytes(st.bytes) })}>
                        <MoreMenu items={[
                            ...(!st.isDefault ? [{ label: t('Use as default'), icon: 'check', onClick: async () => after(await ipc().invoke('telecloud-sync:storage-default', { id: st.id })) }] : []),
                            ...(st.kind !== 'self' ? [{ label: t('Rename'), icon: 'lyrics', onClick: () => setRenaming({ id: st.id, title: st.title, kind: st.kind }) }] : []),
                            ...(list.length > 1 ? [{ sep: true }, { label: t('Stop using'), icon: 'trash', danger: true, onClick: () => remove(st) }] : []),
                        ]} />
                    </SettingRow>
                ))}
                <SettingRow icon="plus" title={t('Add a storage')} desc={t('Keep albums or playlists in separate storages, Telegram chats or folders, up to {max}. “Back up now” fills the default one; use “Back up to…” on an album, playlist or track to pick another.', { max })}>
                    <button className="btn-ghost" onClick={openAdd} disabled={list.length >= max}>{list.length >= max ? t('{max} of {max2}', { max, max2: max }) : t('Add')}</button>
                </SettingRow>
            </div>

            {adding && (
                <Dialog open title={t('Add a storage')} icon="cloud" width={500} onClose={() => setAdding(null)}
                    actions={<>
                        <button className="btn-ghost" onClick={() => setAdding(null)}>{t('Cancel')}</button>
                        <button className="btn-primary" onClick={add} disabled={adding.busy || !ready}>{adding.busy ? t('Adding…') : t('Add storage')}</button>
                    </>}>
                    {telegram && <>
                    <label className={`radio-card ${adding.mode === 'new' ? 'on' : ''}`}>
                        <input type="radio" checked={adding.mode === 'new'} onChange={() => setAdding(a => ({ ...a, mode: 'new' }))} />
                        <span className="radio-dot" />
                        <div><b>{t('New private channel')}</b><span>{t('Created in your Telegram account, visible only to you.')}</span></div>
                    </label>
                    {adding.mode === 'new' && <input className="input" style={{ margin: '8px 0 12px' }} autoFocus placeholder={t('e.g. Hi-Res Vault')} value={adding.name} onChange={e => setAdding(a => ({ ...a, name: e.target.value }))} onKeyDown={e => e.key === 'Enter' && add()} />}
                    <label className={`radio-card ${adding.mode === 'existing' ? 'on' : ''}`} style={{ marginTop: 8 }}>
                        <input type="radio" checked={adding.mode === 'existing'} onChange={() => setAdding(a => ({ ...a, mode: 'existing' }))} />
                        <span className="radio-dot" />
                        <div><b>{t('A chat you already have')}</b><span>{t('Saved Messages, or a channel / private group you own. TeleCloud files already in it are found.')}</span></div>
                    </label>
                    {adding.mode === 'existing' && (
                        <div className="storage-pick" style={{ marginTop: 8 }}>
                            {adding.chats === null ? <div className="empty">{t('Loading your chats…')}</div>
                                : adding.chats.length === 0 ? <div className="empty">{t('No other chats you own.')}</div>
                                    : adding.chats.map(c => (
                                        <label key={c.id} className={`radio-card ${adding.chatId === c.id ? 'on' : ''}`}>
                                            <input type="radio" checked={adding.chatId === c.id} onChange={() => setAdding(a => ({ ...a, chatId: c.id }))} />
                                            <span className="radio-dot" />
                                            <div><b>{c.title}</b><span>{kindLabel(c.kind)}</span></div>
                                        </label>
                                    ))}
                        </div>
                    )}
                    </>}
                    <label className={`radio-card ${adding.mode === 'folder' ? 'on' : ''}`} style={{ marginTop: telegram ? 8 : 0 }}>
                        <input type="radio" checked={adding.mode === 'folder'} onChange={() => setAdding(a => ({ ...a, mode: 'folder' }))} />
                        <span className="radio-dot" />
                        <div><b>{t('A folder')}</b><span>{t('A second drive or a share on your NAS. TeleCloud keeps its files in a “TeleCloud” folder inside it; files already there are found.')}</span></div>
                    </label>
                    {adding.mode === 'folder' && (
                        <div style={{ margin: '8px 0 4px', display: 'grid', gap: 8 }}>
                            <div className="row-gap">
                                <button className="btn-ghost" onClick={pickFolder}><Icon name="folder" />{adding.folder ? t('Change…') : t('Choose a folder…')}</button>
                                {adding.folder && <span className="mono muted" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>{adding.folder}</span>}
                            </div>
                            <input className="input" placeholder={t('Name (optional), e.g. NAS')} value={adding.name} onChange={e => setAdding(a => ({ ...a, name: e.target.value }))} onKeyDown={e => e.key === 'Enter' && add()} />
                        </div>
                    )}
                    {adding.error && <Callout tone="danger">{adding.error}</Callout>}
                </Dialog>
            )}
            {renaming && (
                <Dialog open title={t('Rename storage')} icon="cloud" onClose={() => setRenaming(null)}
                    actions={<><button className="btn-ghost" onClick={() => setRenaming(null)}>{t('Cancel')}</button><button className="btn-primary" onClick={saveName} disabled={!renaming.title.trim()}>{t('Rename')}</button></>}>
                    <input className="input" autoFocus value={renaming.title} onChange={e => setRenaming(r => ({ ...r, title: e.target.value }))} onKeyDown={e => e.key === 'Enter' && saveName()} />
                    <span className="field-hint">{renaming.kind === 'folder' ? t('Only the name TeleCloud shows changes; the folder keeps its name.') : t('The Telegram channel is renamed too.')}</span>
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
        if (!r.success) alertDialog({ title: t('Could not save the library index'), message: r.error, tone: 'danger' });
        onSaved?.();
    };
    const desc = !index ? t('Tags, lyrics and album covers for your other computers.')
        : index.savedAt ? t('Saved {value} · {tracks} tracks · {covers} covers{value2}', { value: new Date(index.savedAt).toLocaleString(), tracks: index.tracks.toLocaleString(), covers: index.covers.toLocaleString(), value2: index.pending ? t(' · changes waiting') : '' })
            : index.tracks ? t('Not saved yet: other computers would only get basic track info.') : t('Saved automatically after each backup.');
    return (
        <SettingRow icon="disc" title={t('Library index')} desc={desc}>
            <button className="btn-ghost" onClick={save} disabled={busy || !index?.tracks}>{busy ? t('Saving…') : t('Save now')}</button>
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
            <SettingRow icon="spectrum" title={t('Streaming speed')} desc={t('Downloads a few MB from your TeleCloud to see which formats play without waiting.')}>
                <button className="btn-ghost" onClick={run} disabled={state?.running}>{state?.running ? t('Testing…') : t('Test')}</button>
            </SettingRow>
            {state && !state.running && (
                <div className="set-sub">
                    {state.error ? <Callout tone="danger">{state.error}</Callout> : (
                        <>
                            <div className="speed-result"><b className="mono">{(state.bytesPerSec / 1048576).toFixed(1)} MB/s</b><span>{t('first data after {firstByteMs}', { firstByteMs: state.firstByteMs })} ms</span></div>
                            <div className="speed-formats">
                                {FORMATS.map(f => (
                                    <span key={f.label} className={`badge ${state.bytesPerSec >= f.need ? 'b-lossless' : 'b-lossy'}`}>{state.bytesPerSec >= f.need ? '✓' : '✕'} {f.label}</span>
                                ))}
                            </div>
                            {FORMATS.some(f => state.bytesPerSec < f.need) && <span className="field-hint">{t('Formats marked ✕ still play: they buffer first, and the next track is downloaded ahead.')}</span>}
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
    const copy = async () => { await navigator.clipboard.writeText(key); alertDialog({ title: t('Copied'), message: t('Store it somewhere safe outside this computer (a password manager is ideal).'), tone: 'ok' }); };
    const save = async () => {
        setError('');
        const r = await ipc().invoke('telecloud-sync:set-recovery-key', { key: draft });
        if (!r.success) { setError(r.error); return; }
        setEntering(false); setDraft(''); await load(); onChanged?.();
        const ok = await confirmDialog({ title: t('Recovery key saved'), message: t('Add the tracks from your TeleCloud channel to this library now?'), confirmLabel: t('Restore library') });
        if (ok) onChanged?.('restore');
    };
    return (
        <>
            <SettingRow icon="info" title={t('Recovery key')} desc={t('Needed to open your encrypted files on another computer or after reinstalling. Without it they can\'t be decrypted, by anyone.')}>
                <button className="btn-ghost" onClick={() => setShown(s => !s)} disabled={!key}>{shown ? t('Hide') : t('Show')}</button>
            </SettingRow>
            {shown && key && (
                <div className="set-sub">
                    <div className="recovery-key mono">{key}</div>
                    <div className="btn-row">
                        <button className="btn-primary" onClick={copy}><Icon name="check" />{t('Copy')}</button>
                        <span className="field-hint" style={{ alignSelf: 'center' }}>{t('Key id {fingerprint}', { fingerprint: status.encryption?.fingerprint })}</span>
                    </div>
                </div>
            )}
            <SettingRow icon="folder" title={t('Use the key from another computer')} desc={t('If this library was backed up from somewhere else, enter that recovery key here.')}>
                <button className="btn-ghost" onClick={() => setEntering(e => !e)}>{entering ? t('Cancel') : t('Enter key')}</button>
            </SettingRow>
            {entering && (
                <div className="set-sub">
                    {error && <Callout tone="danger">{error}</Callout>}
                    <input className="input mono" value={draft} onChange={e => setDraft(e.target.value)} placeholder="XXXX-XXXX-XXXX-…" autoFocus />
                    <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn-primary" onClick={save} disabled={draft.replace(/[^a-z0-9]/gi, '').length < 52}>{t('Use this key')}</button>
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
    const [resign, setResign] = useState(false); // signing in again after Telegram ended the sign-in
    const [viaApp, setViaApp] = useState(true); // where Telegram sent the code: the Telegram app, or an SMS

    const refresh = useCallback(async () => {
        const r = await ipc().invoke('telecloud-sync:check-auth');
        if (r?.success && r.isAuthenticated) {
            setStatus(r);
            if (r.queue) setQueue(r.queue);
            // folders only, signing in to Telegram as well: stay in the sign-in steps
            setStep(s => (r.telegram === false && ['credentials', 'phone', 'otp', 'password', 'config'].includes(s) ? s : 'connected'));
        } else if (r?.success && r.sessionEnded) {
            setStatus(r);
            setStep(s => (['otp', 'password'].includes(s) ? s : 'ended'));
        } else {
            setStep(s => (s === 'loading' || s === 'connected' ? 'info' : s));
        }
    }, []);

    useEffect(() => {
        refresh();
        const onQueue = (e, q) => setQueue(q);
        const onStopped = () => refresh();
        const onQueueError = (e, { error: msg }) => alertDialog({ title: t('Backup stopped'), message: msg, tone: 'danger' });
        ipcOn(ipc(), 'telecloud-sync:queue', onQueue);
        ipcOn(ipc(), 'telecloud-sync:stopped', onStopped);
        ipcOn(ipc(), 'telecloud-sync:queue-error', onQueueError);
        ipcOn(ipc(), 'telecloud-sync:session-ended', onStopped);
        return () => {
            ipcOff(ipc(), 'telecloud-sync:session-ended', onStopped);
            ipcOff(ipc(), 'telecloud-sync:queue', onQueue);
            ipcOff(ipc(), 'telecloud-sync:stopped', onStopped);
            ipcOff(ipc(), 'telecloud-sync:queue-error', onQueueError);
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
        if (!phoneNumber) throw new Error(t('Enter your phone number with the country code.'));
        const r = await ipc().invoke('telecloud-sync:send-code', { phoneNumber: phoneNumber.replace(/\s+/g, '') });
        if (!r.success) throw new Error(r.error || t('Failed to send code'));
        setViaApp(r.viaApp !== false);
        setOtpCode('');
        setStep('otp');
    });
    // signing in again keeps everything: no API keys, no storage choice, just the code (and the password)
    const signInAgain = () => run(async () => {
        const r = await ipc().invoke('telecloud-sync:resign-start');
        if (!r.success) throw new Error(r.error);
        setPhoneNumber(r.phoneNumber || '');
        setViaApp(r.viaApp !== false);
        setOtpCode('');
        setResign(true);
        setStep('otp');
    });
    const finishResign = async () => {
        const r = await ipc().invoke('telecloud-sync:resign-finish');
        if (!r.success) throw new Error(r.error);
        setResign(false);
        await refresh();
        alertDialog({ title: t('Signed in again'), message: t('TeleCloud is connected again. Your backups, storages and settings are as they were.'), tone: 'ok' });
    };
    const verifyCode = () => run(async () => {
        const r = await ipc().invoke('telecloud-sync:verify-code', { code: otpCode, phoneNumber: phoneNumber.replace(/\s+/g, '') });
        if (!r.success) throw new Error(/PHONE_CODE_INVALID/.test(r.error || '') ? t('That code is not right. Check Telegram and try again.') : r.error);
        if (r.passwordNeeded) { setStep('password'); return; }
        if (resign) { await finishResign(); return; }
        setStep('config');
    });
    const checkPassword = () => run(async () => {
        const r = await ipc().invoke('telecloud-sync:check-password', { password });
        if (!r.success) throw new Error(/PASSWORD_HASH_INVALID/.test(r.error || '') ? t('Wrong password.') : r.error);
        setPassword('');
        if (resign) { await finishResign(); return; }
        setStep('config');
    });
    const finishSetup = () => run(async () => {
        const r = await ipc().invoke('telecloud-sync:complete-setup', { storageLocation, encrypt, cacheLimitGB: cacheLimit });
        if (!r.success) throw new Error(r.error || t('Setup failed'));
        await refresh();
        if (r.needKey > 0) {
            alertDialog({ title: t('Encrypted files found'), message: t('Your {title} already holds {needKey} encrypted tracks from another computer. Enter that recovery key under Encryption to use them.', { title: r.storage.title, needKey: r.needKey }), tone: 'info' });
        } else if (r.existingFiles > 0) {
            const ok = await confirmDialog({ title: t('Existing TeleCloud library found'), message: t('{existingFiles} tracks are already in {title}. Add them to this library?', { existingFiles: r.existingFiles, title: r.storage.title }), confirmLabel: t('Restore') });
            if (ok) restore(true);
        }
    });

    /** A folder as the first storage (or another one): a drive, a NAS share */
    const chooseFolder = () => run(async () => {
        const picked = await ipc().invoke('telecloud-sync:pick-folder');
        if (!picked?.folder) return;
        const r = await ipc().invoke('telecloud-sync:storage-add', { folder: picked.folder });
        if (!r.success) throw new Error(r.error);
        await refresh();
        if (r.needKey > 0) {
            alertDialog({ title: t('Encrypted files found'), message: t('Your {title} already holds {needKey} encrypted tracks from another computer. Enter that recovery key under Encryption to use them.', { title: r.storage.title, needKey: r.needKey }), tone: 'info' });
        } else if (r.existingFiles > 0) {
            const ok = await confirmDialog({ title: t('Existing TeleCloud library found'), message: t('{existingFiles} tracks are already in {title}. Add them to this library?', { existingFiles: r.existingFiles, title: r.storage.title }), confirmLabel: t('Restore') });
            if (ok) restore(true);
        }
    });

    const disconnect = async () => {
        const foldersOnly = status?.telegram === false;
        const ok = await confirmDialog(foldersOnly
            ? { title: t('Stop using TeleCloud Sync?'), message: t('This forgets your storages and the encryption key on this computer. Your files stay in their folders; keep your recovery key to read them later.'), confirmLabel: t('Stop using it') }
            : { title: t('Disconnect TeleCloud?'), message: t('This signs this app out of Telegram and forgets the encryption key on this computer. Your files stay in Telegram; keep your recovery key to read them later.'), confirmLabel: t('Disconnect') });
        if (!ok) return;
        await run(async () => { await ipc().invoke('telecloud-sync:disconnect'); setStatus(null); setStep('info'); });
    };

    const sync = async () => { const r = await ipc().invoke('telecloud-sync:sync-now'); if (!r.success) alertDialog({ title: t('Backup failed'), message: r.error, tone: 'danger' }); else if (!r.queued) alertDialog({ title: t('All backed up'), message: t('Every local track is already in TeleCloud.'), tone: 'ok' }); };
    const pause = () => ipc().invoke('telecloud-sync:stop-sync');
    const resume = () => ipc().invoke('telecloud-sync:resume');
    const setOption = async (patch) => { const r = await ipc().invoke('telecloud-sync:set-options', patch); if (r.success) setStatus(s => ({ ...s, options: r.options, cacheBytes: r.cacheBytes })); };

    const restore = async (skipConfirm) => {
        if (!skipConfirm) {
            const ok = await confirmDialog({ title: t('Restore library from TeleCloud?'), message: t('Every track in TeleCloud is added to this library as a cloud track. Audio is downloaded when you play it.'), confirmLabel: t('Restore') });
            if (!ok) return;
        }
        await run(async () => {
            const r = await ipc().invoke('telecloud-sync:restore-from-cloud');
            if (!r.success) throw new Error(r.error);
            const extra = r.needKey ? t('\n{needKey} encrypted tracks need the recovery key from the computer that uploaded them.', { needKey: r.needKey }) : '';
            const parts = [t('Added {restoredCount} tracks with their tags, lyrics and covers.', { restoredCount: r.restoredCount })];
            if (r.updatedCount) parts.push(t('Filled in the info of {updatedCount} cloud tracks.', { updatedCount: r.updatedCount }));
            if (r.skippedCount) parts.push(t('{skippedCount} were already here.', { skippedCount: r.skippedCount }));
            alertDialog({ title: t('Library restored'), message: parts.join(' ') + extra, tone: r.needKey ? 'info' : 'ok' });
            refresh();
        });
    };
    const clearCache = async () => { await ipc().invoke('telecloud-sync:clear-cache'); refresh(); };
    const deleteAll = async () => {
        const foldersOnly = status?.telegram === false;
        const ok = await confirmDialog({ title: t('Delete your TeleCloud backup?'), message: foldersOnly ? t('Every file TeleCloud stored in your storage folders is deleted. Your local music files are not touched. This cannot be undone.') : t('Every file TeleCloud uploaded is deleted from Telegram. Other messages in the chat, and your local music files, are not touched. This cannot be undone.'), confirmLabel: t('Delete backup'), danger: true });
        if (!ok) return;
        await run(async () => {
            const r = await ipc().invoke('telecloud-sync:delete-all');
            if (!r.success) throw new Error(r.error);
            alertDialog({ title: t('Backup deleted'), message: foldersOnly ? t('Deleted {deletedCount} files from your storage folders.', { deletedCount: r.deletedCount }) : t('Deleted {deletedCount} files from Telegram.', { deletedCount: r.deletedCount }), tone: 'ok' });
            refresh();
        });
    };

    const openPortal = () => ipc().invoke('open-external', 'https://my.telegram.org/apps');
    const onEnter = (fn) => (e) => { if (e.key === 'Enter') fn(); };
    const errorBox = error && <Callout tone="danger">{error}</Callout>;

    if (step === 'loading') return <div className="empty">{t('Loading…')}</div>;

    // Telegram ended the sign-in: say why, what is kept, and sign in again with just a code
    if (step === 'ended') {
        const info = status?.sessionEnded || {};
        return (
            <div className="tc-wrap">
                <div className="card tc-hero tc-ended">
                    <div className="set-icon" style={{ background: 'color-mix(in srgb, var(--warn, #f5b942) 18%, transparent)', color: 'var(--warn, #f5b942)', width: 46, height: 46 }}><Icon name="cloud" /></div>
                    <div>
                        <h2>{t('Telegram signed TeleCloud out')}</h2>
                        <p style={{ marginTop: 6 }}>{info.text}</p>
                        <p style={{ marginTop: 6 }}>{t('Nothing is lost: your backups in {value}{value2}, your storages and settings are kept. Sign in again with a code from Telegram to carry on.', { value: status?.storage?.title || 'Telegram', value2: status?.syncedItems ? t(' ({syncedItems} tracks)', { syncedItems: status.syncedItems.toLocaleString() }) : '' })}</p>
                        {info.at && <p className="muted" style={{ marginTop: 6, fontSize: 12.5 }}>{t('Noticed {value}', { value: new Date(info.at).toLocaleString() })} · {status?.phoneNumber}</p>}
                    </div>
                    {errorBox}
                    <div className="btn-row">
                        <button className="btn-primary" onClick={signInAgain} disabled={isLoading}>{isLoading ? t('Sending a code…') : t('Sign in again')}</button>
                        <button className="btn-ghost" onClick={disconnect} disabled={isLoading}>{t('Disconnect instead')}</button>
                    </div>
                </div>
            </div>
        );
    }

    if (step === 'info') {
        return (
            <div className="tc-wrap">
                <div className="card tc-hero">
                    <div className="set-icon" style={{ background: 'var(--accent-soft)', color: 'var(--accent)', width: 46, height: 46 }}><Icon name="cloud" /></div>
                    <div>
                        <h2>{t('Use your Telegram as cloud storage')}</h2>
                        <p style={{ marginTop: 6 }}>{t('Back up your library to a private Telegram channel and play it on any computer. Files stay in your own account, encrypted with a key only you have.')}</p>
                    </div>
                    <div className="feature-grid">
                        <div className="feature"><div className="set-icon"><Icon name="check" /></div><div><b>{t('No subscription')}</b><span>{t('No total size limit')}</span></div></div>
                        <div className="feature"><div className="set-icon"><Icon name="user" /></div><div><b>{t('Encrypted')}</b><span>{t('Telegram can\'t read your files')}</span></div></div>
                        <div className="feature"><div className="set-icon"><Icon name="monitor" /></div><div><b>{t('Any computer')}</b><span>{t('Restore the library anywhere')}</span></div></div>
                        <div className="feature"><div className="set-icon"><Icon name="disc" /></div><div><b>{t('Lossless')}</b><span>{t('Bit-for-bit, checked on download')}</span></div></div>
                    </div>
                    <Callout tone="info">{t('You\'ll need a Telegram {b} from my.telegram.org, and your phone number.', { b: <b>{t('API ID and hash')}</b> })}</Callout>
                    <div className="btn-row">
                        <button className="btn-primary" onClick={() => goTo('credentials')}>{t('Start setup')}<Icon name="chevron" style={{ transform: 'rotate(-90deg)' }} /></button>
                        <button className="btn-ghost" onClick={openPortal}>{t('Get API credentials')}</button>
                    </div>
                    {/* Telegram's API terms: an app says plainly that it uses the Telegram API */}
                    <p className="muted" style={{ marginTop: 14, fontSize: 12.5 }}>{t('TeleCloud is an unofficial app that uses the Telegram API. It is not affiliated with Telegram.')}</p>
                </div>
                <div className="card set-card" style={{ marginTop: 14 }}>
                    <SettingRow icon="folder" title={t('Or back up to a folder')} desc={t('A second drive or a share on your NAS, with no Telegram account. Encrypted the same way, and you can add Telegram later.')}>
                        <button className="btn-ghost" onClick={chooseFolder} disabled={isLoading}>{t('Choose a folder…')}</button>
                    </SettingRow>
                    {errorBox}
                </div>
            </div>
        );
    }

    if (['credentials', 'phone', 'otp', 'password', 'config'].includes(step)) {
        const back = resign ? { otp: 'ended', password: 'otp' }[step] : { credentials: 'info', phone: 'credentials', otp: 'phone', password: 'otp' }[step];
        return (
            <div className="tc-wrap">
                <div className="page-head" style={{ margin: 0 }}>
                    {back && <BackButton onClick={() => { if (back === 'ended') setResign(false); goTo(back); }} />}
                    <h2 style={{ fontSize: 20 }}>{resign ? t('Sign in again') : t('Set up TeleCloud')}</h2>
                </div>
                {!resign && <Stepper step={step} />}

                {step === 'credentials' && (
                    <div className="card form-card">
                        {errorBox}
                        <Field label="API ID"><input className="input mono" value={apiId} onChange={e => setApiId(e.target.value)} placeholder="12345678" onKeyDown={onEnter(submitCredentials)} autoFocus /></Field>
                        <Field label={t('API hash')}><input className="input mono" value={apiHash} onChange={e => setApiHash(e.target.value)} placeholder={t('0123456789abcdef…')} onKeyDown={onEnter(submitCredentials)} /></Field>
                        <Callout tone="info">{t('Create an app at {button} to get these. They are stored on this computer only, protected by Windows.', { button: <button className="btn-link" onClick={openPortal}>{t('my.telegram.org/apps')}</button> })}</Callout>
                        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                            <button className="btn-ghost" onClick={() => goTo('info')}>{t('Cancel')}</button>
                            <button className="btn-primary" onClick={submitCredentials} disabled={isLoading}>{isLoading ? t('Saving…') : t('Continue')}</button>
                        </div>
                    </div>
                )}

                {step === 'phone' && (
                    <div className="card form-card">
                        {errorBox}
                        <Field label={t('Phone number')} hint={t('Include the country code, e.g. +84 for Vietnam.')}>
                            <input className="input mono" type="tel" value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} placeholder="+84 912 345 678" onKeyDown={onEnter(sendCode)} autoFocus />
                        </Field>
                        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                            <button className="btn-primary" onClick={sendCode} disabled={isLoading}>{isLoading ? t('Sending…') : t('Send code')}</button>
                        </div>
                    </div>
                )}

                {step === 'otp' && (
                    <div className="card form-card">
                        {errorBox}
                        <div style={{ color: 'var(--text-2)', fontSize: 13.5 }}>
                            {viaApp
                                ? t('Telegram sent a login code to your Telegram app, in the chat named “Telegram” (not by SMS){value}.', { value: resign && phoneNumber ? t(' for {phoneNumber}', { phoneNumber }) : '' })
                                : t('Telegram sent a login code by SMS{value}.', { value: phoneNumber ? t(' to {phoneNumber}', { phoneNumber }) : '' })}
                            {' '}{t('It can take a minute. If it does not come, Resend asks again: by SMS or a call when Telegram offers one, else in the app.')}
                        </div>
                        <input className="input code" value={otpCode} onChange={e => setOtpCode(e.target.value.replace(/\D/g, ''))} placeholder="•••••" maxLength={6} inputMode="numeric" onKeyDown={onEnter(verifyCode)} autoFocus />
                        <div className="btn-row" style={{ justifyContent: 'space-between' }}>
                            <button className="btn-link" onClick={() => run(async () => { const r = await ipc().invoke('telecloud-sync:resend-code'); if (!r.success) throw new Error(r.error); setViaApp(r.viaApp !== false); setOtpCode(''); })} disabled={isLoading}>{t('Resend code')}</button>
                            <button className="btn-primary" onClick={verifyCode} disabled={isLoading || otpCode.length < 5}>{isLoading ? t('Verifying…') : t('Verify')}</button>
                        </div>
                    </div>
                )}

                {step === 'password' && (
                    <div className="card form-card">
                        {errorBox}
                        <Field label={t('Two-step verification password')} hint={t('Your account has a cloud password. It is sent to Telegram only as a proof, never stored.')}>
                            <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={onEnter(checkPassword)} autoFocus />
                        </Field>
                        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                            <button className="btn-primary" onClick={checkPassword} disabled={isLoading || !password}>{isLoading ? t('Checking…') : t('Sign in')}</button>
                        </div>
                    </div>
                )}

                {step === 'config' && (
                    <div className="card form-card">
                        {errorBox}
                        <Callout tone="ok">{t('Signed in as')} <b>{phoneNumber}</b></Callout>
                        <div className="field">
                            <span className="field-label">{t('Where should the library go?')}</span>
                            {[
                                { id: 'private_channel', title: t('Private channel (recommended)'), desc: t('A channel only you can see, created for you (or reused if you set TeleCloud up before). No total size limit; files up to 2 GB.') },
                                { id: 'saved_messages', title: t('Saved Messages'), desc: t('Also unlimited, but your music sits between your own saved notes.') },
                            ].map(o => (
                                <label key={o.id} className={`radio-card ${storageLocation === o.id ? 'on' : ''}`}>
                                    <input type="radio" name="storage" checked={storageLocation === o.id} onChange={() => setStorageLocation(o.id)} />
                                    <span className="radio-dot" />
                                    <div><b>{o.title}</b><span>{o.desc}</span></div>
                                </label>
                            ))}
                        </div>
                        <SettingRow icon="user" title={t('Encrypt files (recommended)')} desc={t('Files are encrypted on this computer before upload. You\'ll get a recovery key to open them elsewhere.')}>
                            <Toggle checked={encrypt} onChange={setEncrypt} />
                        </SettingRow>
                        <Field label={t('Cache for cloud tracks')} hint={t('Played cloud tracks are kept here so replays don\'t download again. The oldest are removed when it is full.')}>
                            <div className="row-gap"><input className="input mono" type="number" min="0.5" max="2000" step="0.5" value={cacheLimit} onChange={e => setCacheLimit(Number(e.target.value))} style={{ width: 110 }} /><span className="muted">GB</span></div>
                        </Field>
                        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                            <button className="btn-primary" onClick={finishSetup} disabled={isLoading}>{isLoading ? t('Setting up…') : t('Finish setup')}</button>
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
                <h3 className="h3-row">{t('Account')}
                    <button className="btn-ghost sm" onClick={showTips} title={t('What to do and avoid so backups complete')}><Icon name="info" />{t('Do\'s & don\'ts')}</button>
                </h3>
                <div className="card set-card">
                    {status?.telegram === false ? (
                        <SettingRow icon="folder" title={t('Backing up to folders')} desc={t('{title} · No Telegram account: your storages are folders on this computer or your network.', { title: status?.storage?.title || '' })}>
                            <div className="btn-row">
                                <button className="btn-ghost" onClick={() => goTo('credentials')} disabled={isLoading}>{t('Add Telegram')}</button>
                                <button className="btn-outline danger" onClick={disconnect} disabled={isLoading}>{t('Stop using it')}</button>
                            </div>
                        </SettingRow>
                    ) : (
                        <SettingRow icon="cloud" title={<>{t('Connected')} <span className="badge b-lossless" style={{ marginLeft: 6 }}>{t('Online')}</span></>} desc={`${status?.phoneNumber || t('Telegram account')} · ${status?.storage?.title || t('no storage chat')}${status?.sessionTtlText ? t(' · Telegram signs this computer out after {sessionTtlText} unused (Settings > Devices); opening TeleCloud keeps it signed in', { sessionTtlText: status.sessionTtlText }) : ''}`}>
                            <button className="btn-outline danger" onClick={disconnect} disabled={isLoading}>{t('Disconnect')}</button>
                        </SettingRow>
                    )}
                    <div className="set-sub" style={{ background: 'transparent' }}>
                        <div className="stat-grid">
                            <div className="stat-box"><small>{t('Tracks in cloud')}</small><b>{(status?.syncedItems || 0).toLocaleString()}</b></div>
                            <div className="stat-box"><small>{t('Stored')}</small><b>{formatBytes(status?.storageUsed || 0)}</b></div>
                            <div className="stat-box"><small>{t('Last backup')}</small><b style={{ fontSize: 14 }}>{status?.lastSync ? new Date(status.lastSync).toLocaleString() : t('Never')}</b></div>
                        </div>
                    </div>
                </div>
            </section>

            <StoragesSection onChanged={refresh} telegram={status?.telegram !== false} />

            <section className="set-section">
                <h3>{t('Backup')}</h3>
                <div className="card set-card">
                    <BackupCard queue={queue} onSync={sync} onPause={pause} onResume={resume} onAnyway={() => ipc().invoke('telecloud-sync:backup-now-anyway')} rate={opts.rateKBps || 0} onRate={(v) => setOption({ rateKBps: v })} />
                    <AutoBackupRows opts={opts} setOption={setOption} />
                    <IndexRow index={status?.index} onSaved={refresh} />
                    <SpeedTest />
                    <BackupCheck disabled={isLoading} />
                    <SettingRow icon="download" title={t('Restore library from cloud')} desc={t('On a new computer, add every cloud track to this library. Audio downloads when you play it.')}>
                        <button className="btn-ghost" onClick={() => restore(false)} disabled={isLoading}>{t('Restore')}</button>
                    </SettingRow>
                </div>
            </section>

            <ScheduleSection opts={opts} setOption={setOption} />

            <section className="set-section">
                <h3>{t('Encryption')}</h3>
                <div className="card set-card">
                    <SettingRow icon="user" title={t('Encrypt new uploads')} desc={t('Turning this off only affects files uploaded from now on.')}>
                        <Toggle checked={!!opts.encrypt} onChange={(v) => setOption({ encrypt: v })} />
                    </SettingRow>
                    {status && <RecoveryKey status={status} onChanged={(what) => (what === 'restore' ? restore(true) : refresh())} />}
                </div>
            </section>

            <section className="set-section">
                <h3>{t('Cache')}</h3>
                <div className="card set-card">
                    <SettingRow icon="disc" title={t('Cache size')} desc={t('{bytes} used of {bytes2}. The least recently played tracks are removed first; kept offline ones never are.', { bytes: formatBytes(status?.cacheBytes || 0), bytes2: formatBytes(cacheLimitBytes) })}>
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
                    <SettingRow icon="trash" title={t('Clear cache')} desc={t('Cloud tracks download again the next time you play them. Albums and playlists kept offline stay.')}>
                        <button className="btn-ghost" onClick={clearCache} disabled={!status?.cacheBytes}>{t('Clear')}</button>
                    </SettingRow>
                    <OfflineRows />
                </div>
            </section>

            <section className="set-section">
                <h3>{t('Danger zone')}</h3>
                <div className="card set-card">
                    <SettingRow icon="trash" title={t('Delete the TeleCloud backup')} desc={status?.telegram === false ? t('Deletes the files TeleCloud stored in your storage folders. Your local music is not touched.') : t('Deletes the files TeleCloud uploaded. Your other Telegram messages and local music are not touched.')}>
                        <button className="btn-outline danger" onClick={deleteAll} disabled={isLoading}>{t('Delete backup…')}</button>
                    </SettingRow>
                </div>
            </section>
        </div>
    );
};

export default TeleCloudSyncSettings;
