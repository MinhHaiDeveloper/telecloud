// What the liquid cover change and the fluid backdrop share: the pictures as GPU-ready bitmaps, one clock
// for each change (so a cover that shows up mid-way, like Now Playing opened during it, joins at the same
// point), and a small WebGL helper. WebGL draws every pixel of the ripple on the graphics card, so a big
// cover costs about as little as a small one.

export const DURATION = 5000; // slow, like paint running into water

export const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const motionOff = () => document.documentElement.classList.contains('reduce-motion')
  || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ---------- pictures
// media:// pictures can't be textures (the page can't read their pixels), so their bytes come over IPC
const bitmaps = new Map(); // url -> Promise<ImageBitmap>
const decoded = new Map(); // url -> ImageBitmap, once ready: a change can start without waiting at all
export const bitmapNow = (url) => decoded.get(url) || null;
const MAX_SIDE = 1024;
export function bitmapFor(url) {
  if (!url) return Promise.reject(new Error('No picture'));
  const had = bitmaps.get(url);
  if (had) { bitmaps.delete(url); bitmaps.set(url, had); return had; } // most recent last
  const job = (async () => {
    let blob;
    if (url.startsWith('media://')) {
      const r = await window.ipcRenderer.invoke('media:bytes', url);
      if (!r?.data) throw new Error('No picture');
      blob = new Blob([r.data], { type: r.type || 'image/jpeg' });
    } else {
      blob = await (await fetch(url)).blob();
    }
    const full = await createImageBitmap(blob);
    const k = MAX_SIDE / Math.max(full.width, full.height);
    if (k >= 1) return full;
    const small = await createImageBitmap(blob, { resizeWidth: Math.round(full.width * k), resizeHeight: Math.round(full.height * k), resizeQuality: 'high' });
    full.close();
    return small;
  })();
  bitmaps.set(url, job);
  job.then((b) => { if (bitmaps.get(url) === job) decoded.set(url, b); }, () => { if (bitmaps.get(url) === job) bitmaps.delete(url); });
  while (bitmaps.size > 8) {
    const [old, p] = bitmaps.entries().next().value;
    bitmaps.delete(old);
    decoded.delete(old);
    p.then(b => setTimeout(() => b.close?.(), DURATION + 500)).catch(() => {}); // not while a change may still draw it
  }
  return job;
}
/** Read the picture ahead, when the computer has a moment, so the next change starts at once */
export function warm(url) {
  if (!url || bitmaps.has(url)) return;
  const go = () => bitmapFor(url).catch(() => {});
  if (window.requestIdleCallback) window.requestIdleCallback(go, { timeout: 2000 }); else setTimeout(go, 300);
}

// ---------- one clock per change
const changes = new Map(); // to-url -> { from, to, start }
export function beginChange(from, to) {
  const now = performance.now();
  let c = changes.get(to);
  if (!c || c.from !== from || now - c.start > DURATION) { c = { from, to, start: now, id: Math.random() }; changes.set(to, c); }
  for (const [k, v] of changes) if (now - v.start > DURATION * 2) changes.delete(k);
  return c;
}
/** The change still running towards this picture, if any */
export function runningChange(to) {
  const c = changes.get(to);
  return c && performance.now() - c.start < DURATION - 100 ? c : null;
}
/** The newest change still running, whatever it goes to */
export function latestChange() {
  let best = null;
  for (const c of changes.values()) if (performance.now() - c.start < DURATION - 100 && (!best || c.start > best.start)) best = c;
  return best;
}

// ---------- canvases made ready ahead
// Making a WebGL canvas and compiling its shader takes 20 to 60 ms. Done when the change starts, for the
// side panel, the player bar and Now Playing at once, that was a visible hitch. So a few are made ahead,
// one at a time when the computer has a moment, and each change borrows one and gives it back.
const pool = [];
const POOL_MAX = 5;
function makeCanvas() {
  const c = document.createElement('canvas');
  c.className = 'liquid-canvas';
  c.setAttribute('aria-hidden', 'true');
  try { c.__g = makeGL(c, COVER_FRAG); } catch (err) { console.warn('[Liquid] WebGL:', err.message); c.__g = null; }
  return c.__g ? c : null;
}
let warming = false;
/** Get a few canvases ready, one per idle moment */
export function warmCanvases(n = 4) {
  if (warming || pool.length >= n) return;
  warming = true;
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 200));
  const one = () => {
    if (backdrop === undefined) { backdropCanvas(); idle(one, { timeout: 3000 }); return; }
    if (pool.length >= n) { warming = false; return; }
    const c = makeCanvas();
    if (!c) { warming = false; return; } // no WebGL here
    pool.push(c);
    idle(one, { timeout: 3000 });
  };
  idle(one, { timeout: 3000 });
}
const borrow = () => pool.pop() || makeCanvas();

// The backdrop's canvas, made once ahead and kept: Now Playing opens without compiling anything
let backdrop;
export function backdropCanvas() {
  if (backdrop !== undefined) return backdrop;
  const c = document.createElement('canvas');
  c.className = 'np-fluid';
  c.setAttribute('aria-hidden', 'true');
  try { c.__g = makeGL(c, BACKDROP_FRAG); } catch (err) { console.warn('[Backdrop] WebGL:', err.message); c.__g = null; }
  backdrop = c.__g ? c : null;
  return backdrop;
}
function giveBack(c) {
  c.remove();
  delete c.dataset.t;
  if (pool.length < POOL_MAX) pool.push(c); else c.__g.destroy();
}

/**
 * Draw a cover change inside `host` until it ends, on the change's own clock. Calls onDone when it has
 * finished, or at once if it can't be drawn (no WebGL, a picture that won't load). Returns a stop function.
 */
export function playCoverChange(host, change, onDone = () => {}) {
  let raf = 0;
  let dead = false;
  let el = null;
  const finish = () => { if (!dead) { dead = true; if (el) giveBack(el); el = null; onDone(); } };
  const start = ([a, b]) => {
    if (dead || !host.isConnected) return;
    el = borrow();
    if (!el) { finish(); return; } // no WebGL: the new cover just shows
    const g = el.__g;
    host.appendChild(el);
    g.texture(0, a, 'uA');
    g.texture(1, b, 'uB');
    const seed = change.id * 10;
    let W = 0, H = 0;
    const frame = (now) => {
      if (dead) return;
      const t = Math.max(0, Math.min(1, (now - change.start) / DURATION));
      el.dataset.t = t.toFixed(2); // how far along, for a look from outside
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(el.clientWidth * dpr)), h = Math.max(1, Math.round(el.clientHeight * dpr));
      if (w !== W || h !== H) { // set once, again only if the box changes size
        W = w; H = h; g.size(W, H);
        g.set2('uSA', ...fitScale(a, W, H)); g.set2('uSB', ...fitScale(b, W, H)); g.set1('uAspect', W / H); g.set1('uSeed', seed);
      }
      g.set1('uP', ease(t));
      g.set1('uSwell', Math.sin(Math.PI * t)); // the ripples grow, then settle
      g.set1('uTime', (now - change.start) / 1000);
      g.draw();
      if (t < 1) raf = requestAnimationFrame(frame);
      else finish();
    };
    frame(performance.now()); // the first frame at once, so nothing flashes before it
  };
  const a0 = bitmapNow(change.from), b0 = bitmapNow(change.to);
  if (a0 && b0) start([a0, b0]); // both ready: drawn before the page is even shown
  else {
    // still being read: the old cover stands in, so the new one never shows before the change does
    host.style.background = `center / cover no-repeat url("${String(change.from).replace(/"/g, '%22')}")`;
    Promise.all([bitmapFor(change.from), bitmapFor(change.to)]).then(start).catch(finish);
  }
  return () => { cancelAnimationFrame(raf); if (!dead) { dead = true; if (el) giveBack(el); el = null; } };
}

// ---------- WebGL
const VERT = `attribute vec2 aPos; varying vec2 vUv;
void main() { vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }`;

/** A canvas that draws one fragment shader over itself. Null when WebGL isn't there. */
export function makeGL(canvas, frag) {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power' });
  if (!gl) return null;
  const shader = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // one triangle over everything
  const loc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uniforms = {};
  const u = (name) => (name in uniforms ? uniforms[name] : (uniforms[name] = gl.getUniformLocation(prog, name)));
  const textures = [];
  return {
    gl,
    set1: (n, v) => gl.uniform1f(u(n), v),
    set2: (n, a, b) => gl.uniform2f(u(n), a, b),
    /** Put a picture in texture unit `unit` (0 or 1) */
    texture(unit, bitmap, name) {
      let t = textures[unit];
      if (!t) {
        t = textures[unit] = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.uniform1i(u(name), unit);
      }
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    },
    size(w, h) { if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; } gl.viewport(0, 0, w, h); },
    draw() { gl.drawArrays(gl.TRIANGLES, 0, 3); },
    destroy() { try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* gone */ } },
  };
}

/** How much of a picture fills a box the way object-fit: cover does, as a scale for its coordinates */
export const fitScale = (bitmap, w, h) => {
  const ia = bitmap.width / bitmap.height, ba = w / h;
  return ia > ba ? [ba / ia, 1] : [1, ia / ba];
};

// ---------- the cover change
// The new picture floods in from beyond the left edge as a growing circle with a wobbling rim. Rings run
// outward across the rim and bend both pictures; just ahead of it the old one is pulled along, and the
// colours split a little (red one way, blue the other), most at the rim. All of it grows, then settles.
export const COVER_FRAG = `precision highp float;
varying vec2 vUv;
uniform sampler2D uA; uniform sampler2D uB;
uniform vec2 uSA; uniform vec2 uSB;
uniform float uP; uniform float uSwell; uniform float uTime; uniform float uSeed; uniform float uAspect;
vec3 pick(sampler2D t, vec2 s, vec2 uv) { return texture2D(t, (uv - 0.5) * s + 0.5).rgb; }
vec3 split(sampler2D t, vec2 s, vec2 uv, vec2 off) {
  return vec3(pick(t, s, uv + off).r, pick(t, s, uv).g, pick(t, s, uv - off).b);
}
void main() {
  vec2 uv = vUv;
  float zoom = 1.0 + 0.05 * uSwell;              // a touch closer while it ripples, so no edge shows
  uv = (uv - 0.5) / zoom + 0.5;
  vec2 o = vec2(-0.42, 0.5 + 0.14 * sin(uSeed));  // where the flood comes from
  vec2 q = uv - o; q.x *= uAspect;
  float d = length(q);
  vec2 dir = q / max(d, 1e-4); dir.x /= uAspect;
  float ang = atan(q.y, q.x);
  float R = mix(0.3, 1.62, uP)
    + uSwell * (0.035 * sin(ang * 6.0 + uSeed + uTime * 1.7) + 0.016 * sin(ang * 15.0 - uTime * 2.6));
  float e = d - R;                                  // below 0: the new picture
  float near = exp(-abs(e) * 7.0);
  float wave = sin(e * 46.0 - uTime * 7.0);
  float trail = e < 0.0 ? exp(e * 3.2) : 0.0;       // rings left behind the rim, fading
  float ahead = e > 0.0 ? exp(-e * 2.5) : 0.0;       // and the swell that runs ahead of it, over the old one
  float push = uSwell * 0.016 * wave * (near + 0.7 * trail + 0.45 * ahead);
  float pull = e > 0.0 ? uSwell * 0.085 * exp(-e * 9.0) : 0.0;
  vec2 off = dir * uSwell * (0.006 + 0.02 * near);
  vec3 A = split(uA, uSA, uv - dir * pull + dir * push * 0.6, off);
  vec3 B = split(uB, uSB, uv + dir * push, off);
  vec3 c = mix(A, B, smoothstep(0.014, -0.014, e));
  c += uSwell * (0.2 * exp(-abs(e) * 70.0) + 0.05 * wave * (near + 0.5 * trail));
  gl_FragColor = vec4(c, 1.0);
}`;

// ---------- the backdrop behind Now Playing
// The cover, close up and slowly stirred, so its colours drift like ink in water. Its colours are lifted:
// a dark cover gives its own hues, brighter, not a black screen. On a change of album the middle swirls,
// bright rings spread from the cover across the screen, and the new colours follow them in a wide, soft
// front.
export const BACKDROP_FRAG = `precision mediump float;
varying vec2 vUv;
uniform sampler2D uA; uniform sampler2D uB;
uniform vec2 uSA; uniform vec2 uSB;
uniform float uP; uniform float uSwell; uniform float uTime; uniform float uAspect;
uniform vec2 uCenter;
vec2 stir(vec2 uv, float t) {
  uv = (uv - 0.5) * 0.85 + 0.5;
  uv += 0.08 * vec2(sin(uv.y * 4.0 + t * 0.21), sin(uv.x * 3.5 - t * 0.17));
  uv += 0.045 * vec2(sin((uv.x + uv.y) * 6.0 + t * 0.13), cos((uv.x - uv.y) * 5.0 - t * 0.19));
  return uv;
}
vec3 pick(sampler2D t, vec2 s, vec2 uv) { return texture2D(t, (uv - 0.5) * s + 0.5).rgb; }
vec3 lift(vec3 c) {
  float hi = max(max(c.r, c.g), c.b);
  float lo = min(min(c.r, c.g), c.b);
  vec3 grey = vec3(dot(c, vec3(0.299, 0.587, 0.114)));
  c = mix(grey, c, 1.35);                                       // a little more colour
  float k = clamp(0.62 / max(hi, 0.001), 1.0, 1.0 + 2.2 * clamp((hi - lo) * 6.0, 0.0, 1.0)); // brighter, only where there is a hue
  return clamp(c * k, 0.0, 1.0);
}
void main() {
  vec2 q = vUv - uCenter; q.x *= uAspect;
  float d = length(q);
  vec2 dir = q / max(d, 1e-4); dir.x /= uAspect;
  float a = uSwell * 2.0 * exp(-d * 1.5);            // the swirl, strongest at the cover
  float cs = cos(a), sn = sin(a);
  vec2 r = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs); r.x /= uAspect;
  vec2 uv = uCenter + r;
  float R = mix(-0.3, 1.6, uP);
  float e = d - R;
  float ring = sin(d * 22.0 - uTime * 4.5);
  float band = exp(-abs(e) * 1.6);
  uv += dir * uSwell * 0.06 * ring * band;
  vec2 f = stir(uv, uTime);
  vec3 b = lift(pick(uB, uSB, f));
  vec3 c = mix(lift(pick(uA, uSA, f)), b, smoothstep(0.35, -0.35, e));
  c += uSwell * band * max(ring, 0.0) * 0.28 * (0.35 + b);  // light on the crests, in the new colours
  gl_FragColor = vec4(c, 1.0);
}`;
