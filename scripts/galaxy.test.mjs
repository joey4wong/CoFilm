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
async function setup() {
  const win = fakeEl('window');
  globalThis.window = win;
  globalThis.document = { createElement: fakeEl };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const ring = fakeEl();
  const viewport = fakeEl('viewport');
  viewport.querySelector = sel => (sel === '.galaxy-ring' ? ring : null);
  const { initMovieGalaxy } = await import('../lib/galaxy.mjs');
  const opened = [];
  const ctl = initMovieGalaxy(viewport, [{ key: 'a' }, { key: 'b' }, { key: 'c' }], { posterUrl: () => 'p.jpg', onOpen: k => opened.push(k) });
  const cards = ring.children.filter(c => c.className === 'g-card');
  return { win, viewport, ring, cards, opened, ctl };
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
