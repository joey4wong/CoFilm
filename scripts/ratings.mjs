// Fetches IMDb / Rotten Tomatoes / Douban ratings for every title in the OneDrive folder
// and writes them to ratings.enc.json, AES-GCM encrypted with a key derived from the OneDrive link.
// Runs in GitHub Actions (server side), because RT and Douban block in-browser requests (CORS).
import crypto from 'node:crypto';
import fs from 'node:fs';

const LINK = process.env.OD_LINK, TMDB = process.env.TMDB_KEY;
if (!LINK || !TMDB) { console.error('Missing OD_LINK or TMDB_KEY'); process.exit(1); }
const OUT = 'ratings.enc.json';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const MUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async (url, opts = {}) => { const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) } }); if (!r.ok) throw new Error(r.status + ' ' + url); return r; };

// ---- crypto (must match app.js) ----
const keyBytes = crypto.createHash('sha256').update('cofilm-ratings:' + LINK.trim()).digest();
const hashId = id => crypto.createHmac('sha256', keyBytes).update(id).digest('hex').slice(0, 32);
function encrypt(obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', keyBytes, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  return { v: 1, iv: iv.toString('base64'), data: data.toString('base64') };
}
function decrypt(f) {
  const buf = Buffer.from(f.data, 'base64'), iv = Buffer.from(f.iv, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', keyBytes, iv); d.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8'));
}

// ---- OneDrive listing (same anonymous share API as the site) ----
const API = 'https://my.microsoftpersonalcontent.com/_api/v2.0';
const sid = 'u!' + Buffer.from(LINK.trim()).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
const tok = (await (await fetch('https://api-badgerp.svc.ms/v1.0/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: '5cbed6ac-a083-4e14-b191-b4ba07653de2' }) })).json()).token;
const od = async u => (await fetch(u, { headers: { Authorization: 'Badger ' + tok, Prefer: 'autoredeem' } })).json();
const files = [];
async function walk(url, depth) {
  let next = url;
  while (next) {
    const j = await od(next);
    for (const c of j.value || []) {
      if (c.folder && depth < 4) await walk(`${API}/drives/${c.parentReference.driveId}/items/${c.id}/children?$top=500`, depth + 1);
      else if (c.file) files.push(c);
    }
    next = j['@odata.nextLink'];
  }
}
await walk(`${API}/shares/${sid}/driveitem/children?$top=500`, 0);

// ---- filename parsing (copied from app.js) ----
const VIDEO_EXT = /\.(mkv|mp4|m4v|mov|avi|ts|m2ts|webm|wmv|flv)$/i, SUB_EXT = /\.(srt|ass|ssa|vtt)$/i;
const STRONG = /^(\d{3,4}p|blu-?ray|bdrip|brrip|web-?dl|webrip|web|hdtv|hdrip|dvdrip|uhd|4k|remux|hdr|hdr10\+?|dv|x26[45]|h\.?26[45]|hevc|avc|10bit|8bit|ddp?\d?(\.\d)?|aac\d?(\.\d)?|dts(-hd)?|truehd|atmos|cc|it|amzn|nf|ma)$/i;
const EDITION = /^(unrated|extended|dubbed|repack|proper|imax|remastered|directors|cut|uncut|criterion|multi|dual|limited|internal|bluray)$/i;
function parseName(name) {
  let base = name.replace(/\.[a-z0-9]{2,4}$/i, m => (VIDEO_EXT.test(m) || SUB_EXT.test(m) ? '' : m));
  base = base.replace(/\[[^\]]*\]/g, ' ').replace(/[\u4e00-\u9fff]+/g, ' ');
  const ep = base.match(/^(.*?)[ ._-]+S(\d{1,2})[ ._-]?E(\d{1,3})/i);
  if (ep) return { kind: 'series', title: ep[1].replace(/[._]+/g, ' ').trim(), year: null };
  const t = base.split(/[ ._]+/).filter(Boolean);
  let q = t.findIndex((x, i) => i > 0 && STRONG.test(x)); if (q < 0) q = t.length;
  let y = -1; for (let i = 1; i < q; i++) if (/^(19|20)\d\d$/.test(t[i])) y = i;
  const tt = (y > 0 ? t.slice(0, y) : t.slice(0, q)).filter((x, i) => i === 0 || !EDITION.test(x));
  return { kind: 'movie', title: tt.join(' ').replace(/\s+-\s*$/, '').trim(), year: y > 0 ? +t[y] : null };
}
const vids = files.filter(f => VIDEO_EXT.test(f.name) || f.video || (f.size > 3e8 && !SUB_EXT.test(f.name)));
const titles = new Map();
for (const v of vids) { const p = parseName(v.name); titles.set(p.kind + '|' + p.title.toLowerCase() + '|' + (p.year || ''), p); }
console.log(`${files.length} files, ${titles.size} titles`);

// ---- TMDB match (same scoring idea as app.js) ----
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const words = s => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
const tscore = (n, t) => { if (norm(n) === norm(t)) return 100; const a = words(t), b = words(n); return a.filter(w => b.includes(w)).length + (a[0] === b[0] ? .5 : 0); };
async function tmdb(p) {
  const tv = p.kind === 'series', type = tv ? 'tv' : 'movie';
  for (const yp of p.year ? [tv ? `&first_air_date_year=${p.year}` : `&year=${p.year}`, ''] : ['']) {
    const j = await (await get(`https://api.themoviedb.org/3/search/${type}?api_key=${TMDB}&query=${encodeURIComponent(p.title)}${yp}`)).json();
    let best = null, bs = 0;
    for (const x of j.results || []) {
      const y = parseInt((x.release_date || x.first_air_date || '0').slice(0, 4), 10), dy = p.year && y ? Math.abs(y - p.year) : 0;
      if (p.year && y && dy > 1) continue;
      const s = Math.max(tscore(x.title || x.name, p.title), tscore(x.original_title || x.original_name, p.title)) - dy * .3 + Math.min(x.popularity || 0, 50) / 100 + (x.poster_path ? .2 : 0);
      if (s > bs) { bs = s; best = x; }
    }
    if (best && bs >= 1) {
      const d = await (await get(`https://api.themoviedb.org/3/${type}/${best.id}?api_key=${TMDB}&append_to_response=external_ids`)).json();
      return { imdb: d.external_ids?.imdb_id || d.imdb_id, title: d.title || d.name, orig: d.original_title || d.original_name, year: parseInt((d.release_date || d.first_air_date || '0').slice(0, 4), 10), tv };
    }
  }
  return null;
}

// ---- rating sources ----
async function wikidata(ids) {
  const q = `SELECT ?imdb ?rt ?db WHERE { VALUES ?imdb { ${ids.map(i => `"${i}"`).join(' ')} } ?f wdt:P345 ?imdb. OPTIONAL{?f wdt:P1258 ?rt} OPTIONAL{?f wdt:P4529 ?db} }`;
  const j = await (await get('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), { headers: { Accept: 'application/sparql-results+json' } })).json();
  const m = {}; for (const b of j.results.bindings) m[b.imdb.value] = { rt: b.rt?.value, db: b.db?.value }; return m;
}
async function imdbRating(id, tv) {
  const j = await (await get(`https://v3-cinemeta.strem.io/meta/${tv ? 'series' : 'movie'}/${id}.json`)).json();
  return j.meta?.imdbRating || null;
}
async function rtFromPage(url) {
  const h = await (await get(url)).text();
  const pct = re => { const m = h.match(re); return m ? m[1] + '%' : null; };
  return { u: url, v: pct(/"criticsScore":\{[^}]*?"scorePercent":"(\d+)%"/), a: pct(/"audienceScore":\{[^}]*?"scorePercent":"(\d+)%"/) };
}
async function rtSearch(t) {
  const h = await (await get('https://www.rottentomatoes.com/search?search=' + encodeURIComponent(t.title))).text();
  const rows = [...h.matchAll(/<search-page-media-row([\s\S]*?)<\/search-page-media-row>/g)].map(m => m[1]);
  for (const r of rows) {
    const yr = parseInt((r.match(/(?:release|start)-year="(\d{4})"/) || [])[1] || '0', 10);
    const url = (r.match(t.tv ? /href="(https:\/\/www\.rottentomatoes\.com\/tv\/[^"]+)"/ : /href="(https:\/\/www\.rottentomatoes\.com\/m\/[^"]+)"/) || [])[1];
    const name = (r.match(/data-qa="info-name"[^>]*>\s*([^<]+?)\s*</) || [])[1] || '';
    if (url && (!t.year || !yr || Math.abs(yr - t.year) <= 1) && tscore(name, t.title) >= 1) return url;
  }
  return null;
}
async function douban(id) {
  const j = await (await get(`https://m.douban.com/rexxar/api/v2/movie/${id}?ck=&for_mobile=1`, { headers: { Referer: `https://m.douban.com/movie/subject/${id}/`, 'User-Agent': MUA } })).json();
  return { u: `https://movie.douban.com/subject/${id}/`, v: j.rating?.value ? String(j.rating.value) : null, n: j.rating?.count || 0 };
}
async function doubanSearch(t) {
  for (const q of [t.title, t.orig].filter((x, i, a) => x && a.indexOf(x) === i)) {
    const j = await (await get('https://movie.douban.com/j/subject_suggest?q=' + encodeURIComponent(q), { headers: { Referer: 'https://movie.douban.com/' } })).json();
    const hit = j.find(x => x.type === 'movie' && (!t.year || Math.abs(parseInt(x.year, 10) - t.year) <= 1));
    if (hit) return hit.id;
    await sleep(800);
  }
  return null;
}

// ---- run ----
let prev = {};
try { prev = decrypt(JSON.parse(fs.readFileSync(OUT, 'utf8'))).items || {}; } catch {}
const matched = [];
for (const p of titles.values()) { try { const m = await tmdb(p); if (m?.imdb) matched.push(m); } catch (e) { console.warn('tmdb', p.title, e.message); } }
let wd = {}; try { wd = await wikidata(matched.map(m => m.imdb)); } catch (e) { console.warn('wikidata', e.message); }
const items = {};
for (const t of matched) {
  const h = hashId(t.imdb), old = prev[h] || {}, out = { imdb: { u: `https://www.imdb.com/title/${t.imdb}/`, v: old.imdb?.v || null } };
  try { out.imdb.v = await imdbRating(t.imdb, t.tv) || out.imdb.v; } catch (e) { console.warn('imdb', t.title, e.message); }
  try {
    const url = wd[t.imdb]?.rt ? `https://www.rottentomatoes.com/${wd[t.imdb].rt}` : (old.rt?.u || await rtSearch(t));
    if (url) out.rt = await rtFromPage(url);
  } catch (e) { console.warn('rt', t.title, e.message); out.rt = old.rt; }
  let dbId = null;
  try {
    dbId = wd[t.imdb]?.db || (old.db?.u || '').match(/subject\/(\d+)/)?.[1] || await doubanSearch(t);
    if (dbId) {
      for (let k = 0; k < 3; k++) {
        try { out.db = await douban(dbId); break; } catch (e) { if (k === 2) throw e; await sleep(4000 * (k + 1)); }
      }
    }
  } catch (e) { console.warn('douban', t.title, e.message); out.db = old.db?.v ? old.db : (dbId ? { u: `https://movie.douban.com/subject/${dbId}/`, v: null } : old.db); }
  items[h] = out;
  console.log(`${t.title} (${t.year}) IMDb ${out.imdb.v ?? '-'} | RT ${out.rt?.v ?? '-'} / ${out.rt?.a ?? '-'} | Douban ${out.db?.v ?? '-'}`);
  await sleep(1500);
}
for (const [h, v] of Object.entries(prev)) if (!items[h]) items[h] = v; // keep old entries if a lookup failed
fs.writeFileSync(OUT, JSON.stringify(encrypt({ updated: new Date().toISOString(), items })));
console.log('wrote', OUT, Object.keys(items).length, 'titles');
