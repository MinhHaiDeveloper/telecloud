import React, { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../components/Icon';
import { HEADERS, send as post, clock, forget, forgetAll } from './api';
import { Cover, Badges, Pill, Sheet, Where, ArtRev } from './parts';
import Library, { LibRev } from './Library';
import Lyrics from './Lyrics';
import OverflowTooltip from '../components/OverflowTooltip';

const TABS = {
  now: { label: 'Playing', icon: 'play' },
  library: { label: 'Library', icon: 'library' },
  queue: { label: 'Up next', icon: 'queue' },
  side: { label: 'Output', icon: 'speaker' },
};
// what the switcher holds on each screen size; the rest stays on screen
const LAYOUT_TABS = {
  phone: ['now', 'library', 'queue', 'side'],
  cover: ['now', 'library', 'queue', 'side'],
  tablet: ['queue', 'library', 'side'],
  desktop: ['queue', 'library'],
  fold: ['queue', 'library', 'side'],
  flex: ['controls', 'queue', 'library', 'side'],
};
TABS.controls = { label: 'Controls', icon: 'play' };

/**
 * Which layout fits this screen. Besides phone, tablet and desktop, a Galaxy Z Fold gets its own:
 * - fold: the inner screen open like a book (Fold 5 to 8 Ultra: near-square, or 4:3 on the Fold 8).
 *   Two pages that meet at the crease, now playing on the left.
 * - flex: half folded like a laptop (Flex Mode). The screen reports two segments, one above the
 *   other: the cover and the lyrics on top, the controls on the bottom half.
 * - cover: the tall, narrow cover screen (21:9, Fold 5 to 7 and 8 Ultra): the switcher at the bottom,
 *   where a thumb reaches it. The Fold 8's wide cover gets the phone layout, made shorter.
 * A phone held sideways is never a fold (wider than 1.6:1); an Android "Mobile" browser 600 px wide
 * or more can only be a foldable's inner screen.
 */
const layoutOf = () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const ar = w / h;
  const segs = window.viewport?.segments;
  if (segs && segs.length === 2) {
    const [a, b] = segs;
    if (b.top >= a.bottom - 1) return { kind: 'flex', top: a.height, gap: Math.max(0, b.top - a.bottom) };
    if (b.left >= a.right - 1) return { kind: 'fold', crease: Math.max(16, b.left - a.right) };
  }
  const ua = navigator.userAgent;
  const touch = window.matchMedia?.('(pointer: coarse)').matches || /Android|iPhone|iPad/.test(ua);
  // the shape of the screen itself: the page loses the address bar and the status bar, the screen doesn't
  const sw = window.screen?.width || w;
  const sh = window.screen?.height || h;
  const shape = Math.min(sw, sh) / Math.max(sw, sh);
  const long = Math.max(sw, sh);
  // a Fold's inner screen: Android, near square (Fold 5 to 7, 8 Ultra) or 4:3 (Fold 8), and small for a
  // tablet. Chrome there says "tablet", not "Mobile". Android tablets are 16:10 or 3:2: never this square.
  const innerFold = /Android/.test(ua) && touch && shape >= 0.72 && long <= 1300 && w >= 560;
  const mobileWide = /Android/.test(ua) && /Mobile/.test(ua) && w >= 600; // a phone this wide is unfolded
  if (w < 1300 && ar > 0.6 && ar < 1.6 && (innerFold || mobileWide)) return { kind: 'fold', crease: 0 };
  if (w >= 1180) return { kind: 'desktop' };
  if (w >= 760) return { kind: 'tablet' };
  // a tall, narrow screen (21:9 and taller: the Fold's cover)
  if (touch && shape < 0.44) return { kind: 'cover' };
  return { kind: 'phone' };
};
const useLayout = () => {
  const [l, setL] = useState(layoutOf);
  useEffect(() => {
    const on = () => setL(prev => { const n = layoutOf(); return JSON.stringify(n) === JSON.stringify(prev) ? prev : n; });
    window.addEventListener('resize', on);
    window.addEventListener('orientationchange', on);
    // folding or unfolding part way changes the segments without always resizing
    const seg = window.matchMedia?.('(vertical-viewport-segments: 2), (horizontal-viewport-segments: 2)');
    seg?.addEventListener?.('change', on);
    return () => { window.removeEventListener('resize', on); window.removeEventListener('orientationchange', on); seg?.removeEventListener?.('change', on); };
  }, []);
  return l;
};
const firstTab = (kind) => (kind === 'phone' || kind === 'cover' ? 'now' : kind === 'flex' ? 'controls' : 'queue');

export default function RemoteApp() {
  const [phase, setPhase] = useState('starting'); // starting | unpaired | ready
  const [problem, setProblem] = useState('');
  const [s, setS] = useState(null);
  const [me, setMe] = useState({ readOnly: false });
  const [online, setOnline] = useState(false);
  const geo = useLayout();
  const layout = geo.kind;
  const [tab, setTab] = useState(() => firstTab(layoutOf().kind));
  // folding or unfolding: start on what that layout is for (the controls when half folded)
  const lastLayout = useRef(layout);
  useEffect(() => { if (lastLayout.current !== layout) { lastLayout.current = layout; setTab(firstTab(layout)); } }, [layout]);
  const [now, setNow] = useState(() => performance.now());
  const recvAt = useRef(0);
  const [seekDraft, setSeekDraft] = useState(null);
  const [volDraft, setVolDraft] = useState(null);
  const [toast, setToast] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [showLyrics, setShowLyrics] = useState(() => { try { return localStorage.getItem('rm-lyrics') === '1'; } catch { return false; } });
  const toggleLyrics = () => setShowLyrics(v => { try { localStorage.setItem('rm-lyrics', v ? '0' : '1'); } catch { /* fine */ } return !v; });
  const esRef = useRef(null);
  const ro = !!me.readOnly;

  const say = useCallback((text, tone) => {
    const id = Date.now();
    const ms = tone === 'error' ? 4500 : 1800;
    setToast({ id, text, tone });
    setTimeout(() => setToast(t => (t?.id === id ? { ...t, leaving: true } : t)), ms);
    setTimeout(() => setToast(t => (t?.id === id ? null : t)), ms + 300);
  }, []);
  const send = useCallback(async (cmd, args, done) => {
    if (ro) { say('This device can only watch. Change it in TeleCloud > Settings > Remote.'); return false; }
    const code = await post(cmd, args);
    if (code === 200) { if (done) say(done); return true; }
    say(code === 403 ? 'This device can only watch.' : code === 429 ? 'A little slower, please.' : code === 0 ? "Can't reach TeleCloud." : 'TeleCloud could not do that.');
    return false;
  }, [ro, say]);

  // ---- pair (when the link carries the key), then listen
  const connect = useCallback(() => {
    esRef.current?.close();
    const es = new EventSource('/api/events');
    esRef.current = es;
    es.addEventListener('state', (e) => {
      try { setS(JSON.parse(e.data)); recvAt.current = performance.now(); setOnline(true); } catch { /* skip */ }
    });
    es.addEventListener('me', (e) => { try { setMe(JSON.parse(e.data)); } catch { /* skip */ } });
    es.onopen = () => setOnline(true);
    es.onerror = async () => {
      setOnline(false);
      // signed out (a new key, or removed): stop retrying and say so
      const r = await fetch('/api/hello').catch(() => null);
      if (r && r.status === 401) { es.close(); setPhase('unpaired'); }
    };
  }, []);
  useEffect(() => {
    (async () => {
      const m = /[#&]k=([\w-]+)/.exec(window.location.hash);
      if (m) {
        const r = await fetch('/api/pair', { method: 'POST', headers: HEADERS, body: JSON.stringify({ key: m[1] }) }).catch(() => null);
        window.history.replaceState(null, '', window.location.pathname); // the key doesn't stay in the address bar
        if (r && !r.ok) setProblem((await r.json().catch(() => ({}))).error || 'Could not pair.');
      }
      const hello = await fetch('/api/hello').catch(() => null);
      if (!hello) { setPhase('ready'); setOnline(false); connect(); return; }
      if (hello.status === 401) { setPhase('unpaired'); return; }
      setMe(await hello.json().catch(() => ({ readOnly: false })));
      setPhase('ready');
      connect();
    })();
    return () => esRef.current?.close();
  }, [connect]);

  useEffect(() => { if (s?.theme) document.documentElement.dataset.theme = s.theme; }, [s?.theme]);
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const host = s?.host?.name;
    document.title = host ? `${s?.track?.title ? `${s.track.title} · ` : ''}${host} · TeleCloud Remote` : 'TeleCloud Remote';
  }, [s?.host?.name, s?.track?.title]);
  // a problem on the computer (a cloud track that can't stream now): say it here too, once
  const noticeAt = useRef(undefined);
  useEffect(() => {
    if (!s) return;
    const n = s.notice;
    // the first state may carry an old one, from before this page opened
    if (noticeAt.current === undefined) { noticeAt.current = n?.at || 0; return; }
    if (n && n.at !== noticeAt.current) { noticeAt.current = n.at; say(n.text, 'error'); }
  }, [s, say]);
  // the library changed on the computer (tags edited, tracks added, a playlist changed): lists kept here are old
  const libSeen = useRef(null);
  if (s?.lib && libSeen.current !== s.lib) { if (libSeen.current !== null) forgetAll(); libSeen.current = s.lib; }
  // recently played moves with every track
  useEffect(() => { forget(['recent']); }, [s?.track?.id]);

  // the tab must exist on this screen size
  const tabs = LAYOUT_TABS[layout];
  const shown = tabs.includes(tab) ? tab : tabs[0];

  if (phase === 'starting') return <div className="rm rm-center"><span className="rm-ring" /></div>;
  if (phase === 'unpaired') {
    return (
      <div className="rm rm-center">
        <div className="rm-pair card">
          <div className="rm-logo"><Icon name="logo" /></div>
          <h1>TeleCloud Remote</h1>
          <p>Scan the QR code in <b>Settings &gt; Remote</b> on the computer that plays the music, or open the address shown there.</p>
          {problem && <p className="rm-problem">{problem}</p>}
        </div>
      </div>
    );
  }

  const t = s?.track;
  const dur = t?.duration || 0;
  const livePos = s ? Math.min(dur || Infinity, (s.position || 0) + (s.playing ? (now - recvAt.current) / 1000 : 0)) : 0;
  const pos = seekDraft ?? livePos;
  const vol = volDraft ?? s?.volume ?? 0;
  const queue = s?.queue || [];
  const host = s?.host;

  const commitSeek = () => { if (seekDraft != null) send('seek', { time: seekDraft }); setSeekDraft(null); };
  const commitVol = () => { if (volDraft != null) send('volume', { volume: volDraft }); setVolDraft(null); };
  const nextRepeat = { none: 'all', all: 'one', one: 'none' }[s?.repeat || 'none'];
  const fav = (track, on) => send('fav', { id: track.id, on }, on ? 'Added to favourites' : 'Removed from favourites').then(ok => { if (ok) forget(['favorites']); return ok; });

  // what the library asks for
  const act = {
    play: (source, track, shuffle) => send('play', { source, id: track?.id, shuffle: !!shuffle }),
    more: (track, source) => setSheet({
      open: true,
      title: track.title,
      sub: [track.artist, track.album].filter(Boolean).join(' · '),
      actions: [
        { label: 'Play next', icon: 'next', run: () => send('queue', { source, id: track.id, next: true }, 'Playing next') },
        { label: 'Add to the queue', icon: 'queue', run: () => send('queue', { source, id: track.id }, 'Added to the queue') },
        track.fav
          ? { label: 'Remove from favourites', icon: 'heart', filled: true, run: () => fav(track, false) }
          : { label: 'Add to favourites', icon: 'heart', run: () => fav(track, true) },
      ],
    }),
    moreList: (title, source) => setSheet({
      open: true,
      title,
      actions: [
        { label: 'Play next', icon: 'next', run: () => send('queue', { source, next: true }, 'Playing next') },
        { label: 'Add to the queue', icon: 'queue', run: () => send('queue', { source }, 'Added to the queue') },
      ],
    }),
  };

  // the blurred cover behind now playing on a Fold: the album's colours fill the page
  const ambient = (layout === 'fold' || layout === 'flex') && t?.id
    ? <div className="rm-ambient-box" aria-hidden="true"><div key={`${t.id}-${s?.art || 0}`} className="rm-ambient" style={{ backgroundImage: `url(/api/cover/${t.id}${s?.art ? `?r=${s.art}` : ''})` }} /></div>
    : null;
  const artEl = (
      <div className={`rm-art-wrap ${showLyrics ? 'lyrics' : ''}`}>
        {showLyrics
          ? <Lyrics trackId={t?.id} rev={s?.lyrics} pos={pos} onSeek={ro ? null : (time) => send('seek', { time })} />
          : <Cover id={t?.id} className={`rm-art ${s?.playing ? 'playing' : ''}`} />}
      </div>
  );
  const metaEl = (
      <div className="rm-meta">
        <div className="rm-meta-text">
          <b key={t?.id || 'none'} className="rm-title">{t?.title || 'Nothing playing'}</b>
          <span className="rm-sub">{t ? [t.artist, t.album].filter(Boolean).join(' · ') : 'Pick something in the library or in TeleCloud'}</span>
          <Badges t={t} />
        </div>
        <button className={`rm-icon lyr ${showLyrics ? 'on' : ''}`} onClick={toggleLyrics} aria-pressed={showLyrics} aria-label={showLyrics ? 'Show the cover' : 'Show the lyrics'} title={showLyrics ? 'Cover' : 'Lyrics'}>
          <Icon name="lyrics" />
        </button>
        {t && (
          <button className={`rm-icon cmd heart ${t.fav ? 'on' : ''}`} onClick={() => fav(t, !t.fav)} aria-label={t.fav ? 'Remove from favourites' : 'Add to favourites'} title="Favourite">
            <Icon name="heart" filled={!!t.fav} />
          </button>
        )}
      </div>
  );
  const ctlEl = (
    <div className="rm-ctl">
      <div className="rm-seek">
        <input type="range" className="rm-range cmd" min="0" max={dur || 1} step="0.5" value={pos} disabled={!t || !dur} aria-label="Position"
          style={{ '--pct': `${dur ? Math.min(100, (pos / dur) * 100) : 0}%` }}
          onChange={(e) => setSeekDraft(Number(e.target.value))} onPointerUp={commitSeek} onKeyUp={commitSeek} onBlur={commitSeek} />
        <div className="rm-times mono"><span>{clock(pos)}</span><span>{clock(dur)}</span></div>
      </div>
      <div className="rm-controls">
        <button className={`rm-icon cmd ${s?.shuffle ? 'on' : ''}`} onClick={() => send('shuffle')} aria-label="Shuffle" title="Shuffle"><Icon name="shuffle" /></button>
        <button className="rm-icon cmd big" onClick={() => send('prev')} aria-label="Previous" title="Previous"><Icon name="prev" /></button>
        <button className={`rm-play cmd ${s?.playing ? 'is-playing' : ''}`} onClick={() => send('toggle')} aria-label={s?.playing ? 'Pause' : 'Play'} title={s?.playing ? 'Pause' : 'Play'}>
          <Icon key={s?.playing ? 'pause' : 'play'} name={s?.playing ? 'pause' : 'play'} filled={!s?.playing} />
        </button>
        <button className="rm-icon cmd big" onClick={() => send('next')} aria-label="Next" title="Next"><Icon name="next" /></button>
        <button className={`rm-icon cmd ${s?.repeat !== 'none' ? 'on' : ''}`} onClick={() => send('repeat', { mode: nextRepeat })} aria-label="Repeat" title={`Repeat: ${s?.repeat || 'none'}`}>
          <Icon name="repeat" />{s?.repeat === 'one' && <i className="rm-one">1</i>}
        </button>
      </div>
      <div className="rm-volume">
        <button className={`rm-icon cmd ${s?.muted ? 'on' : ''}`} onClick={() => send('mute', { on: !s?.muted })} aria-label={s?.muted ? 'Unmute' : 'Mute'}><Icon name={s?.muted ? 'mute' : 'volume'} /></button>
        {s?.exclusive
          ? <span className="rm-locked">Fixed at 100% in exclusive mode</span>
          : (
            <>
              <input type="range" className="rm-range cmd" min="0" max="100" step="1" value={vol} aria-label="Volume" style={{ '--pct': `${vol}%` }}
                onChange={(e) => { const v = Number(e.target.value); setVolDraft(v); if (!ro) post('volume', { volume: v }); }} onPointerUp={commitVol} onKeyUp={commitVol} />
              <span className="mono rm-vol">{Math.round(vol)}</span>
            </>
          )}
      </div>
    </div>
  );
  const nowPanel = (
    <section className="rm-now card">
      {ambient}
      {artEl}
      {metaEl}
      {ctlEl}
    </section>
  );

  const queuePanel = (
    <section className="rm-queue card">
      <div className="rm-sec-head"><b>Up next</b><span className="mono">{queue.length}</span></div>
      {queue.length === 0 && <p className="rm-empty">Nothing queued. Start an album or a playlist from the library.</p>}
      <ol className="rm-list">
        {queue.map((q, i) => (
          <li key={`${q.id}-${i}`} style={{ '--i': Math.min(i, 14) }}>
            <button className="rm-row cmd" onClick={() => send('jump', { index: i, id: q.id })} title="Play now">
              <Cover id={q.id} className="rm-thumb" />
              <span className="rm-row-text"><b>{q.title}</b><small><Where t={q} />{q.artist}</small></span>
            </button>
            <span className="rm-row-tools cmd">
              <button className="rm-icon sm" disabled={i === 0} onClick={() => send('move', { from: i, to: i - 1, id: q.id })} aria-label="Move up" title="Move up"><Icon name="chevron" className="up" /></button>
              <button className="rm-icon sm" disabled={i === queue.length - 1} onClick={() => send('move', { from: i, to: i + 1, id: q.id })} aria-label="Move down" title="Move down"><Icon name="chevron" /></button>
              <button className="rm-icon sm" onClick={() => send('remove', { index: i, id: q.id })} aria-label="Remove" title="Remove from the queue"><Icon name="close" /></button>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );

  const sidePanel = (
    <section className="rm-side card">
      <div className="rm-sec-head"><b>Output</b>{s?.verdict && <span className={`badge ${s.bitPerfect ? 'b-lossless' : 'b-cached'}`}>{s.verdict}</span>}</div>
      <div className="rm-outputs" role="radiogroup" aria-label="Output">
        {(s?.outputs || []).map((o, i) => (
          <button key={o.id} role="radio" aria-checked={s.output === o.id} style={{ '--i': i }} className={`rm-output cmd ${s.output === o.id ? 'on' : ''}`} onClick={() => s.output !== o.id && send('output', { id: o.id })}>
            <Icon name={o.id === '-1' ? 'monitor' : 'speaker'} />
            <span>{o.name}{o.id === '-1' ? <small>Shared</small> : <small>Exclusive</small>}</span>
            <Icon name="check" className="tick" />
          </button>
        ))}
      </div>
      <label className="rm-switch cmd">
        <span><Icon name="eq" />Equalizer</span>
        <input type="checkbox" checked={!!s?.eq} onChange={(e) => send('eq', { on: e.target.checked })} />
        <i />
      </label>
      {t && s?.steps?.length > 0 && (
        <div className="rm-sp">
          <div className="rm-sec-head"><b>Signal path</b></div>
          <ol>
            {s.steps.map((x, i) => (
              <li key={`${i}-${x.label}`} className={x.state} style={{ '--i': i }}>
                <i /><span>{x.label}</span><b className="mono">{x.value}</b>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );

  const headerEl = (
      <header className="rm-head">
        <div className={`rm-logo sm ${host?.beta ? 'beta' : ''}`} title={host?.beta ? 'TeleCloud Beta' : 'TeleCloud'}><Icon name="logo" /></div>
        <div className="rm-host">
          <b>{host?.name || 'TeleCloud'}{host?.beta && <span className="rm-beta">Beta</span>}</b>
          {host?.custom && <small>{host.realName}</small>}
        </div>
        {ro && <span className="badge rm-ro-badge" title="Change it in TeleCloud > Settings > Remote">View only</span>}
        <span className={`rm-conn ${online ? 'on' : ''}`} title={online ? 'Connected' : 'Not connected'} />
      </header>
  );
  const panels = { now: nowPanel, library: <Library s={s} act={act} />, queue: queuePanel, side: sidePanel };
  // Flex Mode: the controls get the bottom half to themselves
  if (layout === 'flex') panels.controls = <section className="rm-ctl-panel card">{ctlEl}</section>;
  const miniBar = shown !== 'now' && t ? (
    <div className="rm-mini" role="button" tabIndex={0} onClick={() => setTab('now')} onKeyDown={(e) => { if (e.key === 'Enter') setTab('now'); }}>
      <span className="rm-mini-bar" style={{ '--pct': `${dur ? Math.min(100, (pos / dur) * 100) : 0}%` }} />
      <Cover id={t.id} className="rm-thumb" />
      <span className="rm-row-text"><b>{t.title}</b><small>{t.artist}</small></span>
      <button className="rm-icon cmd" onClick={(e) => { e.stopPropagation(); send('toggle'); }} aria-label={s?.playing ? 'Pause' : 'Play'}><Icon name={s?.playing ? 'pause' : 'play'} filled={!s?.playing} /></button>
      <button className="rm-icon cmd" onClick={(e) => { e.stopPropagation(); send('next'); }} aria-label="Next"><Icon name="next" /></button>
    </div>
  ) : null;
  const pill = <Pill value={shown} onChange={setTab} options={tabs.map(v => ({ value: v, ...TABS[v] }))} />;
  const slots = (ids) => ids.map(id => <div key={id} className={`rm-slot ${shown === id ? 'on' : ''}`} data-slot={id}>{panels[id]}</div>);

  return (
    <ArtRev.Provider value={s?.art || 0}><LibRev.Provider value={s?.lib || 0}>
    <div className={`rm rm-l-${layout} ${ro ? 'ro' : ''}`}>
      {layout !== 'flex' && layout !== 'fold' && headerEl}
      {!online && s && <div className="rm-banner">Can't reach TeleCloud right now. The computer may be asleep or TeleCloud closed, or its address changed: scan the QR code again.</div>}

      {layout === 'phone' && (
        <>
          {pill}
          <main className="rm-stack">{slots(tabs)}</main>
          {miniBar}
        </>
      )}
      {layout === 'cover' && (
        <>
          <main className="rm-stack">{slots(tabs)}</main>
          {miniBar}
          <Pill className="rm-dock" value={shown} onChange={setTab} options={tabs.map(v => ({ value: v, ...TABS[v] }))} />
        </>
      )}
      {layout === 'fold' && (
        <main className="rm-book" style={{ '--crease': `${Math.max(geo.crease || 0, 26)}px` }}>
          <div className="rm-leaf left">{headerEl}{nowPanel}</div>
          <div className="rm-crease" aria-hidden="true" />
          <div className="rm-leaf right rm-col">{pill}<div className="rm-stack">{slots(tabs)}</div></div>
        </main>
      )}
      {layout === 'flex' && (
        <main className="rm-halves" style={{ '--seg-top': `${geo.top}px`, '--seg-gap': `${geo.gap}px` }}>
          <section className="rm-flex-top">
            {ambient}
            {artEl}
            <div className="rm-flex-info">
              {metaEl}
              <small className="rm-flex-host"><span className={`rm-conn ${online ? 'on' : ''}`} />{host?.name || 'TeleCloud'}</small>
            </div>
          </section>
          <div className="rm-flex-hinge" aria-hidden="true" />
          <div className="rm-flex-bottom rm-col">{pill}<div className="rm-stack">{slots(tabs)}</div></div>
        </main>
      )}
      {layout === 'tablet' && (
        <main className="rm-grid">
          {nowPanel}
          <div className="rm-col">{pill}<div className="rm-stack">{slots(tabs)}</div></div>
        </main>
      )}
      {layout === 'desktop' && (
        <main className="rm-grid">
          {sidePanel}
          <div className="rm-col">{pill}<div className="rm-stack">{slots(tabs)}</div></div>
          {nowPanel}
        </main>
      )}

      <Sheet open={!!sheet?.open} title={sheet?.title} sub={sheet?.sub} actions={sheet?.actions || []} onClose={() => setSheet(x => (x ? { ...x, open: false } : x))} />
      <OverflowTooltip />
      {toast && <div key={toast.id} className={`rm-toast ${toast.tone || ''} ${toast.leaving ? 'leaving' : ''}`} role="status">{toast.text}</div>}
    </div>
    </LibRev.Provider></ArtRev.Provider>
  );
}
