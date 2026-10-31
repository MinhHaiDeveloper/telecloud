// TeleCloud showcase: scroll-linked stories, reveals and a live EQ curve. No dependencies.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const small = () => innerWidth <= 900;
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

  // ---- reveal on scroll (the app's riseIn)
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: .15, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));

  // ---- scroll-linked sections
  const root = document.documentElement;
  const nav = document.querySelector('.nav');
  const heroShot = document.querySelector('.hero-shot');
  const stories = [...document.querySelectorAll('.story')];
  const gallery = document.querySelector('.gallery');
  const track = gallery.querySelector('.gallery-track');
  const links = [...document.querySelectorAll('.nav-links a')];
  const sections = links.map(a => document.querySelector(a.getAttribute('href')));

  const setStep = (story, step) => {
    if (story.dataset.step === String(step)) return;
    story.dataset.step = step;
    story.querySelectorAll('.sp-steps li').forEach(li => li.classList.toggle('lit', Number(li.dataset.i) <= step));
  };

  const measureGallery = () => {
    const shift = Math.max(0, track.scrollWidth - innerWidth);
    gallery.style.setProperty('--shift', `${shift}px`);
  };

  let ticking = false;
  const update = () => {
    ticking = false;
    const vh = innerHeight;
    root.style.setProperty('--page', clamp(scrollY / (root.scrollHeight - vh)));
    nav.classList.toggle('scrolled', scrollY > 20);

    const hr = heroShot.getBoundingClientRect();
    heroShot.style.setProperty('--p', reduce ? 1 : clamp((vh - hr.top) / (vh * .75)));

    if (!small()) {
      stories.forEach(s => {
        const r = s.getBoundingClientRect();
        const p = clamp(-r.top / (r.height - vh));
        const n = Number(s.dataset.steps);
        setStep(s, Math.min(n - 1, Math.floor(p * n * 1.0001)));
      });
      const gr = gallery.getBoundingClientRect();
      gallery.style.setProperty('--p', clamp(-gr.top / (gr.height - vh)));
    }

    let current = -1;
    sections.forEach((sec, i) => { if (sec && sec.getBoundingClientRect().top < vh * .45) current = i; });
    links.forEach((a, i) => a.classList.toggle('on', i === current));
  };
  const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } };
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', () => { measureGallery(); onScroll(); });
  addEventListener('load', () => { measureGallery(); update(); });
  measureGallery();
  stories.forEach(s => setStep(s, 0));
  update();

  // On phones the stories are not sticky: play their steps on a timer while they are on screen
  const timers = new Map();
  const playIo = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      const s = e.target;
      clearInterval(timers.get(s));
      if (!small() || !e.isIntersecting || reduce) { if (small() && reduce) setStep(s, Number(s.dataset.steps) - 1); return; }
      let i = 0;
      setStep(s, 0);
      timers.set(s, setInterval(() => { i = (i + 1) % Number(s.dataset.steps); setStep(s, i); }, 2200));
    });
  }, { threshold: .4 });
  stories.forEach(s => playIo.observe(s));

  // ---- download buttons: newest pre-release (Beta) and newest release (Release) from GitHub
  const REPO = 'MinhHaiDeveloper/telecloud';
  const fmtSize = (b) => `${Math.round(b / 1048576)} MB`;
  const fmtDate = (d) => new Date(d).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
  const fillCard = (card, rel) => {
    const btn = card.querySelector('.dl-btn');
    const meta = card.querySelector('.dl-meta');
    const exe = rel && rel.assets.find(a => /\.exe$/i.test(a.name));
    if (!exe) return;
    const v = rel.tag_name.replace(/^v/, '');
    btn.href = exe.browser_download_url;
    btn.removeAttribute('aria-disabled');
    btn.textContent = `Download v${v}`;
    meta.innerHTML = '';
    meta.append(`${fmtSize(exe.size)} · ${fmtDate(rel.published_at)} · `);
    const notes = Object.assign(document.createElement('a'), { href: rel.html_url, textContent: 'Release notes', target: '_blank', rel: 'noopener' });
    meta.append(notes);
  };
  fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, { headers: { Accept: 'application/vnd.github+json' } })
    .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
    .then(list => {
      const live = list.filter(r => !r.draft && r.assets.some(a => /\.exe$/i.test(a.name)));
      fillCard(document.querySelector('[data-channel="beta"]'), live.find(r => r.prerelease));
      fillCard(document.querySelector('[data-channel="release"]'), live.find(r => !r.prerelease));
    })
    .catch(() => {
      // GitHub unreachable or rate-limited: send people to the Releases page instead of a dead button
      document.querySelectorAll('.dl-btn').forEach(btn => {
        btn.href = `https://github.com/${REPO}/releases`;
        btn.removeAttribute('aria-disabled');
        btn.textContent = 'See releases on GitHub';
      });
    });

  // ---- live EQ: peaking filters you can drag, drawn with the same RBJ maths the app uses
  const svg = document.getElementById('eq-svg');
  const W = 640, H = 300, L = 34, R = 10, T = 12, B = 26;
  const FMIN = 20, FMAX = 20000, DB = 12, FS = 48000;
  const x = f => L + (Math.log10(f / FMIN) / Math.log10(FMAX / FMIN)) * (W - L - R);
  const fx = px => FMIN * Math.pow(FMAX / FMIN, (px - L) / (W - L - R));
  const y = g => T + (1 - (g + DB) / (2 * DB)) * (H - T - B);
  const gy = py => (1 - (py - T) / (H - T - B)) * 2 * DB - DB;
  const NS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs, parent) => { const n = document.createElementNS(NS, name); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); parent && parent.appendChild(n); return n; };

  const defs = el('defs', {}, svg);
  const lg = el('linearGradient', { id: 'eqfill', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  el('stop', { offset: 0, 'stop-color': '#ff6a3d', 'stop-opacity': .28 }, lg);
  el('stop', { offset: 1, 'stop-color': '#ff6a3d', 'stop-opacity': 0 }, lg);
  svg.insertBefore(defs, svg.firstChild);

  const grid = svg.querySelector('.eq-grid');
  [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].forEach(f => {
    el('line', { x1: x(f), x2: x(f), y1: T, y2: H - B }, grid);
    el('text', { x: x(f), y: H - 8, 'text-anchor': 'middle' }, grid).textContent = f >= 1000 ? `${f / 1000}k` : f;
  });
  [-12, -6, 0, 6, 12].forEach(g => {
    el('line', { x1: L, x2: W - R, y1: y(g), y2: y(g), class: g === 0 ? 'zero' : '' }, grid);
    el('text', { x: L - 6, y: y(g) + 3, 'text-anchor': 'end' }, grid).textContent = g > 0 ? `+${g}` : g;
  });

  const bands = [
    { f: 32, g: 3.2, q: .9 }, { f: 64, g: 4.4, q: 1 }, { f: 125, g: 2.4, q: 1.1 }, { f: 250, g: -.6, q: 1.2 }, { f: 500, g: -1.2, q: 1.2 },
    { f: 1000, g: 0, q: 1.2 }, { f: 2000, g: -.8, q: 1.4 }, { f: 3500, g: -2.8, q: 2 }, { f: 8000, g: 1.6, q: 1.2 }, { f: 14000, g: 2.4, q: .9 },
  ];
  const peak = ({ f, g, q }, at) => {
    const A = Math.pow(10, g / 40), w0 = 2 * Math.PI * f / FS, al = Math.sin(w0) / (2 * q), c = Math.cos(w0);
    const b0 = 1 + al * A, b1 = -2 * c, b2 = 1 - al * A, a0 = 1 + al / A, a1 = -2 * c, a2 = 1 - al / A;
    const w = 2 * Math.PI * at / FS, cw = Math.cos(w), c2 = Math.cos(2 * w), sw = Math.sin(w), s2 = Math.sin(2 * w);
    const nr = b0 + b1 * cw + b2 * c2, ni = -(b1 * sw + b2 * s2), dr = a0 + a1 * cw + a2 * c2, di = -(a1 * sw + a2 * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  };
  const response = (at) => bands.reduce((s, b) => s + peak(b, at), 0);

  const line = svg.querySelector('.eq-line');
  const fill = svg.querySelector('.eq-fill');
  const dotsG = svg.querySelector('.eq-dots');
  const pre = document.getElementById('eq-pre');
  const dots = bands.map(() => el('circle', { r: 6 }, dotsG));
  const draw = () => {
    let d = '', maxG = 0;
    for (let i = 0; i <= 240; i++) {
      const f = FMIN * Math.pow(FMAX / FMIN, i / 240);
      const g = clamp(response(f), -DB, DB);
      maxG = Math.max(maxG, g);
      d += `${i ? 'L' : 'M'}${x(f).toFixed(1)} ${y(g).toFixed(1)}`;
    }
    line.setAttribute('d', d);
    fill.setAttribute('d', `${d}L${x(FMAX)} ${y(0)}L${x(FMIN)} ${y(0)}Z`);
    bands.forEach((b, i) => { dots[i].setAttribute('cx', x(b.f)); dots[i].setAttribute('cy', y(clamp(response(b.f), -DB, DB))); });
    pre.textContent = `preamp −${maxG.toFixed(1)} dB`;
  };
  draw();

  // drag: move a band in gain (and a little in frequency), live
  let drag = null;
  const toSvg = (e) => { const r = svg.getBoundingClientRect(); return { px: (e.clientX - r.left) * W / r.width, py: (e.clientY - r.top) * H / r.height }; };
  dots.forEach((dot, i) => dot.addEventListener('pointerdown', (e) => {
    drag = { i, lo: i ? bands[i - 1].f * 1.15 : FMIN, hi: i < bands.length - 1 ? bands[i + 1].f / 1.15 : FMAX };
    dot.classList.add('drag'); svg.setPointerCapture(e.pointerId); e.preventDefault();
  }));
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const { px, py } = toSvg(e);
    const b = bands[drag.i];
    b.g = clamp(gy(py), -10, 10);
    b.f = clamp(fx(px), drag.lo, drag.hi);
    draw();
  });
  const end = () => { if (drag) dots[drag.i].classList.remove('drag'); drag = null; };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);

  // a gentle "breathing" demo until someone touches it
  if (!reduce) {
    const base = bands.map(b => b.g);
    let touched = false, t0 = performance.now();
    svg.addEventListener('pointerdown', () => { touched = true; }, { once: true });
    const vis = new IntersectionObserver(([e]) => { svg.dataset.vis = e.isIntersecting ? '1' : ''; });
    vis.observe(svg);
    const loop = (t) => {
      if (touched) return;
      if (svg.dataset.vis) {
        const k = (t - t0) / 1000;
        bands.forEach((b, i) => { b.g = base[i] + Math.sin(k * 1.1 + i * .7) * 1.1; });
        draw();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
})();
