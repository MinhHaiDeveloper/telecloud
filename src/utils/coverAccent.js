// "Follow the cover": turn an album cover into an accent colour that stays readable on the theme.
// The first half is plain maths, so it can be tested without a window.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function rgbToHsl([r, g, b]) {
  const [x, y, z] = [r / 255, g / 255, b / 255];
  const max = Math.max(x, y, z);
  const min = Math.min(x, y, z);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === x) h = ((y - z) / d + 6) % 6;
  else if (max === y) h = (z - x) / d + 2;
  else h = (x - y) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb([h, s, l]) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map(v => Math.round((v + m) * 255));
}

export function parseHex(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}

const luminance = (rgb) => {
  const [r, g, b] = rgb.map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * The cover's main colour from RGBA pixels, or null when it hasn't got one (black and white, greys).
 * Colours vote by hue, and vivid ones count for more than a washed-out background.
 */
export function pickCoverColor(data) {
  const buckets = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  let coloured = 0;
  let total = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    total++;
    const rgb = [data[i], data[i + 1], data[i + 2]];
    const [h, s, l] = rgbToHsl(rgb);
    if (s < 0.2 || l < 0.1 || l > 0.93) continue;
    coloured++;
    const w = s * (1 - Math.abs(2 * l - 1));
    const b = buckets[Math.floor(h / 30) % 12];
    b.w += w;
    b.r += rgb[0] * w;
    b.g += rgb[1] * w;
    b.b += rgb[2] * w;
  }
  // a few coloured pixels on a grey cover are noise, not its colour
  if (!total || coloured / total < 0.05) return null;
  const top = buckets.reduce((a, b) => (b.w > a.w ? b : a));
  return [top.r / top.w, top.g / top.w, top.b / top.w].map(Math.round);
}

const css = (rgb) => `rgb(${rgb.join(', ')})`;

/**
 * The accent tokens for a colour on this theme. The hue stays; lightness moves away from the
 * background until accent-coloured text reads on both the page and the cards.
 */
export function accentTokens(color, bgApp, surface) {
  const dark = luminance(bgApp) < 0.2;
  const [h, s0, l0] = rgbToHsl(color);
  const s = clamp(s0, 0.45, 0.9);
  let l = clamp(l0, dark ? 0.5 : 0.25, dark ? 0.75 : 0.5);
  let rgb = hslToRgb([h, s, l]);
  const reads = (c) => contrast(c, bgApp) >= 4.5 && contrast(c, surface) >= 4.5;
  while (!reads(rgb) && l > 0.05 && l < 0.95) {
    l += dark ? 0.02 : -0.02;
    rgb = hslToRgb([h, s, l]);
  }
  const white = [255, 255, 255];
  const ink = [0, 0, 0]; // black or white always reaches 4.5 on one side; a softer dark doesn't
  return {
    '--accent': css(rgb),
    '--accent-2': css(hslToRgb([h, s, clamp(l + 0.08, 0, 0.92)])),
    '--accent-soft': `rgba(${rgb.join(', ')}, .15)`,
    '--on-accent': css(contrast(rgb, white) >= contrast(rgb, ink) ? white : ink),
  };
}

// ---------- the page side
const TOKENS = ['--accent', '--accent-2', '--accent-soft', '--on-accent'];
const seen = new Map();

export function clearCoverAccent() {
  const s = document.documentElement.style;
  TOKENS.forEach(t => s.removeProperty(t));
}

export function applyCoverAccent(color) {
  const root = document.documentElement;
  const look = getComputedStyle(root);
  const bg = parseHex(look.getPropertyValue('--bg-app'));
  const surface = parseHex(look.getPropertyValue('--surface'));
  if (!color || !bg || !surface) { clearCoverAccent(); return; }
  Object.entries(accentTokens(color, bg, surface)).forEach(([k, v]) => root.style.setProperty(k, v));
}

/** The main process shrinks the cover; drawing that small copy here gives the pixels. Null when there's no cover. */
export async function coverColor(path, revision) {
  const key = `${path}\u0000${revision || ''}`;
  if (seen.has(key)) return seen.get(key);
  const url = await window.ipcRenderer.invoke('cover:thumb', path);
  let color = null;
  if (url) {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    color = pickCoverColor(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  }
  if (seen.size > 500) seen.clear();
  seen.set(key, color);
  return color;
}
