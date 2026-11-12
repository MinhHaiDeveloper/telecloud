import React, { useState } from 'react';
import { Dialog } from './ui';
import Icon from './Icon';
import { RELEASES, RELEASES_URL, compareVersions, shortVersion } from '../utils/whatsNew';

const openReleases = () => window.ipcRenderer.invoke('open-external', RELEASES_URL);

const List = ({ items }) => <ul className="whats-new-list">{items.map(text => <li key={text}>{text}</li>)}</ul>;
/** A release's notes: a plain list, or a list per section (1.0.0 sums up all the betas that way) */
const Notes = ({ release: r }) => (
  <>
    {r.intro && <p className="whats-new-intro">{r.intro}</p>}
    {r.sections
      ? r.sections.map(x => <div key={x.title} className="whats-new-section"><h5>{x.title}</h5><List items={x.items} /></div>)
      : <List items={r.items} />}
  </>
);

/** Shown once, the first time the app opens after an update */
export const WhatsNewDialog = ({ releases, onClose }) => (
  <Dialog
    title={`What's new in ${shortVersion(releases[0].version)}`}
    icon="info"
    width={560}
    onClose={onClose}
    actions={(
      <>
        <button className="btn-ghost" onClick={openReleases}>All releases</button>
        <button className="btn-primary" onClick={onClose}>Got it</button>
      </>
    )}
  >
    <div className="whats-new-scroll">
      {releases.map((r, i) => (
        <div key={r.version}>
          {releases.length > 1 && <h4 className={i ? 'whats-new-older' : ''}>{shortVersion(r.version)}</h4>}
          <Notes release={r} />
        </div>
      ))}
    </div>
  </Dialog>
);

/** Settings → About: this version, with earlier ones a click away */
export const WhatsNewSection = ({ version }) => {
  const [older, setOlder] = useState(false);
  const known = RELEASES.filter(r => compareVersions(r.version, version) <= 0);
  const [latest, ...rest] = known;
  if (!latest) return null;
  return (
    <section className="set-section">
      <div className="head-row">
        <h3>What's new in {shortVersion(latest.version)}</h3>
        <div className="btn-row"><button className="btn-ghost sm" onClick={openReleases}><Icon name="info" />All releases</button></div>
      </div>
      <div className="card whats-new-card">
        <Notes release={latest} />
        {rest.length > 0 && <button className="link-btn whats-new-more" onClick={() => setOlder(v => !v)}>{older ? 'Hide earlier versions' : 'Show earlier versions'}</button>}
        {older && rest.map(r => (
          <div key={r.version}>
            <h4 className="whats-new-older">{shortVersion(r.version)}</h4>
            <Notes release={r} />
          </div>
        ))}
      </div>
    </section>
  );
};
