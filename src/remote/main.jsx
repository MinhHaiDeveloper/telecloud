// TeleCloud Remote: the page another device opens to control TeleCloud (served by electron/remote.js)
import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/manrope';
import '@fontsource/jetbrains-mono/500.css';
import '../styles/tokens.css';
import '../styles/themes.css';
import './remote.css';
import RemoteApp from './RemoteApp';

ReactDOM.createRoot(document.getElementById('root')).render(<RemoteApp />);
