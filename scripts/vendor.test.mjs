import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
const root = new URL('../', import.meta.url);
const source = fs.readFileSync(new URL('app.js', root), 'utf8');
const version = source.match(/const MOVI_VERSION = '(\d+\.\d+\.\d+)'/)?.[1];
const dir = new URL(`vendor/movi-player/${version}/`, root);

test('the pinned player version has a self-hosted copy that matches its recorded checksum', () => {
  assert.ok(version, 'MOVI_VERSION is declared');
  const info = JSON.parse(fs.readFileSync(new URL('SOURCE.json', dir), 'utf8'));
  const js = fs.readFileSync(new URL('element.js', dir));
  assert.equal(info.version, version);
  assert.equal(js.length, info.bytes);
  assert.equal(crypto.createHash('sha256').update(js).digest('hex'), info.sha256);
  assert.match(fs.readFileSync(new URL('LICENSE', dir), 'utf8'), /Apache License/);
});
test('the self-hosted engine is self-contained: it registers the element and needs no sibling files', () => {
  const js = fs.readFileSync(new URL('element.js', dir), 'utf8');
  assert.match(js, /customElements\.define\(\s*["']movi-player["']/);
  assert.doesNotMatch(js, /^import\s.+from\s/m);
  assert.doesNotMatch(js, /movi\.wasm/);
});
test('CDN and local player URLs share the one pinned version', () => {
  assert.match(source, /movi-player@\$\{MOVI_VERSION\}\/dist\/element\.js/);
  assert.match(source, /vendor\/movi-player\/\$\{MOVI_VERSION\}\/element\.js/);
  assert.doesNotMatch(source, /movi-player@\d/);
});

function loaderFixture(imports, patience = 20) {
  const start = source.indexOf('async function importPlayer('), end = source.indexOf('let player = null', start);
  assert.ok(start >= 0 && end > start);
  const calls = [], warns = [];
  const context = {
    PLAYER_CDN: 'cdn', PLAYER_LOCAL: 'local', PLAYER_CDN_PATIENCE_MS: patience, setTimeout, clearTimeout, Promise, Error,
    console: { warn: (...a) => warns.push(a) }, playerLib: null,
    __imp: url => { calls.push(url); return imports[url](); },
  };
  const code = source.slice(start, end).replace(/\bimport\(/g, '__imp(');
  vm.runInNewContext(code + ';this.loadPlayerLib=loadPlayerLib;this.reset=()=>{playerLib=null}', context);
  return { load: context.loadPlayerLib, calls, warns };
}
test('the CDN is used when it works, and the local copy is never requested', async () => {
  const f = loaderFixture({ cdn: async () => 'cdn-module', local: async () => 'local-module' });
  assert.equal(await f.load(), 'cdn-module');
  assert.deepEqual(f.calls, ['cdn']);
  assert.equal(f.warns.length, 0);
});
test('a failing CDN falls back to the local copy', async () => {
  const f = loaderFixture({ cdn: async () => { throw new Error('offline'); }, local: async () => 'local-module' });
  assert.equal(await f.load(), 'local-module');
  assert.deepEqual(f.calls, ['cdn', 'local']);
});
test('a CDN that never answers falls back to the local copy after the patience window', async () => {
  const f = loaderFixture({ cdn: () => new Promise(() => {}), local: async () => 'local-module' });
  assert.equal(await f.load(), 'local-module');
});
test('when both fail the error surfaces and the next PLAY tries again', async () => {
  let ok = false;
  const f = loaderFixture({ cdn: async () => { throw new Error('offline'); }, local: async () => { if (!ok) throw new Error('missing'); return 'local-module'; } });
  await assert.rejects(f.load());
  ok = true;
  assert.equal(await f.load(), 'local-module');
});
