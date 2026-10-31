import React, { useState, useEffect, useRef } from 'react';
import Icon from './Icon';
import useSlidingIndicator from '../hooks/useSlidingIndicator';

const PLAYLIST_COLORS = ['#ff5c5c', '#3fcf8e', '#f5b942', '#9b7bff', '#4cc3ff', '#ff8ad8'];

const NAV_MAIN = [
  { id: 'home', label: 'Discover', icon: 'discover' },
  { id: 'library', label: 'Library', icon: 'library', countKey: 'library' },
];
const NAV_MUSIC = [
  { id: 'favorites', label: 'Favourites', icon: 'heart', countKey: 'favorites' },
  { id: 'recent', label: 'Recently played', icon: 'clock' },
  { id: 'artists', label: 'Artists', icon: 'user' },
  { id: 'albums', label: 'Albums', icon: 'disc' },
];

const Sidebar = ({
  currentView, onNavClick, isCollapsed, onToggleCollapse, counts = {},
  playlists = [], selectedPlaylistId, onOpenPlaylist, onCreatePlaylist,
  signal, devices = [], selectedDevice, onDeviceChange,
}) => {
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const deviceRef = useRef(null);
  const activeKey = currentView === 'playlists' && selectedPlaylistId ? `pl:${selectedPlaylistId}` : currentView;
  const navRef = useSlidingIndicator('y', `${activeKey}|${isCollapsed}|${playlists.length}`, 6);

  useEffect(() => {
    if (!deviceMenuOpen) return undefined;
    const close = (e) => { if (!deviceRef.current?.contains(e.target)) setDeviceMenuOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [deviceMenuOpen]);

  const navButton = (item) => (
    <button
      key={item.id}
      className={`nav-item ${activeKey === item.id ? 'active' : ''}`}
      data-active={activeKey === item.id}
      onClick={() => onNavClick(item.id)}
      title={item.label}
    >
      <Icon name={item.icon} />
      <span className="txt">{item.label}</span>
      {item.countKey && counts[item.countKey] > 0 && <span className="count">{counts[item.countKey].toLocaleString()}</span>}
    </button>
  );

  return (
    <aside className="sidebar">
      <div className="logo">
        <div className="logo-mark"><Icon name="logo" /></div>
        <span className="logo-text">TeleCloud</span>
        <button className="icon-btn sm collapse-btn" onClick={onToggleCollapse} title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          <Icon name="chevronLeft" />
        </button>
      </div>

      <nav className="side-nav slider-host" ref={navRef}>
        <span className="indicator" />
        {NAV_MAIN.map(navButton)}
        <button
          className={`nav-item ${activeKey === 'telecloud' ? 'active' : ''}`}
          data-active={activeKey === 'telecloud'}
          onClick={() => onNavClick('telecloud')}
          title="TeleCloud"
        >
          <Icon name="cloud" />
          <span className="txt">TeleCloud</span>
          {counts.cloud > 0 && <span className="count">{counts.cloud.toLocaleString()}</span>}
        </button>

        <div className="nav-label">Your music</div>
        {NAV_MUSIC.map(navButton)}

        <div className="nav-label">Your playlists</div>
        {playlists.map((p, i) => {
          const key = `pl:${p.id}`;
          return (
            <button
              key={p.id}
              className={`nav-item ${activeKey === key ? 'active' : ''}`}
              data-active={activeKey === key}
              onClick={() => onOpenPlaylist(p.id)}
              title={p.name}
            >
              <i className="dot" style={{ background: PLAYLIST_COLORS[i % PLAYLIST_COLORS.length] }} />
              <span className="txt">{p.name}</span>
              <span className="count">{p.songs?.length || 0}</span>
            </button>
          );
        })}
        <button className="create-pl" onClick={onCreatePlaylist} title="Create new playlist">
          <span>Create new playlist</span><Icon name="plus" />
        </button>

        <div className="nav-label">System</div>
        {navButton({ id: 'settings', label: 'Settings', icon: 'settings' })}
      </nav>

      {/* Output device: shows the live signal state and switches devices */}
      <div className="device-wrap" ref={deviceRef}>
        {deviceMenuOpen && (
          <div className="menu device-menu">
            <div className="menu-title">Output device</div>
            <button className={`menu-item ${selectedDevice === '-1' ? 'on' : ''}`} onClick={() => { onDeviceChange('-1'); setDeviceMenuOpen(false); }}>
              <Icon name="monitor" />System default (shared)
            </button>
            {devices.map(d => (
              <button key={d.id} className={`menu-item ${selectedDevice === d.id ? 'on' : ''}`} onClick={() => { onDeviceChange(d.id); setDeviceMenuOpen(false); }} title={d.name}>
                <Icon name="speaker" /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
              </button>
            ))}
          </div>
        )}
        <button className="device-card" onClick={() => setDeviceMenuOpen(o => !o)} title={signal?.deviceName}>
          <div className="device-top">
            <div className="device-icon"><Icon name="speaker" /></div>
            <div className="device-info">
              <div className="device-name">{signal?.deviceName?.replace(/ \(WASAPI\)$/, '') || 'System default'}</div>
              <div className="device-sub">{signal?.exclusive ? 'WASAPI · Exclusive' : 'Shared mode'}</div>
            </div>
          </div>
          <div className="device-meta">
            <span className={`badge ${signal?.bitPerfect ? 'b-lossless' : 'b-cached'}`}>{signal?.verdict || 'Idle'}</span>
            {signal?.outSpec && <span className="badge b-hires mono">{signal.outSpec} kHz</span>}
          </div>
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
