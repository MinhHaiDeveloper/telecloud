import { createContext } from 'react';

// Actions every song list can offer (track menu and the selection bar), provided once by App
// so each view does not have to pass them down. A list's own props win over these.
const SongActions = createContext({});

export default SongActions;
