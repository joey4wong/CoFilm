import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM stand-ins: the ring only needs createElement, listeners, style and a few properties.
function fakeEl(tag = 'div') {
  const listeners = {};
  return { tag, className: '', dataset: {}, style: {}, children: [], textContent: '',
    appendChild(c) { this.children.push(c); return c; }, replaceChildren() { this.children = []; },
    addEventListener(t, f) { (listeners[t] ||= []).push(f); }, removeEventListener(t, f) { listeners[t] = (listeners[t] || []).filter(x => x !== f); },
    fire(t, ev = {}) { for (const f of [...(listeners[t] || [])]) f({ preventDefault() { ev.prevented = true; }, ...ev }); return ev; },
    count(t) { return (listeners[t] || []).length; } };
}
let pending = null;
async function setup() {
  const win = fakeEl('window');
  globalThis.window = win;
  globalThis.document = { createElement: fakeEl };
  globalThis.requestAnimationFrame = f => { pending = f; return 1; };
  globalThis.cancelAnimationFrame = () => {};
  const ring = fakeEl();
  const viewport = fakeEl('viewport');
  viewport.querySelector = sel => (sel === '.galaxy-ring' ? ring : null);
  const { initMovieGalaxy, restartMovieGalaxy } = await import('../lib/galaxy.mjs');
  const opened = [];
  const ctl = initMovieGalaxy(viewport, [{ key: 'a' }, { key: 'b' }, { key: 'c' }], { posterUrl: () => 'p.jpg', onOpen: k => opened.push(k) });
  const cards = ring.children.filter(c => c.className === 'g-card');
  return { win, viewport, ring, cards, opened, ctl, make: () => { const r2 = fakeEl(), v2 = fakeEl('viewport'); v2.querySelector = s => (s === '.galaxy-ring' ? r2 : null); const c = initMovieGalaxy(v2, [{ key: 'a' }, { key: 'b' }, { key: 'c' }], { posterUrl: () => 'p.jpg', onOpen() {} }); return { v2, r2, c, cards: r2.children.filter(x => x.className === 'g-card') }; }, restartMovieGalaxy };
}

test('a plain click on a poster opens it (pointerup arrives before mouseup)', async () => {
  const { viewport, win, cards, opened, ctl } = await setup();
  // The real browser order for one click: pointerdown, mousedown, pointerup, mouseup.
  cards[1].fire('pointerdown', { clientX: 100, clientY: 100 });
  viewport.fire('mousedown', { clientX: 100, clientY: 100 });
  cards[1].fire('pointerup', { clientX: 101, clientY: 100 });
  win.fire('mouseup');
  assert.deepEqual(opened, ['b']);
  ctl.stop();
});

test('dragging the ring does not open a poster', async () => {
  const { viewport, win, cards, opened, ctl } = await setup();
  cards[0].fire('pointerdown', { clientX: 100, clientY: 100 });
  viewport.fire('mousedown', { clientX: 100, clientY: 100 });
  win.fire('mousemove', { clientX: 160, clientY: 100 });
  cards[0].fire('pointerup', { clientX: 160, clientY: 100 });
  win.fire('mouseup');
  assert.deepEqual(opened, []);
  // and a fresh click afterwards works again
  cards[2].fire('pointerdown', { clientX: 5, clientY: 5 });
  viewport.fire('mousedown', { clientX: 5, clientY: 5 });
  cards[2].fire('pointerup', { clientX: 5, clientY: 5 });
  win.fire('mouseup');
  assert.deepEqual(opened, ['c']);
  ctl.stop();
});

test('plain wheel scrolls the page; Ctrl/Cmd+wheel zooms the ring', async () => {
  const { viewport, ring, ctl } = await setup();
  const plain = viewport.fire('wheel', { deltaY: 120 });
  assert.equal(plain.prevented, undefined);                    // not cancelled: the page scrolls
  const zoom = viewport.fire('wheel', { deltaY: 120, ctrlKey: true });
  assert.equal(zoom.prevented, true);
  const zoom2 = viewport.fire('wheel', { deltaY: -120, metaKey: true });
  assert.equal(zoom2.prevented, true);
  ctl.stop();
  assert.equal(viewport.count('wheel'), 0);                    // stop() removes every listener
  assert.equal(viewport.count('mousedown'), 0);
  assert.equal(ring.children.length, 0);
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
test('a ring rebuilt right after another one carries on instead of dealing again; Shuffle deals afresh; a long gap deals afresh',async()=>{
  const s = await setup();
  s.ctl.stop();                                              // clear any state from earlier tests
  s.restartMovieGalaxy();
  const first = s.make();
  await sleep(160);                                          // the ring becomes ready 120 ms after it is built
  const now = performance.now(); pending(now - 1800); pending(now);   // first frame fixes the start; 1.8 s later the deal (1.4 s) is over
  first.c.stop();
  const second = s.make();                                   // the page was redrawn: a new ring straight away
  assert.notEqual(second.cards[0].style.opacity, undefined); // already painted in its carried-on pose, no empty frame
  assert.ok(parseFloat(second.cards[0].style.opacity) > 0.2);
  second.c.stop();
  s.restartMovieGalaxy();
  const shuffled = s.make();
  assert.equal(shuffled.cards[0].style.opacity, undefined);  // fresh ring: nothing painted until it is dealt
  shuffled.c.stop();
});
