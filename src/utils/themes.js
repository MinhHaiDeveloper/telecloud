import { t } from '../i18n';
// Every theme the app has. Their colours are CSS tokens: Dark and Vanilla in styles/tokens.css, the
// others in styles/themes.css. "kind" is what the sun and moon button in the top bar switches between.
export const THEMES = [
  { id: 'dark', get name() { return t('Dark'); }, kind: 'dark' },
  { id: 'light', get name() { return t('Vanilla'); }, kind: 'light' },
  { id: 'matcha', get name() { return t('Matcha'); }, kind: 'light' },
  { id: 'sakura', get name() { return t('Sakura'); }, kind: 'light' },
  { id: 'hojicha', get name() { return t('Hojicha'); }, kind: 'dark' },
  { id: 'yozakura', get name() { return t('Yozakura'); }, kind: 'dark' },
  { id: 'tube', get name() { return t('Tube Amp'); }, kind: 'dark' },
  { id: 'ube', get name() { return t('Ube'); }, kind: 'dark' },
  { id: 'abyss', get name() { return t('Abyss'); }, kind: 'dark' },
  { id: 'oled', name: 'OLED', kind: 'dark' },
];

export const isTheme = (id) => THEMES.some(t => t.id === id);
export const themeKind = (id) => THEMES.find(t => t.id === id)?.kind || 'dark';
