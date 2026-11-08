import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const root=new URL('../',import.meta.url),read=f=>fs.readFileSync(new URL(f,root),'utf8');
const manifest=JSON.parse(read('manifest.webmanifest'));
const pngSize=f=>{const b=fs.readFileSync(new URL(f,root));assert.equal(b.subarray(1,4).toString(),'PNG');return[b.readUInt32BE(16),b.readUInt32BE(20)]};
test('manifest declares an installable standalone app that stays inside this site folder',()=>{
  assert.equal(manifest.display,'standalone');assert.equal(manifest.start_url,'./');assert.equal(manifest.scope,'./');
  assert.ok(manifest.name&&manifest.short_name);assert.match(manifest.theme_color,/^#[0-9a-f]{6}$/i);assert.match(manifest.background_color,/^#[0-9a-f]{6}$/i);
});
test('every manifest icon exists at its declared size, with a maskable one',()=>{
  for(const i of manifest.icons){const[w,h]=i.sizes.split('x').map(Number);assert.deepEqual(pngSize(i.src),[w,h],i.src);}
  assert.ok(manifest.icons.some(i=>i.sizes==='192x192'&&i.purpose==='any'));assert.ok(manifest.icons.some(i=>i.sizes==='512x512'&&i.purpose==='any'));assert.ok(manifest.icons.some(i=>i.purpose==='maskable'));
});
test('the page links the manifest and the iOS home-screen settings',()=>{
  const html=read('index.html');assert.match(html,/<link rel="manifest" href="manifest\.webmanifest">/);
  for(const m of ['apple-mobile-web-app-capable','apple-mobile-web-app-title','mobile-web-app-capable','apple-mobile-web-app-status-bar-style'])assert.ok(html.includes(m),m);
});
test('the service worker never caches, so a new release is never hidden',()=>{
  const sw=read('sw.js');assert.doesNotMatch(sw,/caches\./);assert.doesNotMatch(sw,/respondWith/);assert.match(sw,/addEventListener\('fetch'/);
  assert.match(read('app.js'),/serviceWorker\.register\('sw\.js'\)/);
});
