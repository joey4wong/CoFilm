// 3D poster ring (adapted from Croissante galaxy cards) for the Movies page.
// The page is redrawn several times while the library loads, and each redraw rebuilds the ring. Without this the deal started
// over every time (forward, back, forward). A ring built right after another one stopped carries on from its motion.
const CARRY_MS = 6000;
let carry = null, forceFresh = false;
export function restartMovieGalaxy() { forceFresh = true; }

export function initMovieGalaxy(viewport, items, { posterUrl, onOpen }) {
  const ring = viewport.querySelector('.galaxy-ring');
  if (!ring || !items.length) return { stop() {} };

  const COUNT = items.length;
  const RADIUS = 200;
  const SPEED = 52;
  const PILE_ANGLE = Math.PI * 0.65;
  const DEAL_DURATION = 1.4;
  const DEAL_STAGGER = 0.028;
  const COMPRESSED_STEPS = 3.0;
  const COMPRESSED_POWER = 0.82;
  const DEPTH_Z_SWITCH = 0.42;
  const DUST_COUNT = 9;
  const DUST_CYCLE = 6000;
  const CLICK_DRAG = 10;

  let tiltX = -19.5;
  let tiltZ = 24;
  let orbitOffset = 0;
  let startTime = null;
  let animReady = false;
  let isDragging = false;
  let dragMoved = false;
  let lastX = null;
  let lastY = null;
  let galaxyScale = (viewport.clientWidth || 1000) < 560 ? Math.max(0.62, (viewport.clientWidth || 400) / 560) : 1.15;   // phones: fit the ring on screen
  let raf = 0;
  let stopped = false;

  const cardEls = items.map((it, i) => {
    const el = document.createElement('div');
    el.className = 'g-card';
    el.dataset.galaxyKey = it.key;
    el.style.zIndex = String(COUNT - i);
    const url = posterUrl(it);
    if (url) {
      const img = document.createElement('img');
      img.className = 'g-card-poster';
      img.src = url;
      img.alt = '';
      img.draggable = false;
      el.appendChild(img);
    } else {
      const span = document.createElement('span');
      span.className = 'g-card-fallback';
      span.textContent = (it.meta?.name || it.parsed?.title || '?').slice(0, 12);
      el.appendChild(span);
    }
    let downX = 0;
    let downY = 0;
    let cardDrag = false;
    el.addEventListener('pointerdown', e => {
      downX = e.clientX;
      downY = e.clientY;
      cardDrag = false;
    });
    el.addEventListener('pointerup', e => {
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      if (Math.hypot(dx, dy) > CLICK_DRAG) cardDrag = true;
      if (!cardDrag && !dragMoved) {   // pointerup comes before mouseup: isDragging is still true here, so it must not be checked
        e.preventDefault();
        onOpen?.(it.key);
      }
    });
    ring.appendChild(el);
    return el;
  });

  const dustEls = Array.from({ length: DUST_COUNT }, () => {
    const el = document.createElement('div');
    el.className = 'g-dust';
    ring.appendChild(el);
    return el;
  });

  const smoothStep = t => {
    t = Math.min(1, Math.max(0, t));
    return t * t * (3 - 2 * t);
  };
  const lerp = (a, b, t) => a + (b - a) * t;

  function frame(now) {
    if (stopped) return;
    if (!animReady) { raf = requestAnimationFrame(frame); return; }
    if (!startTime) startTime = now;
    const elapsed = (now - startTime) / 1000;
    const dt = frame._last ? Math.min((now - frame._last) / 1000, 0.05) : 0;
    frame._last = now;

    if (!isDragging) orbitOffset -= SPEED * dt;
    ring.style.transform = `scale(${galaxyScale}) rotateX(${tiltX}deg) rotateZ(${tiltZ}deg)`;

    const orbitStep = 2 * Math.PI / COUNT;
    const orbitRad = orbitOffset * Math.PI / 180;
    const dealProgress = Math.min(1, Math.max(0, elapsed / DEAL_DURATION));
    const compressedSpan = COMPRESSED_STEPS * orbitStep;
    const maxSlot = Math.max(COUNT - 1, 1);

    for (let i = 0; i < COUNT; i++) {
      const releaseRank = i;
      const orbitRank = i;
      const slotFraction = i / maxSlot;
      const localDelay = (releaseRank * DEAL_STAGGER) / DEAL_DURATION;
      const rawLocal = Math.min(1, Math.max(0, (dealProgress - localDelay) / Math.max(1 - localDelay, 0.001)));
      const openProgress = smoothStep(rawLocal);
      const compressedOffset = -(compressedSpan / 2 - Math.pow(slotFraction, COMPRESSED_POWER) * compressedSpan);
      const finalOffset = -orbitRank * orbitStep;
      const angle = PILE_ANGLE + orbitRad + lerp(compressedOffset, finalOffset, openProgress);
      const x = Math.cos(angle) * RADIUS;
      const z = Math.sin(angle) * RADIUS;
      const tx = -Math.sin(angle) * RADIUS;
      const tz = Math.cos(angle) * RADIUS;
      const facing = Math.atan2(tx, tz) * (180 / Math.PI);
      const depthT = (z + RADIUS) / (2 * RADIUS);
      const opacity = openProgress < 0.01 ? 0 : (0.22 + 0.78 * depthT);
      cardEls[i].style.zIndex = openProgress < DEPTH_Z_SWITCH ? String(COUNT - releaseRank) : String(Math.round(100 + z));
      cardEls[i].style.transform = `translate3d(${x}px, 0px, ${z}px) rotateY(${facing}deg)`;
      cardEls[i].style.opacity = opacity.toFixed(3);
    }

    const sec = now / 1000;
    for (let i = 0; i < DUST_COUNT; i++) {
      const phase = ((now / DUST_CYCLE + i / DUST_COUNT) % 1 + 1) % 1;
      const opac = Math.sin(Math.PI * phase) * (0.74 + 0.26 * Math.sin(sec * 0.8 + i));
      if (opac < 0.01) { dustEls[i].style.opacity = '0'; continue; }
      const ang = (orbitOffset * 0.62 * Math.PI / 180) + i * (2 * Math.PI / DUST_COUNT);
      const dx = Math.cos(ang) * RADIUS * 0.5;
      const dz = Math.sin(ang) * RADIUS * 0.55;
      const dy = -72 * phase;
      const sz = 4 + 3 * Math.sin(Math.PI * phase);
      dustEls[i].style.opacity = opac.toFixed(3);
      dustEls[i].style.width = sz + 'px';
      dustEls[i].style.height = sz + 'px';
      dustEls[i].style.transform = `translate3d(${dx - sz / 2}px, ${dy - sz / 2}px, ${dz}px)`;
    }

    raf = requestAnimationFrame(frame);
  }
  frame._last = null;
  const resume = !forceFresh && carry && performance.now() - carry.at < CARRY_MS ? carry : null;
  forceFresh = false;
  let readyTimer = 0;
  if (resume) {
    ({ tiltX, tiltZ, orbitOffset, galaxyScale, startTime } = resume);
    animReady = true;
    frame(performance.now());   // paint the carried-on pose immediately: no empty frame between two rings
  } else {
    readyTimer = setTimeout(() => { animReady = true; }, 120);
    raf = requestAnimationFrame(frame);
  }

  const onMouseDown = e => {
    isDragging = true;
    dragMoved = false;
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const onMouseMove = e => {
    if (!isDragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    if (Math.hypot(dx, dy) > CLICK_DRAG) dragMoved = true;
    lastX = e.clientX;
    lastY = e.clientY;
    tiltZ = Math.max(-40, Math.min(40, tiltZ + dx * 0.3));
    tiltX = Math.max(-70, Math.min(0, tiltX - dy * 0.3));
  };
  const onMouseUp = () => { isDragging = false; };
  const onWheel = e => {
    if (!e.ctrlKey && !e.metaKey) return;   // ordinary scrolling belongs to the page; only Ctrl/Cmd+wheel or a pinch zooms the ring
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.88 : 1.12;
    galaxyScale = Math.max(0.55, Math.min(1.8, galaxyScale * delta));
  };

  // Fingers: pointer events (mouse keeps the handlers above). touch-action:none on the viewport lets a finger turn the ring.
  const onTouchDown = e => { if (e.pointerType === 'mouse') return; isDragging = true; dragMoved = false; lastX = e.clientX; lastY = e.clientY; };
  const onTouchMove = e => { if (e.pointerType === 'mouse' || !isDragging) return; onMouseMove(e); };
  const onTouchUp = e => { if (e.pointerType === 'mouse') return; setTimeout(() => { isDragging = false; }, 0); };
  viewport.addEventListener('pointerdown', onTouchDown);
  viewport.addEventListener('pointermove', onTouchMove);
  window.addEventListener('pointerup', onTouchUp);
  window.addEventListener('pointercancel', onTouchUp);
  viewport.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  viewport.addEventListener('wheel', onWheel, { passive: false });

  return {
    stop() {
      carry = { at: performance.now(), startTime, orbitOffset, tiltX, tiltZ, galaxyScale };
      stopped = true;
      clearTimeout(readyTimer);
      cancelAnimationFrame(raf);
      viewport.removeEventListener('pointerdown', onTouchDown);
      viewport.removeEventListener('pointermove', onTouchMove);
      window.removeEventListener('pointerup', onTouchUp);
      window.removeEventListener('pointercancel', onTouchUp);
      viewport.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      viewport.removeEventListener('wheel', onWheel);
      ring.replaceChildren();
    },
  };
}
