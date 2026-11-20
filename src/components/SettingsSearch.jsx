import React, { useMemo } from 'react';
import Icon from './Icon';
import { TOPICS, searchSettings } from '../utils/settingsIndex';

/** The search box at the top of the Settings menu */
export const SettingsSearchBox = ({ inputRef, query, setQuery, active, onOpen, onClose }) => (
  <div className={`set-search ${active ? 'on' : ''}`}>
    <Icon name="search" />
    <input
      ref={inputRef}
      className="set-search-input"
      value={query}
      placeholder="Search settings"
      aria-label="Search settings"
      onFocus={onOpen}
      onChange={(e) => { setQuery(e.target.value); onOpen(); }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); e.currentTarget.blur(); }
        if (e.key === 'ArrowDown') { e.preventDefault(); document.querySelector('.set-results .set-hit')?.focus(); }
        if (e.key === 'Enter') { e.preventDefault(); document.querySelector('.set-results .set-hit')?.click(); }
      }}
    />
    {active && <button className="set-search-x" onClick={onClose} title="Close the search (Esc)" aria-label="Close the search"><Icon name="close" /></button>}
  </div>
);

/** What matches, from every tab, with the topic chips above; a click opens the tab at that setting */
export const SettingsResults = ({ query, topics, setTopics, tabs, onPick }) => {
  const label = (id) => tabs.find(t => t.id === id)?.label || id;
  const hits = useMemo(() => searchSettings(query, topics, label), [query, topics]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id) => setTopics(topics.includes(id) ? topics.filter(t => t !== id) : [...topics, id]);
  // grouped by tab, in the menu's order
  const groups = tabs.map(t => ({ tab: t, items: hits.filter(h => h.tab === t.id) })).filter(g => g.items.length);
  const keys = (e) => {
    const all = [...document.querySelectorAll('.set-results .set-hit')];
    const i = all.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' && i >= 0) { e.preventDefault(); all[Math.min(all.length - 1, i + 1)]?.focus(); }
    if (e.key === 'ArrowUp' && i >= 0) { e.preventDefault(); if (i === 0) document.querySelector('.set-search-input')?.focus(); else all[i - 1]?.focus(); }
  };
  return (
    <section className="set-results" onKeyDown={keys}>
      <div className="set-topics" role="group" aria-label="Filter by topic">
        {TOPICS.map(t => (
          <button key={t.id} className={`set-topic ${topics.includes(t.id) ? 'on' : ''}`} aria-pressed={topics.includes(t.id)} onClick={() => toggle(t.id)}>{t.label}</button>
        ))}
        {topics.length > 0 && <button className="set-topic clear" onClick={() => setTopics([])}>Clear</button>}
      </div>
      <div className="set-count">{hits.length ? `${hits.length} setting${hits.length === 1 ? '' : 's'}` : 'Nothing matches. Try another word, or fewer topics.'}</div>
      {groups.map(g => (
        <div key={g.tab.id} className="set-group">
          <h4><Icon name={g.tab.icon} />{g.tab.label}</h4>
          <div className="card set-card">
            {g.items.map(it => (
              <button key={it.title} className="set-hit" onClick={() => onPick(it)}>
                <span className="set-hit-title">{it.title}</span>
                {it.section && <span className="set-hit-kind">Section</span>}
                <span className="set-hit-topics">{it.topics.map(t => TOPICS.find(x => x.id === t)?.label).filter(Boolean).join(' · ')}</span>
                <Icon name="chevron" className="set-hit-go" />
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
};
