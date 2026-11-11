// Refresh the self-hosted Movi player copy: node scripts/vendor-movi.mjs 0.4.1
// Then set MOVI_VERSION in app.js to the same version. scripts/vendor.test.mjs fails if they disagree.
import fs from 'node:fs';
import crypto from 'node:crypto';
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) { console.error('usage: node scripts/vendor-movi.mjs <exact version, e.g. 0.4.1>'); process.exit(1); }
const base = `https://cdn.jsdelivr.net/npm/movi-player@${version}`;
const get = async path => { const r = await fetch(base + path); if (!r.ok) throw Error(`${base + path}: HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
const [js, license] = await Promise.all([get('/dist/element.js'), get('/LICENSE')]);
const dir = new URL(`../vendor/movi-player/${version}/`, import.meta.url);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(new URL('element.js', dir), js);
fs.writeFileSync(new URL('LICENSE', dir), license);
const info = { package: 'movi-player', version, license: 'Apache-2.0', file: 'element.js', bytes: js.length, sha256: crypto.createHash('sha256').update(js).digest('hex'), source: `${base}/dist/element.js` };
fs.writeFileSync(new URL('SOURCE.json', dir), JSON.stringify(info, null, 2) + '\n');
console.log(info);
