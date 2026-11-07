// Fetches IMDb / Rotten Tomatoes / Douban ratings for every title in the OneDrive folder
// and writes them to ratings.enc.json, AES-GCM encrypted with a key derived from the OneDrive link.
// Runs in GitHub Actions (server side), because RT and Douban block in-browser requests (CORS).
import { createRatingsCrypto, readRatings, writeRatingsIfChanged } from './ratings-store.mjs';
import { VIDEO_EXT, SUB_EXT, parseName } from '../lib/catalog.mjs';
import { tscore, selectDoubanCandidate, doubanRecord } from './rating-match.mjs';

const LINK = process.env.OD_LINK, TMDB = process.env.TMDB_KEY;
if (!LINK || !TMDB) { console.error('Missing OD_LINK or TMDB_KEY'); process.exit(1); }
const OUT = 'ratings.enc.json';
const onlyImdb = new Set((process.env.RATINGS_IMDB || '').split(/[,\s]+/).filter(Boolean));
if ([...onlyImdb].some(id => !/^tt\d+$/.test(id))) throw Error('Invalid RATINGS_IMDB filter');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const MUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async (url, opts = {}) => { const r = await fetch(url, { signal: AbortSignal.timeout(25000), ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) } }); if (!r.ok) { const u = new URL(url); throw new Error(r.status + ' ' + u.hostname); } return r; }; // Never log API keys or private query strings

// Read the old file before making requests. Bad keys/corrupt data must never become an empty cache.
const codec = createRatingsCrypto(LINK), previous = readRatings(OUT, codec);
const prev = previous.items, { hashId } = codec;

// ---- OneDrive listing (same anonymous share API as the site) ----
const API = 'https://my.microsoftpersonalcontent.com/_api/v2.0';
const sid = 'u!' + Buffer.from(LINK.trim()).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
const tok = (await (await get('https://api-badgerp.svc.ms/v1.0/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: '5cbed6ac-a083-4e14-b191-b4ba07653de2' }) })).json()).token;
if (!tok) throw Error('OneDrive token response was invalid');
const od = async u => {
  const r = await fetch(u, { signal: AbortSignal.timeout(25000), headers: { Authorization: 'Badger ' + tok, Prefer: 'autoredeem' } });
  if (!r.ok) throw Error('OneDrive returned ' + r.status); // Never log the private share URL.
  const j = await r.json();
  if (!Array.isArray(j.value)) throw Error('OneDrive returned an invalid folder listing');
  return j;
};
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
const vids = files.filter(f => VIDEO_EXT.test(f.name) || f.video || (f.size > 3e8 && !SUB_EXT.test(f.name)));
const titles = new Map();
for (const v of vids) { const p = parseName(v.name); titles.set(p.kind + '|' + p.title.toLowerCase() + '|' + (p.year || ''), p); }
if (!files.length || !titles.size) throw Error('No video titles returned; previous ratings left untouched');
console.log(`${files.length} files, ${titles.size} titles`);

// ---- TMDB match (same scoring idea as app.js) ----
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
      const d = await (await get(`https://api.themoviedb.org/3/${type}/${best.id}?api_key=${TMDB}&append_to_response=external_ids,keywords`)).json();
      const kw = (d.keywords?.keywords || d.keywords?.results || []).map(k => k.name.toLowerCase());
      return { id: best.id, kw, imdb: d.external_ids?.imdb_id || d.imdb_id, title: d.title || d.name, orig: d.original_title || d.original_name, year: parseInt((d.release_date || d.first_air_date || '0').slice(0, 4), 10), tv };
    }
  }
  return null;
}

// ---- rating sources ----
async function wikidata(ids) {
  if (!ids.length) return {};
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
  let last;
  for (const kind of ['movie', 'subject']) {   // two endpoints; each has its own rate limit
    try {
      const j = await (await get(`https://m.douban.com/rexxar/api/v2/${kind}/${id}?ck=&for_mobile=1`, { headers: { Referer: `https://m.douban.com/movie/subject/${id}/`, 'User-Agent': MUA } })).json();
      return doubanRecord(j, id);
    } catch (e) { last = e; }
  }
  throw last;
}
async function zhTitles(t) {
  const out = [];
  try {
    const type = t.tv ? 'tv' : 'movie';
    const tr = await (await get(`https://api.themoviedb.org/3/${type}/${t.id}/translations?api_key=${TMDB}`)).json();
    for (const x of tr.translations || []) if (x.iso_639_1 === 'zh') { const n = x.data?.title || x.data?.name; if (n) out.push(n); }
    const alt = await (await get(`https://api.themoviedb.org/3/${type}/${t.id}/alternative_titles?api_key=${TMDB}`)).json();
    for (const x of alt.titles || alt.results || []) if (['CN', 'TW', 'HK'].includes(x.iso_3166_1) && x.title) out.push(x.title);
  } catch {}
  return [...new Set(out)];
}
async function doubanSearch(t) {
  const aliases = [t.orig, t.title, ...(await zhTitles(t))].filter((x, i, a) => x && a.indexOf(x) === i);
  const qs = [t.imdb, ...aliases].filter(Boolean);
  let successes = 0, last;
  for (const q of qs) {
    try {
      const j = await (await get('https://movie.douban.com/j/subject_suggest?q=' + encodeURIComponent(q), { headers: { Referer: 'https://movie.douban.com/' } })).json();
      if (!Array.isArray(j)) throw Error('Invalid Douban suggestion response');
      successes++;
      const hit = selectDoubanCandidate(j, aliases, t.year);
      if (hit) return hit;
    } catch (e) { last = e; } // A failed spelling/query must not suppress the other aliases.
    await sleep(800);
  }
  if (!successes && last) throw last;
  return null;
}

// ---- run ----
const matched = [];
for (const p of titles.values()) { try { const m = await tmdb(p); if (m?.imdb && (!onlyImdb.size || onlyImdb.has(m.imdb))) matched.push(m); } catch (e) { console.warn('tmdb', e.message); } }
if (!matched.length) throw Error('No IMDb IDs matched; keeping the previous rating file untouched');
let wd = {}; try { wd = await wikidata(matched.map(m => m.imdb)); } catch (e) { console.warn('wikidata', e.message); }
const items = {};
for (const t of matched) {
  const h = hashId(t.imdb), old = prev[h] || {}, out = { imdb: { u: `https://www.imdb.com/title/${t.imdb}/`, v: old.imdb?.v || null } };
  try { out.imdb.v = await imdbRating(t.imdb, t.tv) || out.imdb.v; } catch (e) { console.warn('imdb', e.message); }
  try {
    const url = wd[t.imdb]?.rt ? `https://www.rottentomatoes.com/${wd[t.imdb].rt}` : (old.rt?.u || await rtSearch(t));
    if (url) out.rt = await rtFromPage(url);
  } catch (e) { console.warn('rt', e.message); out.rt = old.rt; }
  let dbId = null;
  try {
    dbId = wd[t.imdb]?.db || (old.db?.u || '').match(/subject\/(\d+)/)?.[1];
    if (!dbId) {
      // Retry with a small exact-ID query when the batch failed or omitted this title.
      try { const one = await wikidata([t.imdb]); dbId = one[t.imdb]?.db; } catch (e) { console.warn('wikidata single', e.message); }
    }
    dbId ||= await doubanSearch(t);
    if (dbId) {
      for (let k = 0; k < 3; k++) {
        try { out.db = await douban(dbId); break; } catch (e) { if (k === 2) throw e; await sleep(15000 * (k + 1)); }
      }
    }
  } catch (e) { console.warn('douban', e.message); out.db = { ...(old.db || {}), ...(dbId ? { u: `https://movie.douban.com/subject/${dbId}/` } : {}), status: 'unavailable', attemptedAt: new Date().toISOString() }; // Keep any prior score/check time; failure is not an unrated subject.
  }
  // Erotic: Douban lists the genre, or TMDB tags it as an erotic / softcore film
  const EROTIC_KW = ['erotic movie', 'softcore', 'erotica', 'sexploitation', 'erotic film'];
  out.ero = !!((out.db?.g || []).includes('\u60c5\u8272') || (t.kw || []).some(k => EROTIC_KW.includes(k)) || old.ero && !out.db?.g);
  items[h] = out;
  // Keep title-level metadata out of public workflow logs.
  await sleep(1500);
}
for (const [h, v] of Object.entries(prev)) if (!items[h]) items[h] = v; // keep old entries if a lookup failed
const changed = writeRatingsIfChanged(OUT, codec, previous, items);
console.log(changed ? 'wrote' : 'unchanged', OUT, Object.keys(items).length, 'titles');
