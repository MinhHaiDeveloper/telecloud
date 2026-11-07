// Every theme the app has. Their colours are CSS tokens: Dark and Vanilla in styles/tokens.css, the
// others in styles/themes.css. "kind" is what the sun and moon button in the top bar switches between.
export const THEMES = [
  { id: 'dark', name: 'Dark', kind: 'dark' },
  { id: 'light', name: 'Vanilla', kind: 'light' },
  { id: 'matcha', name: 'Matcha', kind: 'light' },
  { id: 'sakura', name: 'Sakura', kind: 'light' },
  { id: 'hojicha', name: 'Hojicha', kind: 'dark' },
  { id: 'yozakura', name: 'Yozakura', kind: 'dark' },
  { id: 'tube', name: 'Tube Amp', kind: 'dark' },
  { id: 'ube', name: 'Ube', kind: 'dark' },
  { id: 'abyss', name: 'Abyss', kind: 'dark' },
  { id: 'oled', name: 'OLED', kind: 'dark' },
];

export const isTheme = (id) => THEMES.some(t => t.id === id);
export const themeKind = (id) => THEMES.find(t => t.id === id)?.kind || 'dark';
