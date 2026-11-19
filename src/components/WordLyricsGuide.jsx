import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';

// Opened once by itself the first time the Word by word tab is used, then from its "How it works" button
export const GUIDE_SEEN = 'lyrics-word-guide-seen';

const K = ({ children }) => <kbd className="wlg-k">{children}</kbd>;

const STEPS = [
  {
    title: 'Start from synced lines',
    body: <>Word times go inside each line's time, so the lines need times first. If the lyrics are plain text, sync them in the <b>Sync</b> tab (or pick a synced result from the search column).</>,
  },
  {
    title: 'Let Cadence time the words',
    body: <><b>Time the words</b> listens to the song on this computer and places every word, in about a minute. The first time it asks to download its model (English and other languages; Japanese songs need the Japanese pack too). <b>Only untimed lines</b> keeps the words you already fixed.</>,
  },
  {
    title: 'Play it through and look for the marks',
    body: <>The playing word lights up in the list. Lines Cadence was not sure of keep their line time and are marked <span className="badge mono b-cached">Check</span>; lines with no word times yet say <span className="badge mono b-local">Line only</span>.</>,
  },
  {
    title: 'Fix a line',
    body: <>Click a line to open it on the strip below, where each block is a word and its left edge is where the word starts.</>,
  },
  {
    title: 'Time a chorus once',
    body: <>A part sung the same way again (a chorus, a loop) can take the same timing: pick the timed line or lines, <K>Ctrl</K> <K>C</K>, pick where the repeat starts, <K>Ctrl</K> <K>V</K>. Each word lands at the same distance from its own line's start. Lines with other words are skipped.</>,
  },
  {
    title: 'Save',
    body: <><b>Save lyrics</b> writes them to the tag or a .lrc file as Enhanced LRC, which TeleCloud and other players show word by word.</>,
  },
];

const WAYS = [
  { icon: 'expand', title: 'Drag', text: 'Drag the edge of a word block left or right. The grey grip at the end is where the line ends.' },
  { icon: 'sort', title: 'Nudge', text: <>Click a word, then <K>←</K> <K>→</K> move it 0.05 s (<K>Shift</K> 0.01 s, <K>Alt</K> 0.2 s). <K>Tab</K> goes to the next word.</> },
  { icon: 'music', title: 'Tap', text: <><b>Tap the words</b> plays the line: press <K>Space</K> as each word starts, and once more when the line ends. <K>Esc</K> stops.</> },
];

const KEYS = [
  [['↑', '/', '↓'], 'Previous or next line'],
  [['Shift', 'Click'], 'Pick several lines (or Shift with ↑ ↓)'],
  [['←', '/', '→'], 'Move the picked word 0.05 s'],
  [['Tab'], 'Next word'],
  [['Enter'], 'Fix the picked word\'s spelling'],
  [['Space'], 'While tapping: the next word starts now'],
  [['Ctrl', 'C'], 'Copy the picked lines\' word times'],
  [['Ctrl', 'V'], 'Paste them onto the picked lines'],
  [['Ctrl', 'X'], 'Cut them'],
  [['Ctrl', 'A'], 'Pick every line'],
  [['Ctrl', 'Z'], 'Undo'],
  [['Ctrl', 'Y'], 'Redo'],
  [['Double-click'], 'Play from that line or word'],
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
      <div className="card dialog wlg" role="dialog" aria-modal="true" aria-label="How word-by-word lyrics work">
        <div className="dialog-head">
          <div className="dialog-icon"><Icon name="lyrics" /></div>
          <h3>How word-by-word lyrics work</h3>
          <button className="icon-btn sm" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
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
                        {[['Come', 4, 14], ['and', 19, 13], ['fly', 33, 9], ['away', 43, 20], ['with', 64, 13], ['me', 78, 12]].map(([w, l, wd], k) => (
                          <div key={w} className={`wle-block ${k === 2 ? 'sel' : ''}`} style={{ left: `${l}%`, width: `${wd}%` }}><span className="wle-grip" /><span className="wle-label">{w}</span></div>
                        ))}
                        <span className="wle-endgrip" style={{ left: '90.5%' }} />
                        <span className="wlg-callout" style={{ left: '33%' }}>word start</span>
                        <span className="wlg-callout" style={{ left: '90.5%' }}>line end</span>
                      </div>
                      <div className="wlg-ways">
                        {WAYS.map(w => (
                          <div key={w.title} className="wlg-way">
                            <b><Icon name={w.icon} />{w.title}</b>
                            <span>{w.text}</span>
                          </div>
                        ))}
                      </div>
                      <p className="wlg-also">Also on the strip: <b>Play line</b>, the line ±0.1 s, <b>Spread evenly</b> (words spread by their letters), <b>Clear words</b>, and <b>Edit text</b> to change the words themselves in the Sync tab.</p>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <h4 className="wlg-h">Keys</h4>
          <div className="wlg-keys">
            {KEYS.map(([keys, what]) => (
              <div key={what} className="wlg-key">
                <span>{keys.map((k, i) => (k === '/' ? <i key={i}>or</i> : <React.Fragment key={i}>{i > 0 && keys[i - 1] !== '/' && <i>+</i>}<K>{k}</K></React.Fragment>))}</span>
                <span>{what}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="dialog-actions">
          <span style={{ flex: 1 }} />
          <button className="btn-primary" onClick={onClose} autoFocus>Got it</button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default WordLyricsGuide;
