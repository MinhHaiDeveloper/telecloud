import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import { t } from '../i18n';

// Opened once by itself the first time the Word by word tab is used, then from its "How it works" button
export const GUIDE_SEEN = 'lyrics-word-guide-seen';

const K = ({ children }) => <kbd className="wlg-k">{children}</kbd>;

const STEPS = [
  {
    get title() { return t('Start from synced lines'); },
    get body() { return <>{t('Word times go inside each line\'s time, so the lines need times first. If the lyrics are plain text, sync them in the {b} tab (or pick a synced result from the search column).', { b: <b>{t('Sync')}</b> })}</>; },
  },
  {
    get title() { return t('Let Cadence time the words'); },
    get body() { return <><b>{t('Time the words')}</b> {t('listens to the song on this computer and places every word, in about a minute. The first time it asks to download its model (English and other languages; Japanese songs need the Japanese pack too). {b} keeps the words you already fixed.', { b: <b>{t('Only untimed lines')}</b> })}</>; },
  },
  {
    get title() { return t('Play it through and look for the marks'); },
    get body() { return <>{t('The playing word lights up in the list. Lines Cadence was not sure of keep their line time and are marked {span}; lines with no word times yet say', { span: <span className="badge mono b-cached">{t('Check')}</span> })} <span className="badge mono b-local">{t('Line only')}</span>.</>; },
  },
  {
    get title() { return t('Fix a line'); },
    get body() { return <>{t('Click a line to open it on the strip below, where each block is a word and its left edge is where the word starts.')}</>; },
  },
  {
    get title() { return t('Time a chorus once'); },
    get body() { return <>{t('A part sung the same way again (a chorus, a loop) can take the same timing: pick the timed line or lines, {k} {k2}, pick where the repeat starts, {k3} {k4}. Each word lands at the same distance from its own line\'s start. Lines with other words are skipped.', { k: <K>{t('Ctrl')}</K>, k2: <K>C</K>, k3: <K>{t('Ctrl')}</K>, k4: <K>V</K> })}</>; },
  },
  {
    get title() { return t('Save'); },
    get body() { return <><b>{t('Save lyrics')}</b> {t('writes them to the tag or a .lrc file as Enhanced LRC, which TeleCloud and other players show word by word.')}</>; },
  },
];

const WAYS = [
  { icon: 'expand', get title() { return t('Drag'); }, get text() { return t('Drag the edge of a word block left or right. The grey grip at the end is where the line ends.'); } },
  { icon: 'sort', get title() { return t('Nudge'); }, get text() { return <>{t('Click a word, then {k} {k2} move it 0.05 s ({k3} 0.01 s, {k4} 0.2 s). {k5} goes to the next word.', { k: <K>←</K>, k2: <K>→</K>, k3: <K>{t('Shift')}</K>, k4: <K>{t('Alt')}</K>, k5: <K>{t('Tab')}</K> })}</>; } },
  { icon: 'music', get title() { return t('Tap'); }, get text() { return <><b>{t('Tap the words')}</b> {t('plays the line: press {k} as each word starts, and once more when the line ends. {k2} stops.', { k: <K>{t('Space')}</K>, k2: <K>{t('Esc')}</K> })}</>; } },
];

const keyRows = () => [
  [['↑', '/', '↓'], t('Previous or next line')],
  [['Shift', t('Click')], t('Pick several lines (or Shift with ↑ ↓)')],
  [['←', '/', '→'], t('Move the picked word 0.05 s')],
  [['Tab'], t('Next word')],
  [['Enter'], t('Fix the picked word\'s spelling')],
  [['Space'], t('While tapping: the next word starts now')],
  [['Ctrl', 'C'], t('Copy the picked lines\' word times')],
  [['Ctrl', 'V'], t('Paste them onto the picked lines')],
  [['Ctrl', 'X'], t('Cut them')],
  [['Ctrl', 'A'], t('Pick every line')],
  [['Ctrl', 'Z'], t('Undo')],
  [['Ctrl', 'Y'], t('Redo')],
  [['Double-click'], t('Play from that line or word')],
];

/** How the Word by word tab works: a guide over the lyrics dialog. Esc closes only the guide. */
const WordLyricsGuide = ({ onClose }) => {
  useEffect(() => {
    // before the lyrics dialog's own Esc (which would close it and lose the edits)
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop wlg-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card dialog wlg" role="dialog" aria-modal="true" aria-label={t('How word-by-word lyrics work')}>
        <div className="dialog-head">
          <div className="dialog-icon"><Icon name="lyrics" /></div>
          <h3>{t('How word-by-word lyrics work')}</h3>
          <button className="icon-btn sm" onClick={onClose} aria-label={t('Close')}><Icon name="close" /></button>
        </div>
        <div className="dialog-body wlg-body">
          <ol className="wlg-steps">
            {STEPS.map((s, i) => (
              <li key={i}>
                <span className="wlg-n">{i + 1}</span>
                <div>
                  <b>{s.title}</b>
                  <p>{s.body}</p>
                  {i === 3 && (
                    <>
                      <div className="wlg-strip" aria-hidden="true">
                        {[[t('Come'), 4, 14], ['and', 19, 13], ['fly', 33, 9], ['away', 43, 20], ['with', 64, 13], ['me', 78, 12]].map(([w, l, wd], k) => (
                          <div key={w} className={`wle-block ${k === 2 ? 'sel' : ''}`} style={{ left: `${l}%`, width: `${wd}%` }}><span className="wle-grip" /><span className="wle-label">{w}</span></div>
                        ))}
                        <span className="wle-endgrip" style={{ left: '90.5%' }} />
                        <span className="wlg-callout" style={{ left: '33%' }}>{t('word start')}</span>
                        <span className="wlg-callout" style={{ left: '90.5%' }}>{t('line end')}</span>
                      </div>
                      <div className="wlg-ways">
                        {WAYS.map(w => (
                          <div key={w.title} className="wlg-way">
                            <b><Icon name={w.icon} />{w.title}</b>
                            <span>{w.text}</span>
                          </div>
                        ))}
                      </div>
                      <p className="wlg-also">{t('Also on the strip: {b}, the line ±0.1 s, {b2} (words spread by their letters), {b3}, and {b4} to change the words themselves in the Sync tab.', { b: <b>{t('Play line')}</b>, b2: <b>{t('Spread evenly')}</b>, b3: <b>{t('Clear words')}</b>, b4: <b>{t('Edit text')}</b> })}</p>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <h4 className="wlg-h">{t('Keys')}</h4>
          <div className="wlg-keys">
            {keyRows().map(([keys, what]) => (
              <div key={what} className="wlg-key">
                <span>{keys.map((k, i) => (k === '/' ? <i key={i}>{t('or')}</i> : <React.Fragment key={i}>{i > 0 && keys[i - 1] !== '/' && <i>+</i>}<K>{k}</K></React.Fragment>))}</span>
                <span>{what}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="dialog-actions">
          <span style={{ flex: 1 }} />
          <button className="btn-primary" onClick={onClose} autoFocus>{t('Got it')}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default WordLyricsGuide;
