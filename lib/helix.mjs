// Movies page: the poster helix. Every film hangs on one string (a darkroom drying line) that winds down a 3D helix,
// oldest at the top, newest at the bottom, so scrolling travels through time. The string and the year take the colour
// of the poster in front. Filters do not use this view: they switch the page to the ordinary poster grid.
// The page is redrawn several times while the library loads; a helix built right after another one carries on from the
// same film, and coming back from a detail page lands on the film that was opened.
const CARRY_MS = 6000;
let last = null;   // { key, at }

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const SHORT = { 'United States of America': 'USA', 'United Kingdom': 'UK' };

export function helixOrder(items, yearOf) {
  return items.map((it, i) => ({ it, i, y: parseInt(yearOf(it), 10) || 9999 }))
    .sort((a, b) => a.y - b.y || a.i - b.i).map(x => x.it);
}

export function initMovieHelix(viewport, items, { posterUrl, describe, onOpen }) {
  if (!viewport || !items.length) return { stop() {}, leave(done) { done?.(); } };
  const N = items.length;
  const facts = items.map(it => describe(it));
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  viewport.innerHTML = `<canvas class="hx-thread hx-back"></canvas><div class="hx-cards"></div><canvas class="hx-thread hx-front"></canvas>
    <div class="hx-counter" aria-hidden="true"><div class="hx-year"></div><div class="hx-index"></div></div>
    <div class="hx-caption" aria-live="polite"><div class="hx-title"></div><div class="hx-meta"></div></div>
    <div class="hx-ruler" aria-hidden="true"></div>`;
  const q = s => viewport.querySelector(s);
  const cardsEl = q('.hx-cards'), cvB = q('.hx-back'), cvF = q('.hx-front');
  const ctxB = cvB.getContext('2d'), ctxF = cvF.getContext('2d');
  const yearEl = q('.hx-year'), indexEl = q('.hx-index'), caption = q('.hx-caption'), titleEl = q('.hx-title'), metaEl = q('.hx-meta'), ruler = q('.hx-ruler');

  const tints = items.map(() => [255, 255, 255]);
  const cards = items.map((it, i) => {
    const el = document.createElement('div');
    el.className = 'hx-card';
    el.dataset.i = String(i);
    const url = posterUrl(it);
    if (url) {
      const img = new Image();
      img.crossOrigin = 'anonymous';   // TMDB sends CORS headers, so the poster colour can be read for the string
      img.decoding = 'async';
      img.draggable = false;
      img.alt = '';
      img.onload = () => { const t = posterTint(img); if (t) tints[i] = t; };
      img.onerror = () => { if (img.crossOrigin) { img.onerror = null; img.removeAttribute('crossorigin'); img.src = url; } };
      img.src = url;
      el.appendChild(img);
    } else {
      const span = document.createElement('span');
      span.className = 'hx-fallback';
      span.textContent = facts[i].title;
      el.appendChild(span);
    }
    cardsEl.appendChild(el);
    return el;
  });

  // ruler: one tick per film, a longer tick and a label where a decade starts
  const ticks = facts.map((f, i) => {
    const t = document.createElement('i');
    const top = (N > 1 ? i / (N - 1) : 0) * 100 + '%';
    t.style.top = top;
    const dec = Math.floor(f.year / 10) * 10;
    if (f.year && (i === 0 || Math.floor(facts[i - 1].year / 10) * 10 !== dec)) {
      t.className = 'dec';
      const b = document.createElement('b');
      b.textContent = dec + 's';
      b.style.top = top;
      ruler.appendChild(b);
    }
    ruler.appendChild(t);
    return t;
  });

  let C, W, H;
  function layout() {
    W = viewport.clientWidth || window.innerWidth; H = viewport.clientHeight || window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1), s = W < 700;
    C = { cw: s ? 92 : 138, ch: s ? 138 : 207, R: s ? Math.min(W * .42, 180) : Math.min(W * .3, 480), step: (s ? 38 : 30) * Math.PI / 180,
      pitch: s ? 56 : 78, tilt: -17 * Math.PI / 180, f: s ? 900 : 1400, vis: s ? 9 : 11, cy: s ? -10 : 0 };
    viewport.style.setProperty('--hx-cw', C.cw + 'px');
    viewport.style.setProperty('--hx-ch', C.ch + 'px');
    viewport.style.perspective = C.f + 'px';
    for (const c of [cvB, cvF]) { c.width = W * dpr; c.height = H * dpr; c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0); }
  }
  layout();
  window.addEventListener('resize', layout);

  // where to start: the film last looked at (or opened), else the oldest film at the top of the string
  const lastIdx = last ? items.findIndex(it => it.key === last.key) : -1;
  const carried = lastIdx >= 0 && performance.now() - last.at < CARRY_MS;
  let target = lastIdx >= 0 ? lastIdx : 0;
  let p = carried ? target : target - 4;            // a fresh helix winds in from a few films back
  let exit = carried || reduce ? 0 : 1, exitTarget = 0, leaving = null;
  let opened = false, lastInput = performance.now(), dragging = false, cur = -1, nextAuto = 0, pulse = 0, lt = performance.now(), raf = 0, stopped = false;
  const tint = [255, 255, 255];

  function point(s) {
    const rel = s - p, a = rel * C.step;
    const x = C.R * Math.sin(a), z0 = C.R * Math.cos(a) - C.R, y0 = rel * C.pitch;
    const ct = Math.cos(C.tilt), st = Math.sin(C.tilt);
    return { x, y: y0 * ct - z0 * st + C.cy, z: y0 * st + z0 * ct, a, rel, ct, st };
  }
  // where the string meets a poster: its top centre (after the focus zoom), plus a soft sag between two clips
  function hook(s) {
    const o = point(s), focus = Math.max(0, 1 - Math.abs(o.rel)), sc = 1 + .22 * focus;
    const h = C.ch / 2 * sc + 6, fr = s - Math.floor(s), sag = C.ch * .11 * Math.sin(Math.PI * fr);
    return { x: o.x, y: o.y - h * o.ct + sag + exit * 300, z: o.z + 90 * focus - h * o.st, rel: o.rel };
  }
  const proj = o => { const k = C.f / (C.f - o.z); return [W / 2 + o.x * k, H / 2 + o.y * k, k]; };
  const vis = rel => { const lim = rel < 0 ? C.vis - 3.5 : C.vis, a = Math.abs(rel); return a < lim - 3 ? 1 : Math.max(0, 1 - (a - (lim - 3)) / 3); };

  function setCurrent(i) {
    if (cur >= 0) { cards[cur].classList.remove('on'); ticks[cur].classList.remove('on'); }
    cur = i; cards[i].classList.add('on'); ticks[i].classList.add('on');
    const f = facts[i];
    yearEl.textContent = f.year || '';
    indexEl.textContent = `${String(i + 1).padStart(2, '0')} / ${N}`;
    caption.classList.add('swap');
    clearTimeout(setCurrent.t);
    setCurrent.t = setTimeout(() => {
      titleEl.textContent = f.title;
      metaEl.textContent = [f.year, f.genres.slice(0, 2).join(' · '), f.countries.slice(0, 2).map(c => SHORT[c] || c).join(' / '), f.rating ? '★ ' + f.rating : ''].filter(Boolean).join('   ');
      caption.classList.remove('swap');
    }, 140);
  }

  function frame(now) {
    if (stopped) return;
    const dt = Math.min(.05, (now - lt) / 1000); lt = now;
    if (document.documentElement.classList.contains('search-open')) { raf = requestAnimationFrame(frame); return; }   // hidden behind search: do no work
    if (!reduce && !dragging && !leaving && now - lastInput > 8000) {   // idle: walk forward one film at a time, then rewind
      if (!nextAuto) nextAuto = now;
      if (now >= nextAuto) { target = target >= N - 1 ? 0 : Math.round(target) + 1; nextAuto = now + 3200; }
    } else nextAuto = 0;
    if (!dragging && now - lastInput > 160) target = Math.round(target);
    const ease = reduce ? 1 : 1 - Math.exp(-dt * 8);
    p += (target - p) * ease; if (Math.abs(target - p) < .0005) p = target;
    exit += (exitTarget - exit) * (reduce ? 1 : 1 - Math.exp(-dt * 7));
    if (leaving && exit > .9) { const done = leaving; leaving = null; done(); }
    const ci = clamp(Math.round(p), 0, N - 1);
    if (!opened) last = { key: items[clamp(Math.round(target), 0, N - 1)].key, at: now };   // the film being travelled to, not one passed on the way
    if (ci !== cur) setCurrent(ci);
    const tt = tints[ci];
    for (let k = 0; k < 3; k++) tint[k] += (tt[k] - tint[k]) * (1 - Math.exp(-dt * 4));
    const tc = tint.map(Math.round).join(',');
    viewport.style.setProperty('--hx-tint', tc);

    for (let i = 0; i < N; i++) {
      const el = cards[i], o = point(i), v = vis(o.rel) * (1 - exit);
      if (v <= .001) { if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden'; continue; }
      if (el.style.visibility) el.style.visibility = '';   // inherit, so a hidden page (search overlay) hides the posters too
      const focus = Math.max(0, 1 - Math.abs(o.rel)), drop = exit * (260 + (i % 7) * 40);
      el.style.transform = `translate3d(${o.x.toFixed(1)}px,${(o.y + drop).toFixed(1)}px,${(o.z + 90 * focus).toFixed(1)}px) rotateX(${C.tilt}rad) rotateY(${(Math.sin(o.a) * .55).toFixed(4)}rad) scale(${(1 + .22 * focus).toFixed(3)})`;
      el.style.opacity = v.toFixed(3);
      el.style.setProperty('--hx-shade', Math.min(.82, (-o.z / (2 * C.R)) * .75 + Math.abs(o.rel) * .025).toFixed(3));
    }

    // the string: the far half is drawn behind the posters, the near half in front of them
    ctxB.clearRect(0, 0, W, H); ctxF.clearRect(0, 0, W, H);
    ctxB.lineCap = ctxF.lineCap = 'round';
    const s0 = Math.max(-.5, p - C.vis), s1 = Math.min(N - .5, p + C.vis);
    let prev = null;
    for (let s = s0; s <= s1 + 1e-6; s += .05) {
      const o = hook(s), P = proj(o);
      if (prev) {
        const depth = clamp(-o.z / (2 * C.R), 0, 1), a = vis(o.rel) * (1 - exit) * (1 - .72 * depth), c = depth > .42 ? ctxB : ctxF;
        c.strokeStyle = `rgba(${tc},${a.toFixed(3)})`; c.lineWidth = (1.9 - 1.1 * depth) * P[2];
        c.beginPath(); c.moveTo(prev[0], prev[1]); c.lineTo(P[0], P[1]); c.stroke();
      }
      prev = P;
    }
    for (let i = Math.max(0, Math.ceil(s0)); i <= Math.min(N - 1, Math.floor(s1)); i++) {   // clips
      const o = hook(i), P = proj(o), depth = clamp(-o.z / (2 * C.R), 0, 1), v = vis(o.rel) * (1 - exit);
      if (v <= 0) continue;
      const c = depth > .42 ? ctxB : ctxF, w = 5 * P[2], h = 12 * P[2];
      c.fillStyle = `rgba(${tc},${(v * (1 - .75 * depth)).toFixed(3)})`;
      c.beginPath(); if (c.roundRect) c.roundRect(P[0] - w / 2, P[1] - h * .35, w, h, 1.5 * P[2]); else c.rect(P[0] - w / 2, P[1] - h * .35, w, h); c.fill();
    }
    if (!reduce) {   // a small light runs along the string, forward in time
      pulse = (pulse + dt * .9) % 6;
      const ps = p + pulse - .5;
      if (ps > -.5 && ps < N - .5 && exit < .5) {
        const o = hook(ps), P = proj(o), depth = clamp(-o.z / (2 * C.R), 0, 1), a = (1 - pulse / 6) * (1 - depth * .7) * (1 - exit), r = 14 * P[2];
        const g = ctxF.createRadialGradient(P[0], P[1], 0, P[0], P[1], r);
        g.addColorStop(0, `rgba(${tc},${a})`); g.addColorStop(1, `rgba(${tc},0)`);
        ctxF.fillStyle = g; ctxF.beginPath(); ctxF.arc(P[0], P[1], r, 0, 7); ctxF.fill();
      }
    }
    ctxF.font = '500 10px ui-monospace,"SF Mono",Menlo,monospace'; ctxF.textAlign = 'left';
    for (let i = 0; i < N; i++) {   // decade marks on the string
      const y = facts[i].year; if (!y || (i > 0 && Math.floor(facts[i - 1].year / 10) === Math.floor(y / 10))) continue;
      const o = hook(i - .5), v = vis(o.rel) * (1 - exit); if (v <= 0) continue;
      const P = proj(o), depth = clamp(-o.z / (2 * C.R), 0, 1);
      ctxF.fillStyle = `rgba(${tc},${(v * (1 - depth * .8)).toFixed(3)})`;
      ctxF.beginPath(); ctxF.arc(P[0], P[1], 2.5 * P[2], 0, 7); ctxF.fill();
      ctxF.fillText(Math.floor(y / 10) * 10 + 's', P[0] + 8, P[1] - 10);
    }
    raf = requestAnimationFrame(frame);
  }

  // ---------- input ----------
  const poke = () => { lastInput = performance.now(); };
  const onWheel = e => {
    if (leaving || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    target = clamp(target + clamp(d, -80, 80) * .0075, 0, N - 1); poke();
  };
  let ds = null;
  const onDown = e => {
    if (leaving || e.button > 0 || e.target.closest?.('.hx-ruler')) return;
    ds = { x: e.clientX, y: e.clientY, t: target, moved: 0, ly: e.clientY, lt: performance.now(), v: 0 };
    dragging = true; viewport.classList.add('dragging'); poke();
  };
  const onMove = e => {
    if (!ds) return;
    const dx = e.clientX - ds.x, dy = e.clientY - ds.y, now = performance.now();
    ds.moved = Math.max(ds.moved, Math.hypot(dx, dy));
    target = clamp(ds.t - (dy + dx * .6) / (C.pitch * 1.6), 0, N - 1);
    ds.v = (e.clientY - ds.ly) / Math.max(1, now - ds.lt); ds.ly = e.clientY; ds.lt = now; poke();
  };
  const onUp = e => {
    if (!ds) return;
    dragging = false; viewport.classList.remove('dragging');
    if (ds.moved < 8) {
      const el = e.target.closest?.('.hx-card');
      if (el) { const i = Number(el.dataset.i); if (i === cur && Math.abs(p - cur) < .25) open(i); else target = i; }
    } else target = clamp(target - ds.v * 6, 0, N - 1);   // fling
    ds = null; poke();
  };
  function open(i) { opened = true; last = { key: items[i].key, at: 0 }; onOpen?.(items[i].key); }
  const typing = t => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  const onKey = e => {
    if (leaving || e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || !viewport.isConnected) return;
    if (document.querySelector('#player:not([hidden]), #search:not([hidden]), [data-movie-sheet]:not([hidden])')) return;
    if (['ArrowDown', 'ArrowRight'].includes(e.key)) target = clamp(Math.round(target) + 1, 0, N - 1);
    else if (['ArrowUp', 'ArrowLeft'].includes(e.key)) target = clamp(Math.round(target) - 1, 0, N - 1);
    else if (e.key === 'Home') target = 0; else if (e.key === 'End') target = N - 1;
    else if (e.key === 'Enter' && !e.target.closest?.('button,a')) open(cur);
    else return;
    e.preventDefault(); poke();
  };
  let rd = false;
  const rpick = e => { const r = ruler.getBoundingClientRect(); target = clamp(Math.round((e.clientY - r.top) / r.height * (N - 1)), 0, N - 1); poke(); };
  const onRDown = e => { rd = true; ruler.setPointerCapture?.(e.pointerId); rpick(e); };
  const onRMove = e => { if (rd) rpick(e); };
  const onRUp = () => { rd = false; };

  viewport.addEventListener('wheel', onWheel, { passive: false });
  viewport.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  window.addEventListener('keydown', onKey);
  ruler.addEventListener('pointerdown', onRDown);
  ruler.addEventListener('pointermove', onRMove);
  ruler.addEventListener('pointerup', onRUp);

  setCurrent(clamp(Math.round(p), 0, N - 1));
  raf = requestAnimationFrame(frame);

  return {
    // posters fall away before the page switches to the grid (a filter was chosen)
    leave(done) { if (stopped || reduce) { done?.(); return; } exitTarget = 1; leaving = done || (() => {}); },
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      clearTimeout(setCurrent.t);
      window.removeEventListener('resize', layout);
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey);
      if (last && !opened) last.at = performance.now();
      viewport.replaceChildren();
    },
  };
}

// The poster's main colour, brightened so a thin line in that colour still reads on pure black.
function posterTint(img) {
  try {
    const c = document.createElement('canvas'); c.width = c.height = 12;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0, 12, 12);
    const d = x.getImageData(0, 0, 12, 12).data;
    let r = 0, g = 0, b = 0, w = 0;
    for (let k = 0; k < d.length; k += 4) {
      const s = Math.max(d[k], d[k + 1], d[k + 2]) - Math.min(d[k], d[k + 1], d[k + 2]) + 12;   // favour saturated pixels
      r += d[k] * s; g += d[k + 1] * s; b += d[k + 2] * s; w += s;
    }
    r /= w; g /= w; b /= w;
    const L = 215 / (Math.max(r, g, b) || 1);
    return [r, g, b].map(v => Math.round(Math.min(255, v * L * .75 + 255 * .25)));
  } catch { return null; }
}
