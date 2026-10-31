import React, { useEffect, useRef } from 'react';
import Icon from './Icon';
import useSlidingIndicator from '../hooks/useSlidingIndicator';

const SOURCES = [
  { id: 'all', label: 'All' },
  { id: 'local', label: 'Local' },
  { id: 'cloud', label: 'TeleCloud' },
];

const Header = ({ searchQuery, onSearchChange, source, onSourceChange, onRefresh, isScanning, theme, onToggleTheme, onOpenSettings }) => {
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
          placeholder="Search by artists, songs or albums"
          value={searchQuery || ''}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { onSearchChange(''); e.currentTarget.blur(); } }}
        />
        {searchQuery
          ? <button className="icon-btn sm" onClick={() => onSearchChange('')} aria-label="Clear search"><Icon name="close" /></button>
          : <span className="kbd">Ctrl K</span>}
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
          <Icon name="refresh" className={isScanning ? 'spinning' : ''} />{isScanning ? 'Scanning…' : 'Scan library'}
        </button>
        <button className="icon-btn" onClick={onToggleTheme} title={theme === 'dark' ? 'Light theme' : 'Dark theme'} aria-label="Toggle theme">
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
        <button className="icon-btn" onClick={onOpenSettings} title="Settings" aria-label="Settings"><Icon name="settings" /></button>
      </div>
    </header>
  );
};

export default Header;
