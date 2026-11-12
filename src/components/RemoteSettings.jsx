import React, { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import Icon from './Icon';
import { SettingRow, Toggle, Select, Callout, confirmDialog } from './ui';

const ago = (t) => {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};

/** Settings → Remote: let a phone, a tablet or another PC on this network control TeleCloud */
const RemoteSettings = () => {
  const ipc = window.ipcRenderer;
  const [s, setS] = useState(null);
  const [name, setName] = useState('');
  const [copied, setCopied] = useState(false);
  const [network, setNetwork] = useState(null);
  useEffect(() => {
    ipc.invoke('remote:status').then((v) => { setS(v); setName(v?.name || ''); });
    const on = (e, v) => setS(v);
    ipc.on('remote:status', on);
    return () => ipc.removeListener?.('remote:status', on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!s?.running) return;
    ipc.invoke('remote:network').then(setNetwork).catch(() => setNetwork([]));
  }, [s?.running]); // eslint-disable-line react-hooks/exhaustive-deps

  // black on white with a quiet border: the colours every camera reads
  const qr = useMemo(() => {
    if (!s?.url) return '';
    const q = qrcode(0, 'M');
    q.addData(s.url);
    q.make();
    return q.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
  }, [s?.url]);

  if (!s) return null;
  const set = async (patch) => setS(await ipc.invoke('remote:set', patch));
  const publicNet = (network || []).filter(n => n.category === 'Public');
  const copy = async () => {
    try { await navigator.clipboard.writeText(s.url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* the address is on screen anyway */ }
  };
  const renew = async () => {
    if (!await confirmDialog({ title: 'Make a new key?', message: 'Every paired device is signed out and has to scan the new QR code.', confirmLabel: 'New key', danger: true })) return;
    setS(await ipc.invoke('remote:renew'));
  };
  const saveName = () => { if (name.trim() !== (s.name || '')) set({ name }); };

  return (
    <section className="set-section">
      <h3>Remote</h3>
      <div className="card set-card">
        <SettingRow icon="monitor" title="Let other devices control TeleCloud" desc="A phone, a tablet or another computer on this network opens a page from TeleCloud and controls the music: play, skip, queue, volume, output and EQ. The sound still comes from this computer. Off until you turn it on.">
          <Toggle checked={s.enabled} onChange={(v) => set({ enabled: v })} />
        </SettingRow>

        {s.enabled && (
          <div className="set-sub remote">
            {!s.running && <Callout tone="warn">The remote could not start. See Settings &gt; About &gt; Logs for why.</Callout>}
            {s.running && s.url && (
              <div className="remote-pair">
                <div className="remote-qr" dangerouslySetInnerHTML={{ __html: qr }} aria-label="QR code with the address" />
                <div className="remote-how">
                  <b>Scan this on the other device</b>
                  <small>Or open this address in its browser. The key at the end pairs it; after that it stays paired.</small>
                  <div className="remote-url">
                    <code className="mono">{s.url}</code>
                    <button className="btn-ghost sm" onClick={copy}><Icon name={copied ? 'check' : 'download'} />{copied ? 'Copied' : 'Copy'}</button>
                  </div>
                  <small className="muted">The port changes each time TeleCloud starts or the remote is turned on, so scan again then. Paired devices don't need the key again.</small>
                  <div className="remote-actions">
                    {s.addresses.length > 1 && (
                      <Select value={s.address} onChange={(v) => set({ address: v })} options={s.addresses.map(a => ({ value: a.address, label: `${a.address} · ${a.name}${a.virtual ? ' (virtual)' : ''}` }))} />
                    )}
                    <button className="btn-ghost sm" onClick={renew} title="Sign every device out">New key</button>
                  </div>
                </div>
              </div>
            )}
            {s.running && !s.url && <Callout tone="warn">This computer has no network address. Connect it to Wi-Fi or Ethernet.</Callout>}
            {publicNet.length > 0 && (
              <Callout tone="warn">{publicNet.map(n => n.name).join(', ')} is set to a Public network, so Windows keeps other devices out. In Windows Settings &gt; Network, set it to Private.</Callout>
            )}
          </div>
        )}

        <SettingRow icon="monitor" title="Name shown on remotes" desc={`Empty: the name of this computer, ${s.host.realName}. With another name, remotes show ${s.host.realName} in small text under it.`}>
          <input className="input sm remote-name" value={name} placeholder={s.host.realName} maxLength={60} onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} aria-label="Name shown on remotes" />
        </SettingRow>

        <SettingRow icon="moon" title="Keep this computer awake while music plays" desc="Windows won't go to sleep in the middle of an album, so remotes can still reach it. The screen can still turn off. Works with or without the remote.">
          <Toggle checked={!!s.keepAwake} onChange={(v) => set({ keepAwake: v })} />
        </SettingRow>

        <details className="set-sub remote-wol">
          <summary><Icon name="chevron" />Wake this computer from a phone (Wake-on-LAN)</summary>
          <p className="muted">A computer that sleeps can't show the remote. With Wake-on-LAN, a phone app wakes it first:</p>
          <ol>
            <li>In the BIOS or UEFI settings, turn on <b>Wake on LAN</b> (it may be called Power on by PCI-E).</li>
            <li>In Windows, open <b>Device Manager &gt; Network adapters</b>, then your adapter. On <b>Power Management</b>, tick <b>Allow this device to wake the computer</b> and <b>Only allow a magic packet</b>. On <b>Advanced</b>, set <b>Wake on Magic Packet</b> to Enabled.</li>
            <li>To wake it from shut down too, turn off <b>Fast startup</b> in Control Panel &gt; Power Options &gt; Choose what the power buttons do.</li>
            <li>On the phone, install a Wake-on-LAN app and add this computer:</li>
          </ol>
          {s.wake ? (
            <div className="remote-wol-info">
              <span>MAC address</span><code className="mono">{s.wake.mac}</code>
              <span>Broadcast address</span><code className="mono">{s.wake.broadcast}</code>
              <span>Adapter</span><code className="mono">{s.wake.adapter}</code>
            </div>
          ) : <p className="muted">Connect this computer to a network to see its MAC address here.</p>}
          {s.wake?.wireless && <Callout tone="warn">This is a Wi-Fi adapter. Most Wi-Fi adapters can't wake a computer; a network cable works far more often.</Callout>}
        </details>

        {s.devices.length > 0 && (
          <div className="set-sub remote-devices">
            <b className="remote-devices-title">Paired devices</b>
            {s.devices.map(d => (
              <div key={d.id} className="remote-device">
                <span className={`dot ${d.online ? 'on' : ''}`} />
                <span className="remote-device-name">{d.label}</span>
                <small className="muted">{d.online ? 'Connected now' : `Seen ${ago(d.lastSeen)}`}</small>
                <Select value={d.readOnly ? 'view' : 'control'} onChange={async (v) => setS(await ipc.invoke('remote:device-access', d.id, v === 'view'))}
                  options={[{ value: 'control', label: 'Can control' }, { value: 'view', label: 'View only' }]} />
                <button className="btn-ghost sm" onClick={async () => setS(await ipc.invoke('remote:remove-device', d.id))}>Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>
      <Callout tone="info">On a phone, open the page in the browser itself: a QR code scanned with the camera often opens a preview, and that preview is lost when a Galaxy Fold is unfolded. Tap Open in Chrome there, then bookmark the page or use Add to Home screen. Opening the link again on a paired phone keeps it one device.</Callout>
      <Callout tone="info">If a device can't open the page: Windows may have asked whether TeleCloud may use the network the first time; it needs to be allowed for private networks. Guest Wi-Fi networks often keep devices apart. Only devices on the same network can reach it.</Callout>
    </section>
  );
};

export default RemoteSettings;
