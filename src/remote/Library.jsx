// The library on a remote: search, albums, artists, playlists, favourites, recently played.
// Lists come from TeleCloud a page at a time; nothing is sent whole.
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import Icon from '../components/Icon';
import { browse, forget } from './api';
import { Cover, Playing, Where } from './parts';

const SECTIONS = [
  { v: 'albums', label: 'Albums', icon: 'disc', count: 'albums' },
  { v: 'artists', label: 'Artists', icon: 'user', count: 'artists' },
  { v: 'playlists', label: 'Playlists', icon: 'playlist', count: 'playlists' },
  { v: 'favorites', label: 'Favourites', icon: 'heart', count: 'favorites' },
  { v: 'recent', label: 'Recently played', icon: 'clock', count: 'recent' },
];
const TITLES = Object.fromEntries(SECTIONS.map(s => [s.v, s.label]));
const plural = (n, one) => `${(n || 0).toLocaleString()} ${one}${n === 1 ? '' : 's'}`;

/** Changes when TeleCloud's library, favourites or playlists do: what is on screen is asked for again */
export const LibRev = createContext(0);

function useAnswer(req, deps) {
  const rev = useContext(LibRev);
  const [st, setSt] = useState({ data: null, error: '' });
  useEffect(() => {
    if (!req) { setSt({ data: null, error: '' }); return undefined; }
    let live = true;
    setSt(x => ({ data: x.data, error: '' }));
    browse(req).then(data => live && setSt({ data, error: '' })).catch(err => live && setSt({ data: null, error: err.message }));
    return () => { live = false; };
  }, [...deps, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  return st;
}

/** A long list, a page at a time as it scrolls. */
function usePaged(kind, sort) {
  const [st, setSt] = useState({ items: [], total: null, error: '', busy: false });
  const busy = useRef(false);
  const gen = useRef(0);
  const more = useCallback(async (reset) => {
    if (busy.current) return;
    busy.current = true;
    const g = gen.current;
    setSt(x => ({ ...x, busy: true }));
    try {
      const offset = reset ? 0 : st.items.length;
      const r = await browse({ kind, sort, offset, limit: 60 });
      if (g === gen.current) setSt(x => ({ items: reset ? r.items : [...x.items, ...r.items], total: r.total, error: '', busy: false }));
    } catch (err) { if (g === gen.current) setSt(x => ({ ...x, error: err.message, busy: false })); }
    if (g === gen.current) busy.current = false;
  }, [kind, sort, st.items.length]);
  // another sort: start again (an answer still on its way for the old one is dropped)
  useEffect(() => { gen.current += 1; setSt({ items: [], total: null, error: '', busy: false }); busy.current = false; }, [kind, sort]);
  useEffect(() => { if (st.total === null && !st.busy && !st.error) more(true); }, [st.total, st.busy, st.error, more]);
  // the library changed on the computer: the pages already shown again, in place (no jump to the top)
  const rev = useContext(LibRev);
  const seen = useRef(rev);
  useEffect(() => {
    if (seen.current === rev) return;
    seen.current = rev;
    const g = ++gen.current;
    const want = Math.max(60, st.items.length);
    (async () => {
      try {
        let items = [];
        let total = 0;
        for (let offset = 0; offset < want; offset += 60) {
          const r = await browse({ kind, sort, offset, limit: 60 });
          items = items.concat(r.items);
          total = r.total;
          if (offset + 60 >= r.total) break;
        }
        if (g === gen.current) { busy.current = false; setSt({ items, total, error: '', busy: false }); }
      } catch (err) { if (g === gen.current) setSt(x => ({ ...x, error: err.message })); }
    })();
  }, [rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = st.total !== null && st.items.length >= st.total;
  return { ...st, more: () => !done && more(false), done };
}

const Sentinel = ({ onSee, done }) => {
  const ref = useRef(null);
  useEffect(() => {
    if (done || !ref.current) return undefined;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) onSee(); }, { rootMargin: '400px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [onSee, done]);
  return done ? null : <div ref={ref} className="rm-more"><span className="rm-ring sm" /></div>;
};

const Problem = ({ text }) => (text ? <p className="rm-empty">{text}</p> : null);
const Loading = () => <div className="rm-more"><span className="rm-ring sm" /></div>;

export default function Library({ s, act }) {
  // Pages stay open under the one shown (hidden, each with its own scroll), so Back finds a list
  // exactly where it was left, with the pages already loaded
  const nextId = useRef(1);
  const [stack, setStack] = useState([{ v: 'home', id: 0 }]);
  const [dir, setDir] = useState('in');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const top = stack[stack.length - 1];
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 250); return () => clearTimeout(t); }, [q]);

  const push = (page) => { setDir('in'); setStack(x => [...x, { ...page, id: nextId.current++ }]); };
  const back = () => { setDir('out'); setStack(x => (x.length > 1 ? x.slice(0, -1) : x)); };
  const playingId = s?.track?.id;
  const paused = !s?.playing;

  const row = (t, i, source, { numbered = false } = {}) => (
    <li key={`${t.id}-${i}`} style={{ '--i': Math.min(i, 14) }}>
      <button className={`rm-row cmd ${t.id === playingId ? 'now' : ''}`} onClick={() => act.play(source, t)}>
        {numbered ? <span className="rm-no mono">{t.id === playingId ? <Playing paused={paused} /> : i + 1}</span> : (
          <span className="rm-thumb-wrap"><Cover id={t.id} className="rm-thumb" />{t.id === playingId && <span className="rm-thumb-now"><Playing paused={paused} /></span>}</span>
        )}
        <span className="rm-row-text"><b>{t.title}</b><small><Where t={t} />{[t.artist, numbered ? null : t.album].filter(Boolean).join(' · ')}</small></span>
      </button>
      <button className="rm-icon sm" onClick={() => act.more(t, source)} aria-label={`More for ${t.title}`} title="More"><Icon name="more" /></button>
    </li>
  );
  const albumCard = (a, i) => (
    <button key={a.key} className="rm-card" style={{ '--i': Math.min(i, 14) }} onClick={() => push({ v: 'album', key: a.key, name: a.name })}>
      <Cover id={a.cover} className="rm-card-art" />
      <b>{a.name}</b><small>{[a.artist, a.year || null].filter(Boolean).join(' · ')}</small>
    </button>
  );
  const listHead = (title, sub, source, cover, { round = false, pic } = {}) => (
    <div className="rm-hero">
      <Cover id={cover} pic={pic} motion={!!pic} className="rm-hero-art" round={round} />
      <div className="rm-hero-text">
        <b>{title}</b><small>{sub}</small>
        <div className="rm-hero-actions">
          <button className="rm-btn primary cmd" onClick={() => act.play(source)}><Icon name="play" filled />Play</button>
          <button className="rm-btn cmd" onClick={() => act.play(source, null, true)}><Icon name="shuffle" />Shuffle</button>
          <button className="rm-icon sm cmd" onClick={() => act.moreList(title, source)} aria-label="More" title="Play next, add to the queue"><Icon name="more" /></button>
        </div>
      </div>
    </div>
  );

  const bodyOf = (p) => {
    if (p.v === 'home') return <Home query={query} push={push} row={row} albumCard={albumCard} />;
    if (p.v === 'albums') return <Albums albumCard={albumCard} />;
    if (p.v === 'artists') return <Artists push={push} />;
    if (p.v === 'playlists') return <Playlists push={push} />;
    if (p.v === 'favorites' || p.v === 'recent') return <Tracks kind={p.v} row={row} listHead={listHead} />;
    if (p.v === 'album') return <Album k={p.key} row={row} listHead={listHead} />;
    if (p.v === 'artist') return <Artist k={p.key} albumCard={albumCard} listHead={listHead} />;
    if (p.v === 'playlist') return <Playlist k={p.key} row={row} listHead={listHead} />;
    return null;
  };
  const title = top.v === 'home' ? 'Library' : TITLES[top.v] || top.name || 'Library';

  return (
    <section className="rm-library card">
      <div className="rm-lib-head">
        {stack.length > 1
          ? <button className="rm-icon sm back" onClick={back} aria-label="Back" title="Back"><Icon name="chevron" /></button>
          : <Icon name="library" className="rm-lib-ico" />}
        <b key={`${top.v}-${top.key || ''}`} className="rm-lib-title">{title}</b>
      </div>
      {top.v === 'home' && (
        <label className="rm-search">
          <Icon name="search" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search songs, albums, artists" enterKeyHint="search" aria-label="Search the library" />
          {q && <button className="rm-icon sm" onClick={() => setQ('')} aria-label="Clear"><Icon name="close" /></button>}
        </label>
      )}
      <div className="rm-lib-body">
        {stack.map((p, i) => (
          <div key={p.id} className={`rm-page ${i === stack.length - 1 ? `top ${dir}` : 'under'}`} aria-hidden={i !== stack.length - 1}>{bodyOf(p)}</div>
        ))}
      </div>
    </section>
  );
}

function Home({ query, push, row, albumCard }) {
  const home = useAnswer({ kind: 'home' }, []);
  const found = useAnswer(query ? { kind: 'search', q: query } : null, [query]);
  if (query) {
    const r = found.data;
    if (found.error) return <Problem text={found.error} />;
    if (!r) return <Loading />;
    const none = !r.tracks.length && !r.albums.length && !r.artists.length;
    return (
      <div className="rm-results">
        {none && <p className="rm-empty">Nothing matches “{query}”.</p>}
        {r.tracks.length > 0 && (<><h4>Songs</h4><ol className="rm-list">{r.tracks.map((t, i) => row(t, i, { kind: 'search', key: query }))}</ol></>)}
        {r.albums.length > 0 && (<><h4>Albums</h4><div className="rm-shelf">{r.albums.map(albumCard)}</div></>)}
        {r.artists.length > 0 && (
          <><h4>Artists</h4>
            <ol className="rm-list">{r.artists.map((a, i) => (
              <li key={a.name} style={{ '--i': i }}><button className="rm-row" onClick={() => push({ v: 'artist', key: a.name, name: a.name })}>
                <Cover id={a.cover} pic={a.pic} className="rm-thumb" round /><span className="rm-row-text"><b>{a.name}</b><small>{plural(a.count, 'track')}</small></span><Icon name="chevron" className="go" />
              </button></li>
            ))}</ol>
          </>
        )}
      </div>
    );
  }
  const n = home.data || {};
  return (
    <>
      <ol className="rm-list rm-sections">
        {SECTIONS.map((x, i) => (
          <li key={x.v} style={{ '--i': i }}>
            <button className="rm-row" onClick={() => push({ v: x.v })}>
              <span className="rm-sec-ico"><Icon name={x.icon} /></span>
              <span className="rm-row-text"><b>{x.label}</b></span>
              <span className="mono rm-count">{home.data ? (n[x.count] || 0).toLocaleString() : ''}</span>
              <Icon name="chevron" className="go" />
            </button>
          </li>
        ))}
      </ol>
      {home.data && <p className="rm-foot">{plural(n.tracks, 'track')} on this computer</p>}
      <Problem text={home.error} />
    </>
  );
}

const SORTS = [['name', 'A–Z'], ['artist', 'Artist'], ['latest', 'Latest added'], ['oldest', 'Oldest added']];
const savedSort = () => { try { const v = localStorage.getItem('rm-album-sort'); return SORTS.some(([k]) => k === v) ? v : 'name'; } catch { return 'name'; } };

function Albums({ albumCard }) {
  // kept on this device, like the app keeps its own sort
  const [sort, setSortState] = useState(savedSort);
  const setSort = (v) => { setSortState(v); try { localStorage.setItem('rm-album-sort', v); } catch { /* fine */ } };
  const p = usePaged('albums', sort);
  return (
    <>
      <div className="rm-sorts">
        {SORTS.map(([v, l]) => (
          <button key={v} className={sort === v ? 'on' : ''} onClick={() => setSort(v)}>{l}</button>
        ))}
        {p.total != null && <span className="mono">{p.total.toLocaleString()}</span>}
      </div>
      <div className="rm-cards">{p.items.map(albumCard)}</div>
      <Problem text={p.error} />
      <Sentinel onSee={p.more} done={p.done || !!p.error} />
    </>
  );
}

function Artists({ push }) {
  const p = usePaged('artists');
  return (
    <>
      <ol className="rm-list">
        {p.items.map((a, i) => (
          <li key={a.name} style={{ '--i': Math.min(i % 60, 14) }}>
            <button className="rm-row" onClick={() => push({ v: 'artist', key: a.name, name: a.name })}>
              <Cover id={a.cover} pic={a.pic} className="rm-thumb" round />
              <span className="rm-row-text"><b>{a.name}</b><small>{plural(a.count, 'track')}</small></span>
              <Icon name="chevron" className="go" />
            </button>
          </li>
        ))}
      </ol>
      <Problem text={p.error} />
      <Sentinel onSee={p.more} done={p.done || !!p.error} />
    </>
  );
}

function Playlists({ push }) {
  const r = useAnswer({ kind: 'playlists' }, []);
  if (r.error) return <Problem text={r.error} />;
  if (!r.data) return <Loading />;
  if (!r.data.items.length) return <p className="rm-empty">No playlists yet. Make one in TeleCloud.</p>;
  return (
    <ol className="rm-list">
      {r.data.items.map((p, i) => (
        <li key={p.key} style={{ '--i': i }}>
          <button className="rm-row" onClick={() => push({ v: 'playlist', key: p.key, name: p.name })}>
            <Cover id={p.cover} className="rm-thumb" />
            <span className="rm-row-text"><b>{p.name}</b><small>{plural(p.count, 'track')}</small></span>
            <Icon name="chevron" className="go" />
          </button>
        </li>
      ))}
    </ol>
  );
}

function Tracks({ kind, row, listHead }) {
  useEffect(() => forget([kind]), [kind]);
  const p = usePaged(kind);
  const source = { kind };
  if (p.total === 0) return <p className="rm-empty">{kind === 'favorites' ? 'No favourites yet. Tap the heart on a track.' : 'Nothing played yet.'}</p>;
  return (
    <>
      {p.total != null && listHead(TITLES[kind], plural(p.total, 'track'), source, p.items[0]?.id)}
      <ol className="rm-list">{p.items.map((t, i) => row(t, i, source))}</ol>
      <Problem text={p.error} />
      <Sentinel onSee={p.more} done={p.done || !!p.error} />
    </>
  );
}

function Album({ k, row, listHead }) {
  const r = useAnswer({ kind: 'album', key: k }, [k]);
  if (r.error) return <Problem text={r.error} />;
  if (!r.data) return <Loading />;
  if (r.data.missing) return <p className="rm-empty">This album is no longer in the library.</p>;
  const { album, tracks } = r.data;
  const source = { kind: 'album', key: album.key };
  return (
    <>
      {listHead(album.name, [album.artist, album.year || null, plural(tracks.length, 'track')].filter(Boolean).join(' · '), source, album.cover)}
      <ol className="rm-list">{tracks.map((t, i) => row(t, i, source, { numbered: true }))}</ol>
    </>
  );
}

function Artist({ k, albumCard, listHead }) {
  const r = useAnswer({ kind: 'artist', key: k }, [k]);
  if (r.error) return <Problem text={r.error} />;
  if (!r.data) return <Loading />;
  if (r.data.missing) return <p className="rm-empty">This artist is no longer in the library.</p>;
  const { artist, albums } = r.data;
  return (
    <>
      {listHead(artist.name, `${plural(albums.length, 'album')} · ${plural(artist.count, 'track')}`, { kind: 'artist', key: artist.name }, artist.cover, { round: true, pic: artist.pic })}
      <div className="rm-cards">{albums.map(albumCard)}</div>
    </>
  );
}

function Playlist({ k, row, listHead }) {
  const r = useAnswer({ kind: 'playlist', key: k }, [k]);
  if (r.error) return <Problem text={r.error} />;
  if (!r.data) return <Loading />;
  if (r.data.missing) return <p className="rm-empty">This playlist was deleted.</p>;
  const { playlist, tracks } = r.data;
  const source = { kind: 'playlist', key: playlist.key };
  return (
    <>
      {listHead(playlist.name, plural(tracks.length, 'track'), source, playlist.cover)}
      {!tracks.length && <p className="rm-empty">This playlist is empty.</p>}
      <ol className="rm-list">{tracks.map((t, i) => row(t, i, source))}</ol>
    </>
  );
}
