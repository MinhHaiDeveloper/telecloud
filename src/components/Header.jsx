import React, { useEffect, useRef } from 'react';
import Icon from './Icon';
import useSlidingIndicator from '../hooks/useSlidingIndicator';
import { t } from '../i18n';

const SOURCES = [
  { id: 'all', get label() { return t('All'); } },
  { id: 'local', get label() { return t('Local'); } },
  { id: 'cloud', label: 'TeleCloud' },
];

const Header = ({ searchQuery, onSearchChange, source, onSourceChange, onRefresh, isScanning, theme, onToggleTheme, onOpenSettings, panel, onTogglePanel }) => {
  const inputRef = useRef(null);
  const tabsRef = useSlidingIndicator('x', source);

  // Ctrl+K focuses search from anywhere
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className="topbar">
      <label className="search">
        <Icon name="search" />
        <input
          ref={inputRef}
          placeholder={t('Search by artists, songs or albums')}
          value={searchQuery || ''}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { onSearchChange(''); e.currentTarget.blur(); } }}
        />
        {searchQuery
          ? <button className="icon-btn sm" onClick={() => onSearchChange('')} aria-label={t('Clear search')}><Icon name="close" /></button>
          : <span className="kbd">{t('Ctrl K')}</span>}
      </label>

      <div className="source-tabs slider-host" role="tablist" ref={tabsRef}>
        <span className="indicator" />
        {SOURCES.map(s => (
          <button key={s.id} role="tab" className={source === s.id ? 'on' : ''} data-active={source === s.id} onClick={() => onSourceChange(s.id)}>
            {s.label}
          </button>
        ))}
      </div>

      <div className="top-actions">
        <button className="btn-outline" onClick={onRefresh} disabled={isScanning}>
          <Icon name="refresh" className={isScanning ? 'spinning' : ''} />{isScanning ? t('Scanning…') : t('Scan library')}
        </button>
        <button className="icon-btn" onClick={onToggleTheme} title={theme === 'dark' ? t('Light theme') : t('Dark theme')} aria-label={t('Toggle theme')}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
        {panel !== null && panel !== undefined && (
          <button className={`icon-btn panel-toggle ${panel ? 'on' : ''}`} onClick={onTogglePanel} title={panel ? t('Hide the side panel') : t('Show the side panel')} aria-label={t('Side panel')} aria-pressed={panel}><Icon name="panel" /></button>
        )}
        <button className="icon-btn" onClick={onOpenSettings} title={t('Settings')} aria-label={t('Settings')}><Icon name="settings" /></button>
      </div>
    </header>
  );
};

export default Header;
