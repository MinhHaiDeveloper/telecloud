import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/manrope';
import '@fontsource/jetbrains-mono/500.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/components.css';
import './styles/themes.css';
import App from './App';
import FloatingLyrics from './components/FloatingLyrics';
import './styles/floating.css';
import pkg from '../package.json';

// TeleCloud Beta looks its own: the name on the taskbar, a blue-violet mark, a Beta tag
if (pkg.version.includes('-')) {
  document.title = 'TeleCloud Beta';
  document.documentElement.dataset.channel = 'beta';
}

// the floating lyrics window loads this same page with its own hash, and shows only the lyrics
const floating = window.location.hash === '#floating-lyrics';
if (floating) document.documentElement.classList.add('floating-lyrics');

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {floating ? <FloatingLyrics /> : <App />}
  </React.StrictMode>
);
