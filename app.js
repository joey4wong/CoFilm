import { VIDEO_EXT, SUB_EXT, parseName, keyOf, tscore as titleScore, isFreshMeta, compactPerson, libraryMatches, lifeLine, MOVIE_SORTS, decadeOf, filterMovieFacts, sortMovieFacts, titlesWithPerson, moviesFlowActive, moviePageSlice, pickGalaxyMovies } from './lib/catalog.mjs?v=132';
import { initMovieGalaxy, restartMovieGalaxy } from './lib/galaxy.mjs?v=132';
// CoFilm: OneDrive share link -> poster wall -> in-browser playback (Movi Player)
const BADGER_APP = '5cbed6ac-a083-4e14-b191-b4ba07653de2';
const API = 'https://my.microsoftpersonalcontent.com/_api/v2.0';
const META = 'https://v3-cinemeta.strem.io';
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { localStorage.removeItem(k); },
};
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));


const state = { items: [], genre: 'All', q: '', sort: 'added', listedAt: 0 };

// ---------- OneDrive (anonymous share access) ----------
function shareId(link) {
  const b64 = btoa(unescape(encodeURIComponent(link.trim())));
  return 'u!' + b64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}
let tokenRequest = null;
async function token(force) {
  const c = LS.get('od:token');
  if (!force && c && Date.parse(c.exp) - Date.now() > 3600e3) return c.token;
  // Share one request between callers (startup, unlock, listing) instead of racing several.
  return tokenRequest ||= (async () => {
    try {
      const r = await fetch('https://api-badgerp.svc.ms/v1.0/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: BADGER_APP }),
      });
      if (!r.ok) throw new Error('Could not get access token ' + r.status);
      const j = await r.json();
      LS.set('od:token', { token: j.token, exp: j.expiryTimeUtc });
      return j.token;
    } finally { tokenRequest = null; }
  })();
}
async function odGet(url, retry = true) {
  const r = await fetch(url, { headers: { Authorization: 'Badger ' + await token(), Prefer: 'autoredeem' } });
  if (r.status === 401 && retry) { await token(true); return odGet(url, false); }
  if (!r.ok) throw new Error('OneDrive returned ' + r.status);
  return r.json();
}
const FILE_FIELDS = 'id,name,size,createdDateTime,lastModifiedDateTime,file,folder,video,parentReference,@content.downloadUrl';
async function walkShare(link, query) {
  const out = [];
  async function walk(url, path, depth) {
    let next = url;
    while (next) {
      const j = await odGet(next);
      const sub = [];
      for (const c of j.value || []) {
        if (c.folder && depth < 4) {
          const d = c.parentReference?.driveId;
          sub.push(walk(`${API}/drives/${d}/items/${c.id}/children?$top=500&${query}`, path.concat(c.name), depth + 1).catch(e => console.warn('subfolder read failed', c.name, e)));
        } else if (c.file) { c.__path = path; out.push(c); }
      }
      await Promise.all(sub);                                   // read subfolders in parallel
      next = j['@odata.nextLink'];
    }
  }
  await walk(`${API}/shares/${shareId(link)}/driveitem/children?$top=500&${query}`, [], 0);
  return out;
}
// Building thumbnails makes OneDrive answer ~30% slower (measured median 1.07 s vs 0.73 s), and running both
// requests at once makes them compete. So list first, show the library, then fetch the fallback stills.
async function listAll(link) {
  const files = await walkShare(link, '$select=' + FILE_FIELDS);
  const thumbs = walkShare(link, '$expand=thumbnails($select=large,medium)&$select=id,file,folder,parentReference')
    .then(list => new Map(list.map(f => [f.id, f.thumbnails?.[0]?.large?.url || f.thumbnails?.[0]?.medium?.url]).filter(x => x[1])));
  thumbs.catch(() => {});
  return { files, thumbs };
}

// ---------- metadata (Cinemeta, no API key) ----------
const TMDB_API = 'https://api.themoviedb.org/3';
// Metadata requests must never turn a flaky network or a rate limit (HTTP 429) into "no such film".
async function fetchJson(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      last = new Error('HTTP ' + r.status);
      if (r.status !== 429 && r.status < 500) break;          // 4xx other than 429: retrying will not help
      const wait = Number(r.headers.get('retry-after')) * 1000;
      await new Promise(res => setTimeout(res, Math.min(5000, wait || 600 * 2 ** i)));
    } catch (e) { last = e; await new Promise(res => setTimeout(res, 500 * 2 ** i)); }
  }
  throw last;
}
// TMDB search: returns full TMDB details (with external_ids) of the best match, or null
async function tmdbLookup(p, key, tmdbId) {
  const tv = p.kind === 'series', type = tv ? 'tv' : 'movie';
  const get = u => fetchJson(`${TMDB_API}${u}${u.includes('?') ? '&' : '?'}api_key=${key}`);
  if (!tmdbId) {
    const yearParam = p.year ? (tv ? `&first_air_date_year=${p.year}` : `&year=${p.year}`) : '';
    const tries = [p.title]; if (/^the /i.test(p.title)) tries.push(p.title.slice(4));
    for (const t of tries) {
      for (const yp of p.year ? [yearParam, ''] : ['']) {
        const j = await get(`/search/${type}?query=${encodeURIComponent(t)}${yp}`);
        let best = null, bs = 0;
        for (const x of j.results || []) {
          const nm = x.title || x.name, on = x.original_title || x.original_name;
          const y = parseInt((x.release_date || x.first_air_date || '0').slice(0, 4), 10);
          const dy = p.year && y ? Math.abs(y - p.year) : 0;
          if (p.year && y && dy > 1) continue;
          const s = Math.max(titleScore(nm, t), titleScore(on, t)) - dy * 0.3 + Math.min(x.popularity || 0, 50) / 100 + (x.poster_path ? 0.2 : 0);
          if (s > bs) { bs = s; best = x; }
        }
        if (best && bs >= 1) { tmdbId = best.id; break; }
      }
      if (tmdbId) break;
    }
  }
  if (!tmdbId) return null;
  return get(`/${type}/${tmdbId}?append_to_response=external_ids`);
}
const metaKey = p => 'meta4:' + p.kind + ':' + keyOf(p);
// Older cache generations may hold wrong matches or dead poster URLs; drop them once.
try { Object.keys(localStorage).filter(k => /^meta[0-9]?:/.test(k) && !k.startsWith('meta4:')).forEach(k => localStorage.removeItem(k)); } catch {}
function cachedMetadata(p) {
  const entry = LS.get(metaKey(p));
  return { entry, fresh: isFreshMeta(entry) };
}
async function findMeta(p) {
  const vk = metaKey(p), { entry: cached, fresh } = cachedMetadata(p);
  if (fresh) return cached.ok ? cached.m : null;
  let m = null;
  try {
    const manual = LS.get('fix:' + p.kind + ':' + keyOf(p));
    let id = manual, td = null;
    const key = LS.get('tmdb:key');
    // 1) TMDB first (more accurate matching), unless a manual IMDb fix exists
    if (key) {
      try {
        if (manual) {
          const f = await fetchJson(`${TMDB_API}/find/${manual}?api_key=${key}&external_source=imdb_id`);
          const hit = (p.kind === 'series' ? f.tv_results : f.movie_results)?.[0];
          if (hit) td = await tmdbLookup(p, key, hit.id);
        } else td = await tmdbLookup(p, key);
        if (td && !id) id = td.external_ids?.imdb_id || td.imdb_id || null;
      } catch (e) { console.warn('tmdb search', p.title, e); }
    }
    // 2) Cinemeta search as fallback when TMDB has nothing
    if (!id && !td) {
      const tries = [p.title];
      if (/^the /i.test(p.title)) tries.push(p.title.slice(4));
      for (const t of tries) {
        const j = await fetchJson(`${META}/catalog/${p.kind}/top/search=${encodeURIComponent(t)}.json`);
        const list = j.metas || [];
        const yr = x => parseInt(x.releaseInfo || x.year || '0', 10);
        let hit = null, best = 0;
        for (const x of list) {
          const dy = p.year ? Math.abs(yr(x) - p.year) : 0;
          if (dy > 1) continue;
          const s = titleScore(x.name, t) - dy * 0.3;
          if (s > best) { best = s; hit = x; }
        }
        if (hit && best < 1) hit = null;
        if (!hit && p.year) hit = list.slice(0, 3).find(x => yr(x) === p.year) || null;
        if (!hit && !p.year) hit = list[0] || null;
        if (hit) { id = hit.imdb_id || hit.id; break; }
      }
    }
    // 3) details: Cinemeta (IMDb rating, logo, episodes) merged with TMDB (synopsis, poster, backdrop)
    let d = null;
    if (id) { try { d = (await fetchJson(`${META}/meta/${p.kind}/${id}.json`)).meta; } catch {} }
    if (d || td) {
      const T = td || {}, I = 'https://image.tmdb.org/t/p/';
      const tYear = (T.release_date || T.first_air_date || '').slice(0, 4);
      const tRun = T.runtime || T.episode_run_time?.[0];
      m = {
        id: id || ('tmdb' + T.id), tmdbId: T.id || d?.moviedb_id,
        name: T.title || T.name || d?.name, year: tYear || d?.releaseInfo || d?.year,
        desc: T.overview || d?.description,
        rating: d?.imdbRating || (T.vote_average ? T.vote_average.toFixed(1) : ''),
        imdbRating: d?.imdbRating || null, ratingSource: d?.imdbRating ? 'IMDb' : 'TMDB',
        genres: (T.genres || []).map(g => g.name.replace('Science Fiction', 'Sci-Fi')).filter(Boolean).length ? T.genres.map(g => g.name.replace('Science Fiction', 'Sci-Fi')) : (d?.genres || d?.genre || []),
        cast: d?.cast || [], director: d?.director || (T.created_by || []).map(c => c.name), runtime: tRun ? tRun + ' min' : d?.runtime,
        poster: T.poster_path ? I + 'w500' + T.poster_path : (id ? `https://images.metahub.space/poster/medium/${id}/img` : ''),
        background: T.backdrop_path ? I + 'w1280' + T.backdrop_path : (T.poster_path ? I + 'w1280' + T.poster_path : d?.background),
        country: (T.production_countries || []).map(c => c.name).join(', ') || d?.country,
        videos: (d?.videos || []).map(v => ({ s: v.season, e: v.episode, name: v.name || v.title, thumb: v.thumbnail, desc: v.overview || v.description })),
        logo: d?.logo || (id ? `https://images.metahub.space/logo/medium/${id}/img` : ''), writer: d?.writer || [], awards: d?.awards,
      };
    }
  } catch (e) { console.warn('meta', p.title, e); }
  if (!m && cached?.ok) { LS.set(vk, { ...cached, t: Date.now() }); return cached.m; }
  LS.set(vk, { ok: !!m, m, t: Date.now() });
  return m;
}
// A poster that fails to load triggers one fresh metadata lookup per title per visit.
const healedPosters = new Set();
window.cofilmPosterFailed = img => {
  const href = img.closest('.card')?.getAttribute('href');
  const it = state.items.find(x => '#/t/' + enc(x.key) === href);
  if (!it || !it.meta || healedPosters.has(it.key)) return;
  healedPosters.add(it.key);
  const was = it.meta.poster;
  LS.del(metaKey(it.parsed));
  findMeta(it.parsed).then(nm => { if (nm && nm.poster && nm.poster !== was) { it.meta = nm; scheduleRender(); } }).catch(() => {});
};
async function pool(arr, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < arr.length) { const k = i++; await fn(arr[k], k); } }));
}

// ---------- build library ----------
function buildItems(files) {
  const vids = files.filter(f => VIDEO_EXT.test(f.name) || f.video || /^video\//.test(f.file?.mimeType || '') || (f.size > 3e8 && !SUB_EXT.test(f.name)));
  const subs = files.filter(f => SUB_EXT.test(f.name));
  const stem = n => n.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/\.+$/, '').toLowerCase();
  const findSubs = v => {
    const s = stem(v.name);
    let hits = subs.filter(x => stem(x.name) === s || stem(x.name).startsWith(s));
    if (!hits.length) {
      const p = parseName(v.name), first = p.title.split(' ')[0].toLowerCase();
      const c = subs.filter(x => { const q = parseName(x.name); return q.year === p.year && q.title.split(' ')[0].toLowerCase() === first; });
      if (c.length) hits = c;
    }
    return hits;
  };
  const map = new Map();
  for (const v of vids) {
    const p = parseName(v.name);
    const k = p.kind + ':' + keyOf(p);
    const file = { id: v.id, name: v.name, size: v.size, url: v['@content.downloadUrl'], added: Date.parse(v.lastModifiedDateTime || v.createdDateTime),
      video: v.video, thumb: v.thumbnails?.[0]?.large?.url || v.thumbnails?.[0]?.medium?.url, subs: findSubs(v).map(s => ({ name: s.name, url: s['@content.downloadUrl'] })), s: p.season, e: p.episode };
    if (!map.has(k)) map.set(k, { key: k, parsed: p, files: [], added: 0 });
    const it = map.get(k);
    it.files.push(file);
    it.added = Math.max(it.added, file.added);
  }
  for (const it of map.values()) it.files.sort((a, b) => (a.s - b.s) || (a.e - b.e) || a.name.localeCompare(b.name));
  return [...map.values()];
}

let loading = false;
function saveFiles(files) {
  const thumb = t => { const u = t?.large?.url || t?.medium?.url; return u ? [{ large: { url: u } }] : undefined; };
  LS.set('od:files', files.map(f => ({
    id: f.id, name: f.name, size: f.size, '@content.downloadUrl': f['@content.downloadUrl'],
    createdDateTime: f.createdDateTime, lastModifiedDateTime: f.lastModifiedDateTime,
    video: f.video && { width: f.video.width, height: f.video.height, fourCC: f.video.fourCC },
    file: f.file && { mimeType: f.file.mimeType }, thumbnails: thumb(f.thumbnails?.[0]),
  })));
  LS.set('od:listedAt', Date.now());
}
async function applyFiles(files, { refreshMetadata = true } = {}) {
  const old = new Map(state.items.map(it => [it.key, it.meta]));
  const before = state.items.length;
  state.listedAt = LS.get('od:listedAt');
  state.items = buildItems(files).filter(it => it.parsed.kind !== 'series');   // TV episodes in OneDrive are ignored
  const pending = [];
  for (const it of state.items) {
    const { entry, fresh } = cachedMetadata(it.parsed);
    it.meta = old.has(it.key) ? old.get(it.key) : entry?.ok ? entry.m : null;
    it.metaPending = refreshMetadata && !entry && !it.meta;   // first lookup still running: show the title, not a still
    if (!fresh) pending.push(it);
  }
  render(); // Show the cached library immediately; don't wait for metadata requests.
  if (refreshMetadata && pending.length) {
    await pool(pending, 6, async it => { const m = await findMeta(it.parsed); const was = it.metaPending; it.metaPending = false; if (m !== it.meta || was) { it.meta = m; scheduleRender(); } });
    render();
  }
  applyErotic();
  return state.items.length - before;
}
async function load(force) {
  const link = LS.get('od:link');
  if (!link) { if (!autoUnlock) openSetup(); return; }
  if (loading) return; loading = true;
  try {
    const cached = LS.get('od:files');
    if (cached && !state.items.length && !force) await applyFiles(cached, { refreshMetadata: false });
    else if (!cached) toast('Loading OneDrive…');
    const { files, thumbs } = await listAll(link);
    // Keep stills already known for these files until the fresh thumbnail request answers.
    const known = new Map((cached || []).map(f => [f.id, f.thumbnails]));
    for (const f of files) if (!f.thumbnails && known.get(f.id)) f.thumbnails = known.get(f.id);
    saveFiles(files);
    thumbs.then(map => {
      for (const f of files) { const u = map.get(f.id); if (u) f.thumbnails = [{ large: { url: u } }]; }
      for (const it of state.items) for (const x of it.files) { const u = map.get(x.id); if (u) x.thumb = u; }
      saveFiles(files); scheduleRender();
    }).catch(e => console.warn('thumbnails', e));
    const added = await applyFiles(files);
    if (force || !cached) toast(`${state.items.length} titles`, 2500);
    else if (added > 0) toast(`${added} new title${added > 1 ? 's' : ''} added`, 4000);
  } catch (e) {
    console.error(e);
    toast(`Loading failed: ${e.message}. Tap refresh to retry.`, 8000);
  } finally { loading = false; }
}
// re-check OneDrive every 5 minutes while the page is open, and when you come back to the tab
setInterval(() => { if (!document.hidden && $('#player').hidden) load(); }, 5 * 60e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - (LS.get('od:listedAt') || 0) > 2 * 60e3 && $('#player').hidden) load(); });
async function freshFile(f) {
  if (Date.now() - state.listedAt < 40 * 60e3) return f;
  await load(true);
  for (const it of state.items) for (const x of it.files) if (x.id === f.id) return x;
  return f;
}

// ---------- subtitles ----------
function assToSrt(txt) {
  const lines = txt.split(/\r?\n/); let fmt = null, n = 0; const out = [];
  const t = s => { const m = s.trim().match(/(\d+):(\d+):(\d+)[.:](\d+)/); if (!m) return '00:00:00,000'; return `${m[1].padStart(2, '0')}:${m[2]}:${m[3]},${(m[4] + '00').slice(0, 3)}`; };
  for (const l of lines) {
    if (/^Format:/i.test(l) && !fmt) { const f = l.slice(7).split(',').map(x => x.trim().toLowerCase()); if (f.includes('text')) fmt = f; continue; }
    if (!/^Dialogue:/i.test(l) || !fmt) continue;
    const parts = l.slice(9).split(','); const text = parts.slice(fmt.length - 1).join(',');
    const start = parts[fmt.indexOf('start')], end = parts[fmt.indexOf('end')];
    const clean = text.replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/\\h/g, ' ').trim();
    if (clean) out.push(`${++n}\n${t(start)} --> ${t(end)}\n${clean}\n`);
  }
  return out.join('\n');
}
async function subBlob(s) {
  const buf = await (await fetch(s.url)).arrayBuffer();
  let txt = new TextDecoder('utf-8').decode(buf);
  if (txt.includes('\uFFFD')) {                       // not UTF-8: try UTF-16 (BOM) or Chinese GBK/GB18030
    const b = new Uint8Array(buf);
    try { txt = new TextDecoder(b[0] === 0xFF && b[1] === 0xFE ? 'utf-16le' : b[0] === 0xFE && b[1] === 0xFF ? 'utf-16be' : 'gb18030').decode(buf); } catch {}
  }
  txt = txt.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');   // strip BOM, Windows line endings break the parser
  if (/\.(ass|ssa)$/i.test(s.name)) txt = assToSrt(txt);
  if (!/\.vtt$/i.test(s.name)) txt = txt.replace(/(\d\d:\d\d:\d\d)\.(\d{3})/g, '$1,$2').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  const cjk = /[\u4e00-\u9fff]/.test(txt), latin = /[A-Za-z]{3,}.*\n/.test(txt.replace(/^\d+\n[\d:,.\- >]+\n/gm, ''));
  const lang = cjk && latin ? { code: 'zh', label: 'Chinese & English' } : cjk ? { code: 'zh', label: 'Chinese' } : { code: 'en', label: 'English' };
  if (/\.vtt$/i.test(s.name)) return { url: URL.createObjectURL(new Blob([txt], { type: 'text/vtt' })), fmt: 'vtt', lang };
  return { url: URL.createObjectURL(new Blob([txt], { type: 'text/plain' })), fmt: 'srt', lang };
}


// ---------- OneDrive read-ahead source ----------
// The player's demuxer issues many small range reads. Each OneDrive request costs ~200-300 ms of latency,
// so we fetch big aligned blocks (in parallel), keep them in an LRU cache and prefetch ahead of playback.
class ODSource {
  constructor(file, refresh, { resumeAt = 0 } = {}) {
    this.f = file; this.url = file.url; this.size = file.size; this.refresh = refresh;
    // Resuming: the engine first reads the head of the file to identify the streams, then jumps to the saved
    // spot. Read-ahead from that head is wasted (measured ~34 MB on a 4K film), so hold it until playback
    // reaches the middle of the file or starts.
    this.holdAhead = resumeAt > 0;
    this.BS = 4 * 1024 * 1024; this.MAX = 56; this.AHEAD = 8; this.PAR = 4;
    this.cache = new Map(); this.inflight = 0; this.queue = []; this.last = -1;
  }
  async getSize() { return this.size; }
  getKey() { return 'od:' + this.f.id; }
  seek(o) { return o; } getPosition() { return 0; } close() { this.cache.clear(); this.closed = true; }
  _slot(fn) {
    return new Promise((res, rej) => {
      const run = () => { this.inflight++; fn().then(res, rej).finally(() => { this.inflight--; const n = this.queue.shift(); if (n) n(); }); };
      this.inflight < this.PAR ? run() : this.queue.push(run);
    });
  }
  async _fetch(i, retry = 0) {
    const start = i * this.BS, end = Math.min(this.size, start + this.BS) - 1;
    try {
      const r = await fetch(this.url, { headers: { Range: `bytes=${start}-${end}` } });
      if (r.status === 401 || r.status === 403 || r.status === 404) throw Object.assign(new Error('expired'), { expired: true });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.arrayBuffer();
    } catch (e) {
      if (retry >= 3 || this.closed) throw e;
      if (e.expired && this.refresh) { const u = await this.refresh(); if (u) this.url = u; }
      else await new Promise(r => setTimeout(r, 400 * (retry + 1)));
      return this._fetch(i, retry + 1);
    }
  }
  _block(i, prio) {
    let p = this.cache.get(i);
    if (p) { this.cache.delete(i); this.cache.set(i, p); return p; }
    p = prio ? this._fetch(i) : this._slot(() => this._fetch(i));
    p.catch(() => this.cache.delete(i));
    this.cache.set(i, p);
    while (this.cache.size > this.MAX) this.cache.delete(this.cache.keys().next().value);
    return p;
  }
  async read(offset, length) {
    if (offset >= this.size) return new ArrayBuffer(0);
    const endB = Math.min(this.size, offset + length);
    const first = Math.floor(offset / this.BS), last = Math.floor((endB - 1) / this.BS);
    const edge = 64 * 1024 * 1024;
    if (this.holdAhead && offset > edge && endB < this.size - edge) this.holdAhead = false;
    // prefetch ahead when reading forward (playback), not for one-off probes at the end of the file
    if (!this.holdAhead && this.last >= 0 && first >= this.last && first - this.last <= 2) {
      const maxB = Math.floor((this.size - 1) / this.BS);
      for (let i = last + 1; i <= Math.min(maxB, last + this.AHEAD); i++) if (!this.cache.has(i)) this._block(i, false);
    }
    this.last = last;
    return this.readShared(offset, length);
  }
  // Same block cache as the engine, without moving its read-ahead position: for side readers such as the
  // embedded-subtitle index, so the same bytes are never downloaded twice.
  async readShared(offset, length) {
    if (offset >= this.size) return new ArrayBuffer(0);
    const endB = Math.min(this.size, offset + length);
    const first = Math.floor(offset / this.BS), last = Math.floor((endB - 1) / this.BS);
    const parts = [];
    for (let i = first; i <= last; i++) parts.push(this._block(i, true));
    const bufs = await Promise.all(parts);
    const out = new Uint8Array(endB - offset);
    let pos = 0;
    for (let k = 0; k < bufs.length; k++) {
      const b = new Uint8Array(bufs[k]), bStart = (first + k) * this.BS;
      const s = Math.max(offset, bStart) - bStart, e = Math.min(endB, bStart + b.length) - bStart;
      out.set(b.subarray(s, e), pos); pos += e - s;
    }
    return out.buffer;
  }
}


// ---------- player ----------
// Keep the multi-megabyte player off the browsing path. Download only when PLAY/RESUME is pressed.
let playerLib = null;
function loadPlayerLib() {
  return playerLib ||= import('https://cdn.jsdelivr.net/npm/movi-player@0.4.1/dist/element.js').catch(e => { playerLib = null; throw e; });
}
let player = null, saveTimer = 0, current = null;
// Fetch the ~11 MB engine when a viewer shows intent (opens a film, touches PLAY), never at site startup.
function warmPlayer() {
  if (navigator.connection?.saveData) return;
  loadPlayerLib().catch(() => {});
}
function savePosition() {
  if (player && current && player.duration && player.currentTime > 5) LS.set('pos:' + current.f.id, { t: player.currentTime, d: player.duration, at: Date.now() });
}
function nextEpisode(it, f) {
  if (it.parsed.kind !== 'series') return null;
  const i = it.files.indexOf(f);
  return i >= 0 ? it.files[i + 1] || null : null;
}
// iPhone Safari can only put a <video> into its own fullscreen player; movi paints to a canvas (that is how it plays
// MKV/HEVC), so on iPhone it fills the screen with CSS instead and turns a landscape film 90° on its side.
// Keep the picture upright and letterboxed, like iOS's own player; turning the phone gives a full landscape picture.
function keepFullscreenUpright(el) {
  el.updatePseudoFsRotation = function () { this.classList.remove('movi-pseudo-fs-rotate'); };
}
async function play(fileId, restart) {
  let it, f;
  for (const x of state.items) for (const y of x.files) if (y.id === fileId) { it = x; f = y; }
  if (!f) return;
  const lib = loadPlayerLib();                                   // download the engine while links refresh
  $('#ptitle').textContent = title(it) + (it.parsed.kind === 'series' ? ` · S${f.s}E${f.e}` : '');
  const wrap = $('#pwrap');
  wrap.innerHTML = `<div class="ploading"${it.meta?.background ? ` style="background-image:url('${esc(it.meta.background)}')"` : ''}><span class="pspinner" aria-label="Loading"></span></div>`;
  $('#player').hidden = false; document.body.style.overflow = 'hidden'; wakePlayerBar(); requestAnimationFrame(applyGlass);   // build the glass lens now that the button has a size
  if (!history.state?.player) history.pushState({ player: true }, '', location.href);  // Back closes the player
  f = await freshFile(f);
  current = { it, f };
  // External subtitles download in parallel instead of one after another.
  const subs = Promise.all(f.subs.map(s => subBlob(s).then(b => ({ s, b }), e => { console.warn('subtitle load failed', s.name, e); return null; })));
  await lib;
  await customElements.whenDefined('movi-player');
  if (current?.f !== f) return;                                  // closed or switched while loading
  const saved = LS.get('pos:' + f.id);
  const startAt = !restart && saved && saved.t > 30 && saved.t < saved.d - 60 ? saved.t : 0;
  player = document.createElement('movi-player');
  player.setAttribute('controls', ''); player.setAttribute('crossorigin', 'anonymous');
  player.setAttribute('fallback', 'native'); player.setAttribute('persist', 'volume speed subtitlelang audiolang');
  player.setAttribute('title', $('#ptitle').textContent);         // lock screen / Now Playing name
  keepFullscreenUpright(player);
  if (it.meta?.background) player.setAttribute('poster', it.meta.background);
  if (startAt) player.setAttribute('startat', startAt.toFixed(2)); // open at the saved spot, not at 0 then seek
  for (const x of await subs) {
    if (!x) continue;
    const tr = document.createElement('track');
    tr.kind = 'subtitles'; tr.label = x.b.lang.label; tr.srclang = x.b.lang.code; tr.src = x.b.url;
    if (x.b.fmt === 'srt') tr.dataset.format = 'srt';
    if (x.s === f.subs[0]) tr.default = true;
    player.appendChild(tr);
  }
  if (current?.f !== f) return;
  const fileRef = f;
  // Keep the artwork + spinner over the engine until the first frame plays (the canvas is black until then).
  const veil = wrap.querySelector('.ploading');
  const lift = () => { veil?.classList.add('done'); setTimeout(() => veil?.remove(), 400); };
  player.addEventListener('playing', lift, { once: true });
  player.addEventListener('error', lift, { once: true });
  setTimeout(lift, 20000);                                       // never leave it covering the player
  wrap.prepend(player);
  watchPlayerGlass(player);
  const odSrc = new ODSource(f, async () => { await load(true); for (const x of state.items) for (const y of x.files) if (y.id === fileRef.id) return y.url; return null; }, { resumeAt: startAt });
  player.addEventListener('playing', () => { odSrc.holdAhead = false; }, { once: true });
  player.addEventListener('playing', wakePlayerBar);          // start the hide countdown when playback (re)starts
  player.addEventListener('pause', wakePlayerBar);            // a paused video always shows the header
  player.sourceAdapter = odSrc;
  let seeked = false;
  // Safety net only: if the engine ignored startat, seek once.
  const trySeek = () => { if (!seeked && startAt && player.duration > 0) { seeked = true; if (Math.abs(player.currentTime - startAt) > 5) player.currentTime = startAt; } };
  player.addEventListener('loadedmetadata', trySeek);
  player.addEventListener('durationchange', trySeek);
  player.addEventListener('pause', savePosition);
  player.addEventListener('ended', () => {
    LS.del('pos:' + f.id);
    const next = nextEpisode(it, f);
    if (next) play(next.id, true);                               // series: continue with the next episode
  });
  clearInterval(saveTimer);
  saveTimer = setInterval(() => { if (player && !player.paused) savePosition(); }, 5000);
  setTimeout(() => { trySeek(); player?.play?.().catch(() => {}); }, 300);
}
// Keyboard skip: same step as the player's own Skip buttons.
const SKIP_SECONDS = 10;
function seekBy(seconds) {
  if (!player || !(player.duration > 0)) return;
  player.currentTime = Math.min(Math.max(0, player.currentTime + seconds), player.duration);
  toast((seconds > 0 ? '+' : '\u2212') + Math.abs(seconds) + 's', 700);
}
function togglePlay() {
  if (!player) return;
  if (player.paused) player.play?.().catch?.(() => {}); else player.pause?.();
}
function toggleMute() {
  if (!player) return;
  player.muted = !player.muted;
  toast(player.muted ? 'Muted' : 'Volume ' + Math.round(player.volume * 100) + '%', 700);
}
function changeVolume(delta) {
  if (!player) return;
  const v = Math.min(1, Math.max(0, Math.round(((Number(player.volume) || 0) + delta) * 100) / 100));
  player.volume = v;
  if (v > 0 && player.muted) player.muted = false;      // turning the volume up always unmutes
  toast('Volume ' + Math.round(v * 100) + '%', 700);
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else Promise.resolve(player?.requestFullscreen?.()).catch(() => {});   // same element the player's own button uses
}
// Space pause, F fullscreen, M mute, Up/Down volume, Left/Right skip.
const PLAYER_KEYS = {
  ArrowLeft: () => seekBy(-SKIP_SECONDS), ArrowRight: () => seekBy(SKIP_SECONDS),
  ArrowUp: () => changeVolume(0.1), ArrowDown: () => changeVolume(-0.1),
  ' ': togglePlay, f: toggleFullscreen, m: toggleMute,
};
const isSpaceKey = e => e.key === ' ' || e.code === 'Space';   // by value or by key position, so every keyboard layout works
const playerKeyTarget = e => !$('#player').hidden && !e.altKey && !e.ctrlKey && !e.metaKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !(isSpaceKey(e) && e.target.id === 'pclose');
// The header hides after 3 s without activity while the video plays; any movement, tap or key brings it back.
let playerIdleTimer = 0;
function wakePlayerBar() {
  const box = $('#player');
  box.classList.remove('idle');
  clearTimeout(playerIdleTimer);
  playerIdleTimer = setTimeout(() => {
    const bar = box.querySelector('.ptop');
    if (box.hidden || !player || player.paused || bar.matches(':hover') || box.contains(document.activeElement) && document.activeElement === $('#pclose')) return;
    box.classList.add('idle');
  }, 3000);
}
// ---------- Trailer: plays in a window over the page instead of leaving for YouTube ----------
let trailerReturnFocus = null;
function openTrailer(key, name) {
  if (!/^[\w-]{6,20}$/.test(key)) return false;
  const box = $('#trailer');
  // The page sends no referrer; YouTube embeds need one, so this frame asks for the site origin only.
  box.querySelector('.trailer-frame').innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${key}?autoplay=1&rel=0&modestbranding=1&playsinline=1" title="${esc(name ? name + ' trailer' : 'Trailer')}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  trailerReturnFocus = document.activeElement;
  box.hidden = false; document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => { applyGlass(); box.querySelector('.trailer-close').focus(); });
  return true;
}
function closeTrailer() {
  const box = $('#trailer');
  if (box.hidden) return false;
  box.querySelector('.trailer-frame').innerHTML = '';            // removing the frame stops the sound
  box.hidden = true; document.body.style.overflow = '';
  trailerReturnFocus?.focus?.(); trailerReturnFocus = null;
  return true;
}
function closePlayer(fromHistory) {
  if (!fromHistory && history.state?.player) { history.back(); return; }   // popstate finishes the close
  savePosition();
  clearInterval(saveTimer);
  try { player?.pause(); } catch {}
  $('#pwrap').innerHTML = ''; player = null; current = null;
  clearTimeout(playerIdleTimer); $('#player').classList.remove('idle'); unwatchPlayerGlass();
  $('#player').hidden = true; document.body.style.overflow = '';
  render();
}
window.addEventListener('popstate', () => { if (!$('#player').hidden) closePlayer(true); });
// Phones may freeze or kill a backgrounded tab; keep the resume point current.
document.addEventListener('visibilitychange', () => { if (document.hidden) savePosition(); });
window.addEventListener('pagehide', savePosition);
if (history.state?.player) history.replaceState(null, '', location.href); // reloaded mid-film: no stale entry


// ---------- UI helpers ----------
let toastT = 0;
function toast(msg, ms = 0) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); if (ms) toastT = setTimeout(() => { t.hidden = true; }, ms);
}
let rt = 0;
function scheduleRender() { clearTimeout(rt); rt = setTimeout(render, 400); }
const title = it => it.meta?.name || it.parsed.title;
const fmtSize = b => b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(0) + ' MB';
const fmtTime = s => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const fmtRuntime = r => { const n = parseInt(r, 10); if (!n) return r || ''; return n >= 60 ? `${Math.floor(n / 60)}h ${n % 60}m` : `${n}m`; };
const yearOf = it => String(it.meta?.year || it.parsed.year || '').slice(0, 4);
const logoOf = it => it.meta?.id ? (it.meta.logo || `https://images.metahub.space/logo/medium/${it.meta.id}/img`) : '';
const posterOf = it => it.meta?.id ? it.meta.poster : it.metaPending ? '' : it.files[0].thumb;
const bgOf = it => it.meta?.background || posterOf(it) || (it.metaPending ? '' : it.files[0].thumb) || '';
// ---------- Phone wall: TMDB's textless portrait poster ----------
// On a phone held upright a portrait poster fills the screen with its subject composed for that shape, so it can run
// behind the title and PLAY (like watched.cx) without cropping people out. Only TMDB posters with no language
// (textless) are used, so they never clash with the page's own title. Films without one keep the 16:9 layout.
const WALL_MAX_AGE = 30 * 864e5;
const phoneWallMedia = () => window.matchMedia?.('(max-width:820px) and (max-aspect-ratio:1/1)').matches;
const wallKey = it => it?.meta?.tmdbId ? 'tmdbw:' + (it.parsed?.kind === 'series' ? 'tv' : 'movie') + ':' + it.meta.tmdbId : '';
function wallOf(it) {
  const c = wallKey(it) && LS.get(wallKey(it));
  return c && typeof c.u === 'string' ? c.u : '';
}
function bestWall(images) {
  const list = (images?.posters || []).filter(p => p.iso_639_1 == null && p.file_path && p.height >= 750 && p.width < p.height);
  list.sort((x, y) => (y.vote_average || 0) - (x.vote_average || 0) || (y.vote_count || 0) - (x.vote_count || 0) || (y.height || 0) - (x.height || 0));
  return list[0] ? 'https://image.tmdb.org/t/p/w780' + list[0].file_path : '';
}
const wallPending = new Set();
async function ensureWalls() {
  const key = LS.get('tmdb:key');
  if (!key || !phoneWallMedia()) return;
  const wanted = [...new Set([...document.querySelectorAll('.bg[data-wall-key]')].map(el => el.dataset.wallKey))];
  for (const k of wanted) {
    const it = state.items.find(x => x.key === k), ck = wallKey(it);
    if (!ck || wallPending.has(ck)) continue;
    const c = LS.get(ck);
    if (c && Date.now() - (c.t || 0) < WALL_MAX_AGE) continue;
    wallPending.add(ck);
    try {
      const res = await fetch(`${TMDB_API}/${it.parsed.kind === 'series' ? 'tv' : 'movie'}/${it.meta.tmdbId}/images?api_key=${key}&include_image_language=null`);
      if (res.ok) LS.set(ck, { u: bestWall(await res.json()), t: Date.now() });   // '' = checked, none: keep the 16:9 layout
    } catch {} finally { wallPending.delete(ck); }
  }
  applyWalls();
}
function applyWalls() {
  document.querySelectorAll('.bg[data-wall-key]').forEach(el => {
    const it = state.items.find(x => x.key === el.dataset.wallKey), u = it && !el.classList.contains('art-tall') ? wallOf(it) : '';
    if (u) el.style.setProperty('--wall', `url("${u}")`); else el.style.removeProperty('--wall');
    el.classList.toggle('has-wall', !!u);
  });
  const slide = document.querySelector('.slide.on'); if (slide) requestAnimationFrame(() => { layoutLightArtwork(); updateNavContrast(); });
}
function tmdbPath(u) {
  return (String(u || '').match(/\/t\/p\/[^/]+(\/.+)$/) || [])[1] || '';
}
// True when the page picture is really the poster (TMDB has no backdrop): it is tall, so it is used as a full wall.
function artIsPoster(it) {
  const p = tmdbPath(it.meta?.poster), b = tmdbPath(bgOf(it));
  return !!p && p === b;
}
const artCandidates = it => [...new Set([it.meta?.background, posterOf(it), it.files[0].thumb].filter(Boolean))];
const enc = k => encodeURIComponent(k);
function quality(f) {
  const n = f.name; const w = f.video?.width || 0;
  if (/2160p|4k|uhd/i.test(n) || w >= 3000) return '4K';
  if (/1080p/i.test(n)) return '';
  if (/720p/i.test(n) || (w && w < 1300)) return '720p';
  return '';
}
function progressOf(it) {
  let best = null;
  for (const f of it.files) { const p = LS.get('pos:' + f.id); if (p && (!best || p.at > best.at)) best = { ...p, f }; }
  return best;
}
const I = {
  yt: '<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="4" fill="#ff0033" stroke="none"/><path d="M10 9v6l5-3z" fill="#fff" stroke="none"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z"/></svg>',
  star: '<svg class="star" viewBox="0 0 24 24"><path d="m12 2.8 2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3L2.9 9.5l6.3-.9z"/></svg>',
  cal: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  restart: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v5h5"/></svg>',
};
function metaRow(it, en = false) {
  const m = it.meta || {}, g = (m.genres || [])[0];
  const q = quality(it.files[0]);
  const parts = [];
  if (m.rating) parts.push(`<span>${I.star}${esc(m.rating)}</span>`);
  if (yearOf(it)) parts.push(`<span>${I.cal}${esc(yearOf(it))}</span>`);
  if (g) parts.push(`<span>${esc(g)}</span>`);
  if (it.parsed.kind === 'series') parts.push(`<span>${it.files.length} episodes</span>`);
  if (q) parts.push(`<span class="tag">${q}</span>`);
  return `<div class="metarow">${parts.join('<span class="dot"></span>')}</div>`;
}
function titleBlock(it, big) {
  const logo = logoOf(it);
  return logo
    ? `<img class="logo" src="${esc(logo)}" alt="${esc(title(it))}" onerror="this.outerHTML='<h1 class=&quot;tname&quot;>'+this.alt.replace(/</g,'&amp;lt;')+'</h1>'">`
    : `<h1 class="tname">${esc(title(it))}</h1>`;
}
function card(it, opts = {}) {
  const pr = progressOf(it), f = it.files[0], q = quality(f);
  const img = opts.wide ? bgOf(it) : posterOf(it);
  const pct = pr && pr.d ? pr.t / pr.d * 100 : 0;
  return `<a class="card" href="#/t/${enc(it.key)}"${opts.related ? ` data-genres="${esc(JSON.stringify(it.meta?.genres || []))}" title="${esc(title(it) + ' · ' + (it.meta?.genres || []).join(', '))}"` : ''}>
    <div class="pos"><div class="ph">${opts.wide ? '' : esc(title(it))}</div>${img ? `<img loading="lazy" src="${esc(img)}" alt="${esc(title(it))}" data-fb="${esc(f.thumb || '')}" onerror="if(this.src!==this.dataset.fb)window.cofilmPosterFailed?.(this);if(this.dataset.fb&&this.src!==this.dataset.fb){this.src=this.dataset.fb}else{this.remove()}">` : ''}
      ${q ? `<span class="q">${q}</span>` : ''}
      ${pct > 1 ? `<div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>` : ''}</div>
    ${opts.caption ? `<div class="cap">${esc(title(it))}</div><div class="sub">${esc(opts.caption)}</div>` : ''}</a>`;
}
function row(name, list, opts = {}) {
  if (!list.length) return '';
  if (opts.advance) {
    const key = opts.key || 'similar', railId = 'related-' + key.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return `<section class="row recommend-section" data-row-key="${esc(key)}" data-primary-genre="${esc(opts.genre || '')}"><h2>${esc(name)}</h2><div class="recommend-shell"><div class="scroller" id="${railId}" tabindex="0" role="region" aria-label="${esc(name)}">${list.map(it => card(it, { related: true })).join('')}</div><button type="button" class="recommend-prev lg" data-recommend-prev aria-label="Previous in ${esc(name)}" aria-controls="${railId}" title="Previous in ${esc(name)}" disabled><svg viewBox="0 0 24 24"><path d="m14 6-6 6 6 6"/></svg></button><button type="button" class="recommend-next lg" data-recommend-next aria-label="Next in ${esc(name)}" aria-controls="${railId}" title="Next in ${esc(name)}"><svg viewBox="0 0 24 24"><path d="m10 6 6 6-6 6"/></svg></button></div></section>`;
  }

  const railId = 'home-row-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `<section class="row browse-section ${opts.wide ? 'wide' : ''}" data-row-key="${esc(name)}"><h2>${esc(name)}</h2><div class="browse-shell"><div class="scroller" id="${railId}" tabindex="0" role="region" aria-label="${esc(name)}">${list.map(it => card(it, { wide: opts.wide, caption: opts.caption?.(it) })).join('')}</div><button type="button" class="browse-prev lg" data-row-prev aria-label="Previous in ${esc(name)}" aria-controls="${railId}" title="Previous in ${esc(name)}" disabled><svg viewBox="0 0 24 24"><path d="m14 6-6 6 6 6"/></svg></button><button type="button" class="browse-next lg" data-row-next aria-label="Next in ${esc(name)}" aria-controls="${railId}" title="Next in ${esc(name)}"><svg viewBox="0 0 24 24"><path d="m10 6 6 6-6 6"/></svg></button></div></section>`;

}
// Page colour layer. A small TMDB image is plenty once it is blurred; the new image is decoded BEFORE the fade starts,
// then the two layers cross-fade by opacity only (no per-frame re-blur, no decode during the animation).
let ambientFront = 0, ambientSrc = '', ambientToken = 0;
const ambientSource = url => url ? String(url).replace(/\/t\/p\/(?:w\d+|original)\//, '/t/p/w300/') : '';
function setAmbient(url) {
  const src = ambientSource(url);
  if (src === ambientSrc) return;
  ambientSrc = src;
  const layers = $('#ambient').querySelectorAll('.amb'), token = ++ambientToken;
  if (!src) { layers.forEach(l => l.classList.remove('on')); return; }
  const next = layers[1 - ambientFront], prev = layers[ambientFront];
  const show = () => {
    if (token !== ambientToken) return;                           // a newer image was requested meanwhile
    next.style.backgroundImage = `url("${src}")`;
    next.style.zIndex = '1'; prev.style.zIndex = '0';
    next.classList.add('on');
    ambientFront = 1 - ambientFront;
    setTimeout(() => { if (token === ambientToken) prev.classList.remove('on'); }, 1000);
  };
  const img = new Image(); img.src = src;
  (img.decode ? img.decode() : Promise.resolve()).then(show, show);
}

// ---------- views ----------
const hero = { idx: 0, timer: 0, list: [] };
function viewHome() {
  const items = state.items;
  const byAdded = [...items].sort((a, b) => b.added - a.added);
  hero.list = byAdded.filter(it => it.meta?.background).slice(0, 6);
  if (hero.idx >= hero.list.length) hero.idx = 0;
  const cw = items.map(it => ({ it, p: progressOf(it) })).filter(x => x.p && x.p.t > 30 && x.p.t < x.p.d - 120).sort((a, b) => b.p.at - a.p.at).map(x => x.it);
  const rated = items.filter(it => parseFloat(it.meta?.rating) >= 7).sort((a, b) => parseFloat(b.meta.rating) - parseFloat(a.meta.rating));
  const slides = hero.list.map((it, i) => `<div class="slide ${i === hero.idx ? 'on' : ''}" data-i="${i}" aria-hidden="${i !== hero.idx}" ${i === hero.idx ? '' : 'inert'}>
      <div class="bg${artIsPoster(it) ? ' art-tall' : !artIsPoster(it) && wallOf(it) ? ' has-wall' : ''}" data-wall-key="${esc(it.key)}" data-art="${esc(JSON.stringify(artCandidates(it)))}" style="background-image:url('${esc(bgOf(it))}')${!artIsPoster(it) && wallOf(it) ? `;--wall:url('${esc(wallOf(it))}')` : ''}"></div>
      <a class="hero-link" href="#/t/${enc(it.key)}" aria-label="View details for ${esc(title(it))}"></a>
      <div class="hcontent">${titleBlock(it)}${metaRow(it)}<p class="desc">${esc(it.meta?.desc || '')}</p>
        <div class="hbtns"><button class="pill" data-play-item="${esc(it.key)}">${I.play}${progressOf(it)?.t > 30 ? 'RESUME' : 'PLAY'}</button>
        </div></div></div>`).join('');
  return `${hero.list.length ? `<section class="hero">${slides}
      <div class="dots" data-hero-controls role="group" aria-label="Slideshow navigation">${hero.list.map((_, i) => `<button type="button" data-slide="${i}" class="${i === hero.idx ? 'on' : ''}" aria-current="${i === hero.idx}" aria-label="Slide ${i + 1}"></button>`).join('')}</div></section>` : '<div style="height:130px"></div>'}
    <div class="rows" ${hero.list.length ? '' : 'style="margin-top:0"'}>
      ${row('Continue watching', cw, { wide: true, caption: it => { const p = progressOf(it); return `${fmtTime(p.d - p.t)} left`; } })}
      ${row('Recently added', byAdded.slice(0, 20))}
      ${row('Top rated', rated)}
      ${!items.length ? '<p class="empty">No titles loaded yet.</p>' : ''}
    </div>`;
}
// ---------- Movies page: sort and filter (remembered on this device) ----------
const MOVIE_VIEW_DEFAULT = { sort: 'added', genre: '', decade: '', country: '', only4k: false, page: 1, galaxySeed: 0 };
// Every page load starts from the galaxy ring. A choice made earlier (including an old sort from before the sort control was
// removed) used to be remembered across reloads and silently kept the page on the poster grid; now it lasts only for this visit.
LS.del('view:movies');
let movieGalaxyCtrl = null;
function stopMovieGalaxy() {
  movieGalaxyCtrl?.stop();
  movieGalaxyCtrl = null;
}
const movieView = () => ({ ...MOVIE_VIEW_DEFAULT, ...LS.get('view:movies', {}) });
const countriesOf = it => String(it.meta?.country || '').split(',').map(s => s.trim()).filter(Boolean);
function movieFacts(it) {
  return { it, title: title(it), year: parseInt(yearOf(it), 10) || null, countries: countriesOf(it), genres: it.meta?.genres || [], rating: parseFloat(it.meta?.rating) || 0, is4k: quality(it.files[0]) === '4K', added: it.added };
}
// Keep the keyboard position after the page redraws. A <select> must never be focused from code on a touch screen:
// iPhone Safari answers by opening its picker (that was the stray "Recently Added" popup after Reset).
function keepFocus(selector) {
  const el = selector && $(selector);
  if (!el) return;
  if (el.tagName === 'SELECT' && window.matchMedia?.('(hover: none)').matches) return;
  el.focus();
}
function setMovieView(patch, focus) {
  const prev = movieView();
  const next = { ...prev, ...patch };
  for (const k of ['genre', 'decade', 'country', 'only4k', 'sort']) {
    if (k in patch && patch[k] !== prev[k]) next.page = 1;
  }
  LS.set('view:movies', next);
  render();
  keepFocus(focus);
}
// The controls sit directly in ONE liquid-glass bar. Genre, Decade and Country open a glass list above the bar;
// 4K only and Shuffle ring are plain buttons. `movieMenuOpen` is the name of the open list, or ''.
let movieMenuOpen = '';
function movieChoice(name, label, options, value) {
  return `<div class="movie-menu-group" data-movie-group="${name}"${movieMenuOpen === name ? '' : ' hidden'}>
    <p class="movie-menu-title">${esc(label)}</p>
    <div class="movie-menu-options" role="listbox" aria-label="${esc(label)}">
      ${options.map(([v, t]) => `<button type="button" class="movie-menu-opt${String(v) === String(value) ? ' on' : ''}" role="option" aria-selected="${String(v) === String(value)}" data-movie-pick="${esc(name)}" data-movie-value="${esc(v)}">${esc(t)}</button>`).join('')}
    </div></div>`;
}
function syncMovieMenu() {
  const dock = document.querySelector('[data-movie-dock]');
  if (!dock) return;
  dock.querySelector('[data-movie-sheet]').hidden = !movieMenuOpen;
  dock.querySelectorAll('[data-movie-group]').forEach(g => { g.hidden = g.dataset.movieGroup !== movieMenuOpen; });
  dock.querySelectorAll('[data-movie-panel]').forEach(b => { const on = b.dataset.moviePanel === movieMenuOpen; b.setAttribute('aria-expanded', String(on)); b.classList.toggle('open', on); });
  document.querySelector('.movies-page')?.classList.toggle('menu-open', !!movieMenuOpen);
  requestAnimationFrame(applyGlass);          // the list has a size only once it is shown
}
function movieDock(view, genres, decades, countries, meta) {
  const active = moviesFlowActive(view);      // something is chosen: Reset is offered
  const chip = (name, text) => `<button type="button" class="movie-chip${movieMenuOpen === name ? ' open' : ''}${view[name] ? ' set' : ''}" data-movie-panel="${name}" aria-haspopup="listbox" aria-expanded="${movieMenuOpen === name}">${esc(text)}</button>`;
  const pages = meta.pages > 1
    ? `<div class="movie-dock-pages">
      <button type="button" class="movie-dock-page" data-movie-page="prev" aria-label="Previous page"${meta.page <= 1 ? ' disabled' : ''}>\u2039</button>
      <span class="movie-dock-page-label">Page ${meta.page} of ${meta.pages}</span>
      <button type="button" class="movie-dock-page" data-movie-page="next" aria-label="Next page"${meta.page >= meta.pages ? ' disabled' : ''}>\u203a</button>
    </div>` : '';
  return `<div class="movie-dock" data-movie-dock>
    <div class="movie-menu lg" data-movie-sheet role="group" aria-label="Choose"${movieMenuOpen ? '' : ' hidden'}><div class="movie-menu-scroll">
      ${movieChoice('genre', 'Genre', [['', 'All genres'], ...genres.map(g => [g, g])], view.genre)}
      ${movieChoice('decade', 'Decade', [['', 'All decades'], ...decades.map(d => [d, d + 's'])], view.decade)}
      ${movieChoice('country', 'Country', [['', 'All countries'], ...countries.map(c => [c, c])], view.country)}
    </div></div>
    <div class="movie-bar lg" role="group" aria-label="Filter movies">
      ${chip('genre', view.genre || 'All genres')}
      ${chip('decade', view.decade ? view.decade + 's' : 'All decades')}
      ${chip('country', view.country || 'All countries')}
      <button type="button" class="movie-chip${view.only4k ? ' open' : ''}" data-movie-4k aria-pressed="${!!view.only4k}">4K only</button>
      ${meta.flow ? '' : '<button type="button" class="movie-chip" data-galaxy-reshuffle>Shuffle ring</button>'}
      ${active ? '<button type="button" class="movie-chip movie-chip-reset" data-movie-reset>Reset</button>' : ''}
    </div>
    <span class="movie-ind lg" data-movie-ind aria-hidden="true"></span>
    ${pages}
  </div>`;
}
// One liquid-glass drop slides under the bar's controls (iOS 26 style): it rests on the open / pressed control and
// follows the pointer or keyboard focus; the other controls carry no boxes of their own.
function placeMovieInd(target) {
  const dock = document.querySelector('[data-movie-dock]');
  const ind = dock?.querySelector('[data-movie-ind]'), bar = dock?.querySelector('.movie-bar');
  if (!ind || !bar) return;
  const t = target || bar.querySelector('.movie-chip.open');
  if (!t || !t.offsetWidth) { ind.classList.remove('show'); return; }
  const first = !ind.classList.contains('show');
  if (first) ind.style.transition = 'none';
  const x = bar.offsetLeft + t.offsetLeft - 3, y = bar.offsetTop + t.offsetTop - 3, w = t.offsetWidth + 6, h = t.offsetHeight + 6;
  ind.style.width = w + 'px'; ind.style.height = h + 'px'; ind.style.transform = `translate(${x}px,${y}px)`;
  ind.classList.add('show');
  if (first) { void ind.offsetWidth; ind.style.transition = ''; }
}
function startMovieGalaxy(picked) {
  stopMovieGalaxy();
  const viewport = document.getElementById('movieGalaxyViewport');
  if (!viewport || !picked.length) return;
  movieGalaxyCtrl = initMovieGalaxy(viewport, picked, {
    posterUrl: it => posterOf(it) || it.files[0]?.thumb || '',
    onOpen: key => { location.hash = '#/t/' + enc(key); },
  });
}
function viewList(kind) {
  const all = state.items.filter(it => it.parsed.kind === kind);
  const newest = [...all].sort((a, b) => b.added - a.added)[0];
  setAmbient(newest ? bgOf(newest) : '');
  const caption = it => [yearOf(it), it.meta?.runtime].filter(Boolean).join(' · ');
  if (kind !== 'movie') {
    const list = [...all].sort((a, b) => b.added - a.added);
    return `<div class="page"><h1>Shows <span style="color:var(--dim);font-size:18px">${list.length}</span></h1>
    <div class="grid">${list.map(it => card(it, { caption: caption(it) })).join('') || '<p class="empty">Nothing here yet</p>'}</div></div>`;
  }
  const facts = all.map(movieFacts);
  const genres = [...new Set(facts.flatMap(f => f.genres))].sort((x, y) => x.localeCompare(y));   // A to Z, no counts
  const decades = [...new Set(facts.map(f => decadeOf(f.year)).filter(Boolean))].sort((a, b) => b - a);
  const countries = [...new Set(facts.flatMap(f => f.countries))].sort((a, b) => a.localeCompare(b));
  const saved = movieView();
  // A saved choice may no longer exist after the library changes; ignore it instead of showing an empty page.
  const view = { ...saved, genre: genres.includes(saved.genre) ? saved.genre : '', decade: decades.includes(Number(saved.decade)) ? saved.decade : '', country: countries.includes(saved.country) ? saved.country : '' };
  const filtered = sortMovieFacts(filterMovieFacts(facts, view), view.sort).map(f => f.it);
  // Touch screens keep the ordinary poster grid: the 3D ring is mouse-driven (no finger drag, and it blocks scrolling).
  const flow = moviesFlowActive(view);   // the ring now also runs on phones (finger drag)
  let viewResolved = view;
  if (!flow && !view.galaxySeed) {   // (never on touch screens)
    viewResolved = { ...view, galaxySeed: Date.now() };
    LS.set('view:movies', viewResolved);
  }
  const slice = moviePageSlice(filtered, viewResolved.page);
  const pool = all.filter(it => posterOf(it) || it.files[0]?.thumb);
  const galaxyPick = pickGalaxyMovies(pool, viewResolved.galaxySeed || 1);
  const galaxyPickKeys = galaxyPick.map(it => it.key).join(',');
  const flowBlock = `<div class="movies-flow"><div class="grid">${slice.items.map(it => card(it, { caption: caption(it) })).join('') || '<p class="empty">No movies match these filters.</p>'}</div></div>`;
  const galaxyBlock = `<div class="movies-galaxy" data-galaxy-keys="${esc(galaxyPickKeys)}">
    <div class="galaxy-viewport" id="movieGalaxyViewport"><div class="galaxy-ring" id="movieGalaxyRing"></div></div>
  </div>`;
  return `<div class="page movies-page${flow ? ' movies-page--flow' : ' movies-page--galaxy'}${movieMenuOpen ? ' menu-open' : ''}">
    <h1 class="sr-only">Movies</h1>
    <div class="movies-stage">${flow ? flowBlock : galaxyBlock}</div>
    ${movieDock(viewResolved, genres, decades, countries, { flow, page: slice.page, pages: slice.pages, total: slice.total })}</div>`;
}
// Phone search page: the pill nav hides while the field is focused or holds text; it comes back when the field is empty and idle.
function syncSearchNav() {
  const q = document.getElementById('sq'), root = document.documentElement;
  root.classList.toggle('search-typing', !!q && routeInfo().name === 'search' && !(q.value === '' && document.activeElement !== q && !root.classList.contains('search-fresh')));
}
// The pill nav is hidden as soon as the Search page opens; it returns once the field is emptied or left empty.
document.addEventListener('focusin', e => { if (e.target.id === 'sq') { document.documentElement.classList.remove('search-fresh'); document.documentElement.classList.add('search-typing'); } });
document.addEventListener('focusout', e => { if (e.target.id === 'sq' && !e.target.value) { document.documentElement.classList.remove('search-fresh', 'search-typing'); } });
document.addEventListener('input', e => { if (e.target.id === 'sq') document.documentElement.classList.toggle('search-typing', !!e.target.value); });
window.addEventListener('hashchange', () => { const on = routeInfo().name === 'search'; document.documentElement.classList.toggle('search-typing', on); document.documentElement.classList.toggle('search-fresh', on); });
// ---------- TMDB credits (cast photos) ----------
const TMDB_IMG = 'https://image.tmdb.org/t/p/w300';
const creditsPending = new Set();
function creditsOf(it) {
  const id = it.meta?.id; if (!id) return null;
  const c = LS.get('tmdbc:' + id);
  if (c?.v === 3 && Date.now() - (c.t || 0) < 7 * 864e5) return c;
  const key = LS.get('tmdb:key');
  if (key && !creditsPending.has(id)) {
    creditsPending.add(id);
    (async () => {
      try {
        let hit, f = { movie_results: [], tv_results: [] };
        if (it.meta.tmdbId) { hit = { id: it.meta.tmdbId }; if (it.parsed.kind === 'series') f.tv_results = [hit]; else f.movie_results = [hit]; }
        else { f = await (await fetch(`https://api.themoviedb.org/3/find/${id}?api_key=${key}&external_source=imdb_id`)).json(); hit = (f.movie_results || [])[0] || (f.tv_results || [])[0]; }
        if (!hit) { LS.set('tmdbc:' + id, { v: 3, cast: [], crew: [], t: Date.now() }); return; }
        const tv = !(f.movie_results || [])[0];
        const res = await fetch(`https://api.themoviedb.org/3/${tv ? 'tv' : 'movie'}/${hit.id}/${tv ? 'aggregate_credits' : 'credits'}?api_key=${key}`);
        if (!res.ok) throw new Error('Credits returned ' + res.status);
        const cr = await res.json();
        const cast = (cr.cast || []).map(p => ({ i: p.id, n: p.name, r: p.character || p.roles?.[0]?.character || '', p: p.profile_path }));
        const crew = (cr.crew || []).filter(p => p.job === 'Director' || p.jobs?.some(j => j.job === 'Director')).map(p => ({ i: p.id, n: p.name, r: 'Director', p: p.profile_path }));
        LS.set('tmdbc:' + id, { v: 3, cast, crew, t: Date.now() });
        delete it._st; // New cast/roles must be searchable without a reload.
        if (location.hash.includes(enc(it.key))) render();
      } catch (e) { console.warn('tmdb', e); }
      finally { creditsPending.delete(id); }
    })();
  }
  return c || null;
}

// ---------- Person page: TMDB biography + this person's titles that are in the library ----------
const personPending = new Set(), personFailed = new Set(), bioOpen = new Set();
function personOf(id) {
  const c = LS.get('tmdbp:' + id);
  if (c?.v === 1 && Date.now() - (c.t || 0) < 7 * 864e5) return c;
  const key = LS.get('tmdb:key');
  if (key && !personPending.has(id) && !personFailed.has(id)) {
    personPending.add(id);
    (async () => {
      try {
        const res = await fetch(`${TMDB_API}/person/${id}?api_key=${key}&append_to_response=combined_credits`);
        if (!res.ok) throw new Error('Person returned ' + res.status);
        LS.set('tmdbp:' + id, compactPerson(await res.json()));
      } catch (e) { console.warn('person', e); personFailed.add(id); }
      finally { personPending.delete(id); const r = routeInfo(); if (r.name === 'person' && r.arg === id) render(); }
    })();
  }
  return c || null;                                              // an expired record is shown while it refreshes
}
function viewPerson(id) {
  const back = '<button type="button" class="back-link" data-back>\u2190 Back</button>';
  if (!/^\d+$/.test(id)) return `<div class="page person-page">${back}<p class="empty">Person not found.</p></div>`;
  if (!LS.get('tmdb:key')) return `<div class="page person-page">${back}<p class="empty">Add a TMDB key in Settings to see cast details.</p></div>`;
  const p = personOf(id);
  if (!p) return `<div class="page person-page">${back}<p class="empty">${personFailed.has(id) ? 'Could not load this person. <button type="button" class="back-link" data-person-retry="' + esc(id) + '">Try again</button>' : 'Loading\u2026'}</p></div>`;
  const items = state.items.map(it => ({ key: it.key, type: it.parsed.kind === 'series' ? 'tv' : 'movie', tmdbId: it.meta?.tmdbId }));
  const byKey = new Map(state.items.map(it => [it.key, it]));
  const mine = libraryMatches(items, p).map(x => ({ it: byKey.get(x.key), role: x.role })).sort((x, y) => (parseInt(yearOf(y.it), 10) || 0) - (parseInt(yearOf(x.it), 10) || 0));
  setAmbient(mine[0] ? bgOf(mine[0].it) : '');
  const open = bioOpen.has(id), long = p.bio.length > 700;
  const bio = p.bio ? `<div class="person-bio${long && !open ? ' clamped' : ''}">${p.bio.split(/\n{2,}/).map(t => '<p>' + esc(t) + '</p>').join('')}</div>${long ? `<button type="button" class="bio-toggle" data-bio-toggle="${esc(id)}" aria-expanded="${open}">${open ? 'Show less' : 'Read more'}</button>` : ''}` : '';
  const photo = p.photo ? `<img class="face" src="https://image.tmdb.org/t/p/w500${esc(p.photo)}" alt="${esc(p.name)}">` : castPlaceholder(p.name);
  return `<div class="page person-page">${back}
    <div class="person-head"><div class="person-photo person">${photo}</div>
      <div class="person-info"><h1>${esc(p.name)}</h1>${lifeLine(p) ? `<div class="person-meta">${esc(lifeLine(p))}</div>` : ''}${bio}</div></div>
    <section class="row"><h2>In your library</h2>
      <div class="grid">${mine.map(x => card(x.it, { caption: [yearOf(x.it), x.role].filter(Boolean).join(' \u00b7 ') })).join('') || '<p class="empty">None of this person\u2019s titles are in your library yet.</p>'}</div></section></div>`;
}

// ---------- external ratings (IMDb / Rotten Tomatoes / Douban), fetched by a GitHub Action, encrypted ----------
let ratingsKey = null;
async function rKey() {
  if (ratingsKey) return ratingsKey;
  const link = LS.get('od:link'); if (!link) return null;
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('cofilm-ratings:' + link.trim()));
  ratingsKey = {
    aes: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']),
    hmac: await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
  };
  return ratingsKey;
}
async function loadRatings() {
  try {
    const k = await rKey(); if (!k) return;
    const f = await (await fetch('ratings.enc.json?t=' + Date.now(), { cache: 'no-store' })).json();
    const b = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b(f.iv) }, k.aes, b(f.data));
    state.ratings = JSON.parse(new TextDecoder().decode(plain)).items || {};
    state.rHash = {};
    render();
    applyErotic();
  } catch (e) { console.warn('ratings', e); state.ratings ||= {}; scheduleRender(); }
}
async function ratingHash(id) {
  const k = await rKey(); if (!k) return null;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k.hmac, new TextEncoder().encode(id)));
  return [...sig].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
function ratingsOf(it) {
  const id = it.meta?.id; if (!id || !/^tt/.test(id) || !state.ratings) return null;
  if (!state.rHash) state.rHash = {};
  if (!(id in state.rHash)) { state.rHash[id] = null; ratingHash(id).then(h => { state.rHash[id] = h; if (location.hash.includes(enc(it.key))) render(); }); return null; }
  return state.rHash[id] ? state.ratings[state.rHash[id]] || null : null;
}

// ---------- Erotic genre: films flagged by the ratings job (Douban "erotic" genre or TMDB erotic/softcore tags)
// plus manual overrides (overrides.json holds hashed IMDb IDs, so it does not reveal titles). Erotic films get only this one genre.
let overrides = null;
async function applyErotic() {
  if (!state.ratings) return;
  if (!overrides) { try { overrides = await (await fetch('overrides.json?t=' + Date.now(), { cache: 'no-store' })).json(); } catch { overrides = {}; } }
  const add = new Set(overrides.erotic || []), remove = new Set(overrides.notErotic || []);
  let changed = false;
  for (const it of state.items) {
    const m = it.meta; if (!m || !/^tt/.test(m.id || '')) continue;
    const h = await ratingHash(m.id);
    const ero = !remove.has(h) && (add.has(h) || !!state.ratings[h]?.ero);
    if (ero && !(m.genres.length === 1 && m.genres[0] === 'Erotic')) { it.meta = { ...m, origGenres: m.origGenres || m.genres, genres: ['Erotic'] }; changed = true; }
    if (!ero && m.origGenres) { it.meta = { ...m, genres: m.origGenres, origGenres: undefined }; changed = true; }
  }
  if (changed) render();
}

// Legacy metadata did not identify its rating source. Never label a TMDB fallback as IMDb.
const legacyImdbRatings = new Map();
function imdbRatingOf(it, ratings) {
  if (ratings.imdb?.v) return ratings.imdb.v;
  const m = it.meta || {}, id = m.id;
  if (Object.hasOwn(m, 'imdbRating')) return m.imdbRating;
  if (!/^tt\d+$/.test(id || '') || !state.ratings) return null;
  if (!legacyImdbRatings.has(id)) {
    legacyImdbRatings.set(id, null);
    fetch(`${META}/meta/${it.parsed.kind}/${id}.json`).then(r => { if (!r.ok) throw Error('IMDb supplement returned ' + r.status); return r.json(); }).then(j => {
      const value = j.meta?.imdbRating, n = Number(value);
      legacyImdbRatings.set(id, n > 0 && n <= 10 ? String(value) : null);
      if (location.hash.includes(enc(it.key))) scheduleRender();
    }).catch(e => console.warn('IMDb supplement', e));
  }
  return legacyImdbRatings.get(id);
}

function ratingsHtml(it) {
  const m = it.meta || {}, r = ratingsOf(it) || {}, id = /^tt/.test(m.id || '') ? m.id : '';
  const q = encodeURIComponent(m.name || it.parsed.title);
  const imdbU = r.imdb?.u || (id ? `https://www.imdb.com/title/${id}/` : `https://www.imdb.com/find/?q=${q}`);
  const imdbV = imdbRatingOf(it, r);
  const rtU = r.rt?.u || `https://www.rottentomatoes.com/search?search=${q}`;
  const dbU = r.db?.u || `https://search.douban.com/movie/subject_search?search_text=${id || q}`;
  const ICON = {
    imdb: '<b class="ic imdbmark">IMDb</b>',
    fresh: '<svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="13.6" r="9.2" fill="#fa320a"/><ellipse cx="8.6" cy="10.6" rx="2.2" ry="1.3" fill="#ff8a6b" opacity=".55" transform="rotate(-30 8.6 10.6)"/><path fill="#00912d" d="M12.1 5.6c-.9-1.9-2.9-2.8-4.9-2.4 1.6.6 2.6 1.6 3 2.6-1.9-.9-4-.6-5.4.7 2-.1 3.6.4 4.6 1.4-1 .7-1.6 1.9-1.5 3.2 1-1.1 2.3-1.7 3.6-1.6.9 1.1 2.2 1.6 3.6 1.5-1-.8-1.4-1.9-1.4-2.9 1.4-.2 2.9.2 4 1.1-.4-1.7-1.8-2.9-3.4-3.3.8-.7 1.9-1 3-1-1.5-.9-3.5-.7-4.7.3-.1-.6-.3-1.1-.5-1.6z"/></svg>',
    rotten: '<svg viewBox="0 0 24 24" class="ic"><path fill="#0fc755" d="M12 2.6c.9 0 1.2 1.7 2 2.1.9.4 2.2-.8 3-.2.7.6-.3 2 .1 2.8.4.9 2.3.8 2.6 1.7.3.9-1.3 1.6-1.3 2.6 0 .9 1.7 1.6 1.4 2.5-.3.9-2.2.6-2.7 1.4-.5.8.5 2.4-.2 3-.7.6-2.1-.6-3-.2-.8.4-1 2.3-1.9 2.3s-1.2-1.8-2-2.2c-.9-.4-2.3.8-3 .2-.8-.6.2-2.1-.2-2.9-.5-.8-2.4-.6-2.7-1.5-.3-.9 1.4-1.6 1.4-2.5S2.1 11.1 2.4 10.2c.3-.9 2.2-.8 2.6-1.6.4-.8-.6-2.3.1-2.9.7-.6 2.1.6 3 .2.8-.4 1-2.3 1.9-2.3z"/></svg>',
    douban: '<svg viewBox="0 0 24 24" class="ic"><rect width="24" height="24" rx="5.5" fill="#00b51d"/><text x="12" y="17.6" text-anchor="middle" font-family="PingFang SC,Hiragino Sans GB,Microsoft YaHei,sans-serif" font-weight="700" font-size="15" fill="#fff">\u8c46</text></svg>',
  };
  const rtPct = parseInt(r.rt?.v || '', 10);
  const a = (cls, icon, label, val, url) => `<a class="rate ${cls}" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(label)}" aria-label="${esc(label + (val ? ': ' + val : ''))}">${icon}<span>${esc(val || '–')}</span></a>`;
  const dbLabel = r.db?.status === 'unrated' ? 'Douban: No rating yet' : r.db?.status === 'unavailable' ? (r.db?.v ? 'Douban: Last available rating; refresh unavailable' : 'Douban: Rating temporarily unavailable') : r.db?.v ? 'Douban' : r.db?.u ? 'Douban: Rating not yet verified' : 'Douban: Search for this title';
  return `<div class="rates">${a('imdb', ICON.imdb, 'IMDb', imdbV ? imdbV : '', imdbU)}${a('rt', isNaN(rtPct) || rtPct >= 60 ? ICON.fresh : ICON.rotten, 'Rotten Tomatoes (critics)', r.rt?.v || '', rtU)}${a('db', ICON.douban, dbLabel, r.db?.v || '', dbU)}</div>`;
}


// ---------- Trailer (TMDB videos -> YouTube) ----------
const trailerPending = new Set();
function trailerOf(it) {
  const m = it.meta; if (!m?.id) return null;
  const ck = 'tmdbt:' + m.id, c = LS.get(ck);
  if (c && Date.now() - (c.t || 0) < 7 * 864e5) return c.key ? c : { none: true };
  const key = LS.get('tmdb:key');
  if (key && m.tmdbId && !trailerPending.has(ck)) {
    trailerPending.add(ck);
    (async () => {
      let pick = null;
      try {
        const j = await (await fetch(`https://api.themoviedb.org/3/${it.parsed.kind === 'series' ? 'tv' : 'movie'}/${m.tmdbId}/videos?api_key=${key}`)).json();
        const yt = (j.results || []).filter(v => v.site === 'YouTube');
        const rank = v => (v.type === 'Trailer' ? 2 : v.type === 'Teaser' ? 1 : 0) * 10 + (v.official ? 5 : 0) + (v.iso_639_1 === 'en' ? 3 : 0);
        pick = yt.filter(v => v.type === 'Trailer' || v.type === 'Teaser').sort((a, b) => rank(b) - rank(a) || String(b.published_at).localeCompare(String(a.published_at)))[0] || null;
      } catch (e) { console.warn('trailer', e); return; }
      LS.set(ck, { key: pick?.key || null, t: Date.now() });
      if (location.hash.includes(enc(it.key))) render();
    })();
  }
  return null;
}

// A neutral portrait for missing TMDB photos, also used when an image fails to load.
function castPlaceholder(name) {
  return `<div class="face face-placeholder" role="img" aria-label="${esc(name)}: Photo unavailable"><svg viewBox="0 0 80 100" aria-hidden="true" focusable="false"><circle cx="40" cy="29" r="15"/><path d="M10 90V80c0-17 13-28 30-28s30 11 30 28v10z"/></svg></div>`;
}
document.addEventListener('error', e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.matches('.person img.face')) return;
  const holder = document.createElement('template');
  holder.innerHTML = castPlaceholder(img.alt);
  img.replaceWith(holder.content.firstElementChild);
}, true);

function viewDetail(key) {
  const it = state.items.find(x => x.key === key);
  if (!it) return '<div class="page"><p class="empty">Title not found.</p></div>';
  const m = it.meta || {}, f = it.files[0], pr = progressOf(it), isS = it.parsed.kind === 'series';
  setAmbient(bgOf(it));
  const resume = pr && pr.t > 30 && pr.t < pr.d - 60;
  const infos = [
    ['Type', isS ? 'Series' : 'Film'], ['Released', m.year || it.parsed.year], ['Runtime', fmtRuntime(m.runtime)], ['Genres', (m.genres || []).join(', ')],
    ['Ratings', '__RATINGS__'], ['Director', (m.director || []).join(', ')], ['Cast', (m.cast || []).slice(0, 4).join(', ')], ['Country', m.country],
  ].filter(x => x[1]);
  const epName = (s, e) => (m.videos || []).find(x => x.s === s && x.e === e) || {};
  const cr = creditsOf(it);
  const people = cr && (cr.cast.length || cr.crew.length)
    ? [...cr.crew, ...cr.cast]
    : [...(m.director || []).map(n => ({ n, r: 'Director' })), ...(m.cast || []).map(n => ({ n, r: '' }))];
  const primaryGenre = (m.genres || [])[0];
  const similar = primaryGenre ? state.items
    .filter(x => x !== it && x.parsed.kind === it.parsed.kind && (!m.id || x.meta?.id !== m.id) && (x.meta?.genres || [])[0] === primaryGenre)
    .map(x => {
      const shared = x.meta.genres.filter(g => m.genres.includes(g)).length;
      return { x, shared, overlap: shared / new Set([...m.genres, ...x.meta.genres]).size };
    })
    .sort((a, b) => b.shared - a.shared || b.overlap - a.overlap || (parseFloat(b.x.meta.rating) || 0) - (parseFloat(a.x.meta.rating) || 0) || b.x.added - a.x.added)
    .slice(0, 10).map(o => o.x) : [];
  const face = p => p.p
    ? `<img class="face" loading="lazy" decoding="async" src="${TMDB_IMG}${esc(p.p)}" alt="${esc(p.n)}">`
    : castPlaceholder(p.n);
  // Same director / same cast, from this library only.
  const namesFor = (x, kind) => {
    const cr = x.meta?.id ? LS.get('tmdbc:' + x.meta.id) : null;
    return kind === 'director'
      ? [...(x.meta?.director || []), ...(cr?.crew || []).filter(p => p.r === 'Director').map(p => p.n)]
      : [...(cr?.cast || []).slice(0, 10).map(p => p.n), ...(x.meta?.cast || []).slice(0, 10)];
  };
  const others = state.items.filter(x => x !== it && x.meta && (!m.id || x.meta.id !== m.id));
  const peopleRows = [];
  for (const [kind, label, limit] of [['director', 'More from', 2], ['cast', 'More with', 2]]) {
    const seen = new Set();
    for (const name of namesFor(it, kind).slice(0, kind === 'cast' ? 6 : 4)) {
      if (peopleRows.filter(r => r.kind === kind).length >= limit) break;
      const k = name.toLowerCase(); if (seen.has(k)) continue; seen.add(k);
      const list = titlesWithPerson(others, name, x => namesFor(x, kind)).slice(0, 10);
      if (list.length) peopleRows.push({ kind, name: label + ' ' + name, key: kind + '-' + name, list });
    }
  }
  const subsTxt = f.subs.length ? 'Subtitles: ' + f.subs.map(s => s.name.split('.').pop().toUpperCase()).join('/') : '';
  return `<div class="detail"><div class="bg${artIsPoster(it) ? ' art-tall' : !artIsPoster(it) && wallOf(it) ? ' has-wall' : ''}" data-wall-key="${esc(it.key)}" data-art="${esc(JSON.stringify(artCandidates(it)))}" style="background-image:url('${esc(bgOf(it))}')${!artIsPoster(it) && wallOf(it) ? `;--wall:url('${esc(wallOf(it))}')` : ''}"></div>
    <div class="dtop"><div class="dleft">${titleBlock(it)}${metaRow(it, true)}
      <p class="desc">${esc(m.desc || 'No details found for this title. Use the edit button below to fix the match.')}</p>
      <div class="hbtns">
        ${isS ? `<button class="pill" data-play="${esc((pr?.f || f).id)}">${I.play}${pr ? 'RESUME S' + pr.f.s + 'E' + pr.f.e : 'PLAY'}</button>`
              : `<button class="pill" data-play="${esc(f.id)}">${I.play}${resume ? 'RESUME ' + fmtTime(pr.t) : 'PLAY'}</button>`}
        ${resume && !isS ? `<button class="glass-action restart lg" data-play="${esc(f.id)}" data-restart aria-label="Start over" title="Start over">${I.restart}</button>` : ''}
        ${(() => { const tr = trailerOf(it); return tr?.key ? `<a class="glass-action trailer lg" href="https://www.youtube.com/watch?v=${esc(tr.key)}" target="_blank" rel="noopener" data-trailer="${esc(tr.key)}" data-trailer-title="${esc(title(it))}">${I.yt}TRAILER</a>` : ''; })()}
      </div>
      <div class="fileinfo">${it.files.length === 1 ? `${esc(f.name)}<br>${[fmtSize(f.size), f.video?.width ? f.video.width + '×' + f.video.height : '', f.video?.fourCC, subsTxt].filter(Boolean).map(esc).join(' · ')}` : `${it.files.length} files · ${fmtSize(it.files.reduce((a, x) => a + x.size, 0))}`}</div>
    </div>
    <div class="infobox lg"><dl>${infos.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v === '__RATINGS__' ? ratingsHtml(it) : esc(v)}</dd>`).join('')}</dl></div></div>
    ${isS ? `<section class="row"><h2>Episodes</h2><div class="eps">${it.files.map(x => { const e = epName(x.s, x.e), p = LS.get('pos:' + x.id); return `<div class="ep" role="button" tabindex="0" data-play="${esc(x.id)}" aria-label="${esc('Play episode ' + x.e + (e.name ? ': ' + e.name : ''))}"><img loading="lazy" src="${esc(e.thumb || x.thumb || '')}" alt="" onerror="this.style.visibility='hidden'"><div><div class="t">${x.e}. ${esc(e.name || 'Episode ' + x.e)}</div><div class="m">S${x.s}E${String(x.e).padStart(2, '0')} · ${fmtSize(x.size)}${p && p.d ? ' · Watched to ' + fmtTime(p.t) : ''}</div></div></div>`; }).join('')}</div></section>` : ''}
    ${people.length ? `<section class="row cast-section"><h2>Cast</h2><div class="cast-shell"><div class="cast" id="cast-list" tabindex="0" role="region" aria-label="Cast and crew">${people.map(p => { const inner = `${face(p)}<div class="n">${esc(p.n)}</div><div class="r">${esc(p.r)}</div>`; return p.i ? `<a class="person" href="#/person/${p.i}" aria-label="${esc(p.n + (p.r ? ', ' + p.r : ''))}">${inner}</a>` : `<div class="person">${inner}</div>`; }).join('')}</div><button class="cast-prev lg" data-cast-scroll="-1" aria-label="Previous cast" aria-controls="cast-list" title="Previous cast" disabled><svg viewBox="0 0 24 24"><path d="m14 6-6 6 6 6"/></svg></button><button class="cast-next lg" data-cast-scroll="1" aria-label="Next cast" aria-controls="cast-list" title="Next cast"><svg viewBox="0 0 24 24"><path d="m10 6 6 6-6 6"/></svg></button></div></section>` : ''}
    ${peopleRows.map(r => row(r.name, r.list, { advance: true, key: r.key })).join('')}
    ${row('More like this', similar, { advance: true, genre: primaryGenre, key: 'similar' })}
    <div style="height:40px"></div></div>`;
}


// ---------- Liquid Glass: real refraction via per-element lens displacement map (Chromium) ----------
const GLASS_ON = document.documentElement.classList.contains('chromium');
const lensCache = new Map();
function lensMap(W, H, R, bezel) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d'), img = ctx.createImageData(W, H), d8 = img.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const px = x + .5, py = y + .5;
    const cx = Math.min(Math.max(px, R), W - R), cy = Math.min(Math.max(py, R), H - R);
    const dx = px - cx, dy = py - cy, dist = Math.hypot(dx, dy);
    let r = 128, g = 128;
    if (dist > 0) {
      const d = R - dist;                       // distance from the rounded edge, inward
      if (d >= 0 && d < bezel) {
        const t = 1 - d / bezel;                // 1 at the rim, 0 at the end of the bevel
        const mag = 1 - Math.sqrt(1 - t * t);   // circular bevel profile: strongest right at the rim
        r = 128 + (-dx / dist) * mag * 127;
        g = 128 + (-dy / dist) * mag * 127;
      }
    }
    const i = (y * W + x) * 4; d8[i] = r; d8[i + 1] = g; d8[i + 2] = 128; d8[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}
function glassFilter(W, H, R, bezel, S) {
  const id = `lg-${W}x${H}-${R}-${bezel}-${S}`;
  if (lensCache.has(id)) return id;
  let holder = document.getElementById('lgdefs');
  if (!holder) { holder = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); holder.id = 'lgdefs'; holder.setAttribute('width', '0'); holder.setAttribute('height', '0'); holder.style.position = 'absolute'; document.body.appendChild(holder); }
  const map = lensMap(W, H, R, bezel);
  const ch = (k, sc, res) => `<feDisplacementMap in="SourceGraphic" in2="map" scale="${sc}" xChannelSelector="R" yChannelSelector="G" result="d${res}"/>
    <feColorMatrix in="d${res}" type="matrix" values="${k}" result="${res}"/>`;
  holder.insertAdjacentHTML('beforeend', `<filter id="${id}" x="0" y="0" width="${W}" height="${H}" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
    <feImage href="${map}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none" result="map"/>
    ${ch('1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0', S, 'r')}
    ${ch('0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0', S * .93, 'g')}
    ${ch('0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0', S * .86, 'b')}
    <feComposite in="r" in2="g" operator="arithmetic" k2="1" k3="1" result="rg"/>
    <feComposite in="rg" in2="b" operator="arithmetic" k2="1" k3="1"/>
  </filter>`);
  lensCache.set(id, 1);
  return id;
}
// The lens for one element, sized to it exactly (a lens built for another size bends the wrong way).
function lensFor(el, strong = false) {
  const W = Math.round(el.offsetWidth), H = Math.round(el.offsetHeight);
  if (!W || !H) return null;
  const R = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, W / 2, H / 2);
  const bezel = strong ? Math.max(12, Math.min(R, 40)) : Math.max(12, Math.min(R, Math.min(W, H) * .42, 40));
  return glassFilter(W, H, Math.round(R), Math.round(bezel), Math.round(bezel * (strong ? 4.5 : 3.2)));
}

// ---------- Player controls: the same Liquid Glass inside movi-player's shadow DOM ----------
// Control groups get the clear lens like the site's buttons; menus and panels get the lens plus a little more blur,
// because their text sits over a moving picture. Always the dark glass: the player is black in both themes.
const PLAYER_GLASS_CHROME = '.movi-play-pause,.movi-volume-container,.movi-time,.movi-controls-right,.movi-center-play-pause,.movi-top-controls .movi-btn';
const PLAYER_GLASS_PANELS = '.movi-settings-menu,.movi-audio-track-menu,.movi-subtitle-track-menu,.movi-quality-menu,.movi-speed-menu,.movi-context-menu,.movi-osd-container,.movi-resume-dialog,.movi-shortcuts-panel,.movi-cues-panel';
const PLAYER_GLASS_CSS = `
:host{--movi-controls-group-bg:rgba(255,255,255,.1);--movi-glass-bg:rgba(16,16,20,.4);--movi-chrome-bg:rgba(16,16,20,.4);--movi-glass-border:transparent;--movi-chrome-border:transparent}
:is(${PLAYER_GLASS_CHROME}){background:rgba(255,255,255,.1)!important;border:0!important;
  -webkit-backdrop-filter:blur(1.5px) saturate(1.7) brightness(1.04);backdrop-filter:blur(1.5px) saturate(1.7) brightness(1.04);
  box-shadow:inset 0 0 0 .5px rgba(255,255,255,.10),inset 0 -12px 24px -14px rgba(0,0,0,.35),0 10px 34px rgba(0,0,0,.28),0 1px 3px rgba(0,0,0,.2)!important}
/* Same rim as the site's .lg glass (and the close button): a specular glint at two corners, not a white outline. */
:is(${PLAYER_GLASS_CHROME}):not(.movi-center-play-pause){position:relative}
:is(${PLAYER_GLASS_CHROME})::after{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;z-index:2;
  background:linear-gradient(140deg,rgba(255,255,255,.7) 0%,rgba(255,255,255,.18) 10%,rgba(255,255,255,0) 24%,rgba(255,255,255,0) 76%,rgba(255,255,255,.14) 90%,rgba(255,255,255,.45) 100%);
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0)}
:is(${PLAYER_GLASS_PANELS}){background:rgba(16,16,20,.4)!important;border:0!important;
  -webkit-backdrop-filter:blur(14px) saturate(1.6);backdrop-filter:blur(14px) saturate(1.6);
  box-shadow:inset 0 0 0 .5px rgba(255,255,255,.2),inset 0 1px 0 rgba(255,255,255,.28),0 20px 50px rgba(0,0,0,.45)!important}

/* iPhone fullscreen (CSS fill): the visible screen, upright, so Safari's toolbars never cover the controls. */
:host(.movi-pseudo-fullscreen){height:100vh!important;height:100dvh!important;width:100vw!important;transform:none!important;top:0!important;left:0!important}
`;
const playerGlassValue = new WeakMap();
let playerGlassMO = null, playerGlassRO = null, playerGlassFrame = 0;
function glassPlayerControls(activeFilters) {
  const root = player?.shadowRoot;
  if (!root) return;
  if (!root.getElementById('cofilm-glass')) {                    // tint + rim; also the fallback where the lens is unsupported
    const style = document.createElement('style'); style.id = 'cofilm-glass'; style.textContent = PLAYER_GLASS_CSS; root.appendChild(style);
  }
  if (!GLASS_ON) return;
  for (const [selector, tail] of [[PLAYER_GLASS_CHROME, 'blur(.6px) saturate(1.5) brightness(1.05)'], [PLAYER_GLASS_PANELS, 'blur(10px) saturate(1.6) brightness(.92)']]) {
    for (const el of root.querySelectorAll(selector)) {
      playerGlassRO?.observe(el);                                   // a menu opening or a group growing re-fits its lens
      const id = lensFor(el); if (!id) continue;
      activeFilters?.add(id);
      const value = `url(#${id}) ${tail}`;
      if (playerGlassValue.get(el) === value) continue;
      el.style.setProperty('backdrop-filter', value, 'important');
      el.style.setProperty('-webkit-backdrop-filter', value, 'important');
      playerGlassValue.set(el, value);
    }
  }
  playerGlassMO?.takeRecords();                                    // our own writes are not a reason to run again
}
function schedulePlayerGlass() {
  if (playerGlassFrame) return;
  playerGlassFrame = requestAnimationFrame(() => { playerGlassFrame = 0; glassPlayerControls(); });
}
function watchPlayerGlass(el) {
  unwatchPlayerGlass();
  if (!el?.shadowRoot) return;
  // Only structure and open/close classes, never style: the progress bar rewrites styles on every frame.
  playerGlassMO = new MutationObserver(schedulePlayerGlass);
  playerGlassMO.observe(el.shadowRoot, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  if (typeof ResizeObserver !== 'undefined') playerGlassRO = new ResizeObserver(schedulePlayerGlass);
  schedulePlayerGlass();
}
function unwatchPlayerGlass() {
  playerGlassMO?.disconnect(); playerGlassRO?.disconnect(); playerGlassMO = playerGlassRO = null;
  cancelAnimationFrame(playerGlassFrame); playerGlassFrame = 0;
}
function applyGlass() {
  placeMovieInd();
  if (!GLASS_ON) return;
  const activeFilters = new Set();
  document.querySelectorAll('.lg').forEach(el => {
    if (el.matches('[data-movie-ind]')) { applyGlassInd(); return; }
    const id = lensFor(el, el.id === 'nav' || el.matches('#search .searchfield')); if (!id) return;
    activeFilters.add(id);
    el.style.backdropFilter = `url(#${id}) blur(.6px) saturate(1.5) brightness(1.05)`;
  });
  glassPlayerControls(activeFilters);
  // Bound resize history without removing filters still used by visible glass.
  for (const id of lensCache.keys()) {
    if (lensCache.size <= 16) break;
    if (!activeFilters.has(id)) { lensCache.delete(id); document.getElementById(id)?.remove(); }
  }
}
{
  const hoverInd = e => {
    const chip = e.target.closest?.('.movie-bar .movie-chip'); if (!chip) return;
    placeMovieInd(chip); if (GLASS_ON) requestAnimationFrame(applyGlassInd);
  };
  const restInd = () => { placeMovieInd(); if (GLASS_ON) requestAnimationFrame(applyGlassInd); };
  document.addEventListener('pointerover', hoverInd);
  document.addEventListener('focusin', hoverInd);
  document.addEventListener('pointerout', e => { if (e.target.closest?.('.movie-bar') && !e.relatedTarget?.closest?.('.movie-bar')) restInd(); });
  document.addEventListener('focusout', e => { if (e.target.closest?.('.movie-bar') && !e.relatedTarget?.closest?.('.movie-bar')) restInd(); });
}
function applyGlassInd() {   // re-fit only the sliding drop's lens to its new size
  const ind = document.querySelector('[data-movie-ind]'); if (!ind) return;
  const W = Math.round(parseFloat(ind.style.width)), H = Math.round(parseFloat(ind.style.height));   // the target size, not the mid-slide one
  const id = W && H ? glassFilter(W, H, Math.round(H / 2), 9, 12) : null;   // small bend: the label under the drop stays readable
  if (id) ind.style.backdropFilter = `url(#${id}) blur(.3px) saturate(1.4) brightness(1.06)`;
}
window.addEventListener('cofilmthemechange', () => requestAnimationFrame(applyGlass));
let glassT = 0;
window.matchMedia?.('(max-width:820px) and (max-aspect-ratio:1/1)').addEventListener?.('change', () => ensureWalls());
window.addEventListener('resize', () => { clearTimeout(glassT); glassT = setTimeout(applyGlass, 150); });

// ---------- Touch devices swipe rails directly; pointer devices keep the arrow buttons ----------
// Treat phones as touch even if the browser misreports its pointer type (desktop-site mode, in-app browsers).
const touchQuery = matchMedia('(hover: none), (pointer: coarse)');
const isTouchRails = () => touchQuery.matches || innerWidth <= 600;
const touchRails = { get matches() { return isTouchRails(); } };
const syncTouchRails = () => {
  const was = document.documentElement.classList.contains('touch-rails'), now = isTouchRails();
  document.documentElement.classList.toggle('touch-rails', now);
  if (was !== now) requestAnimationFrame(() => { fitCastRail(); fitPosterRails(); });
};
syncTouchRails();
touchQuery.addEventListener?.('change', syncTouchRails);

// ---------- Cast rail: whole portraits, whole-page steps ----------
let castResizeObserver;
function castStartIndex(list) {
  if (!list?.children.length) return 0;
  const span = Number(list.dataset.cardSpan) || list.firstElementChild.getBoundingClientRect().width + parseFloat(getComputedStyle(list).gap);
  return Math.max(0, Math.round(list.scrollLeft / span));
}
function updateCastControls() {
  const section = $('.cast-section'), list = section?.querySelector('.cast');
  if (!list) return;
  section.querySelector('.cast-next').disabled = list.scrollLeft + list.clientWidth >= list.scrollWidth - 1;
  section.querySelector('.cast-prev').disabled = list.scrollLeft <= 1;
}
function fitCastRail() {
  const shell = $('.cast-shell'), list = shell?.querySelector('.cast');
  if (!list?.children.length) return;
  const next = shell.querySelector('.cast-next'), style = getComputedStyle(shell);
  const total = list.children.length, gap = parseFloat(getComputedStyle(list).gap);
  const fullWidth = shell.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const preferred = innerWidth <= 820 ? 112 : Math.min(170, Math.max(120, innerWidth * .1));
  const touch = touchRails.matches;
  // Arrows overlay the portraits (like the poster rails), so they reserve no width.
  let available = Math.max(1, Math.floor(fullWidth));
  let count = Math.max(1, Math.ceil((available + gap) / (preferred + gap)));
  const overflow = total > count;
  const showArrow = overflow && !touch;
  if (!overflow) { available = Math.max(1, Math.floor(fullWidth)); count = total; }
  const width = Math.max(1, Math.floor(Math.min(preferred, (available - gap * (count - 1)) / count)));
  const signature = [available, count, width, total, showArrow, touch].join('|');
  if (list.dataset.fitSignature === signature && list.dataset.restoreIndex === undefined) { updateCastControls(); return; }
  const index = Number(list.dataset.restoreIndex ?? castStartIndex(list));
  delete list.dataset.restoreIndex;
  next.hidden = !showArrow; shell.querySelector('.cast-prev').hidden = !showArrow;
  list.style.flex = '0 0 ' + available + 'px'; list.style.width = available + 'px';
  shell.style.setProperty('--cast-card-width', width + 'px');
  list.dataset.pageSize = String(count); list.dataset.cardSpan = String(width + gap); list.dataset.fitSignature = signature;
  list.scrollTo({ left: Math.min(index, Math.max(0, total - count)) * (width + gap), behavior: 'instant' });
  updateCastControls();
}
function setupCastControls() {
  castResizeObserver?.disconnect();
  const list = $('.cast-section .cast');
  list?.addEventListener('scroll', updateCastControls, { passive: true });
  fitCastRail();
  if (list && typeof ResizeObserver !== 'undefined') {
    castResizeObserver = new ResizeObserver(() => requestAnimationFrame(fitCastRail));
    castResizeObserver.observe(list.closest('.cast-shell'));
  }
}

// ---------- Poster rails: full cards, with an independent overlay button ----------
function posterRailIndex(list) {
  if (!list?.firstElementChild) return 0;
  if (list.dataset.railRestoreIndex !== undefined) return Number(list.dataset.railRestoreIndex);
  if (list.dataset.railTargetIndex !== undefined) return Number(list.dataset.railTargetIndex);
  const gap = parseFloat(getComputedStyle(list).gap) || 0;
  const span = Number(list.dataset.railSpan) || list.firstElementChild.getBoundingClientRect().width + gap;
  return Math.max(0, Math.round(list.scrollLeft / span));
}
function fitPosterRail(list) {
  const shell = list.parentElement, available = list.clientWidth;
  if (!list.firstElementChild || !available) return;
  const gap = parseFloat(getComputedStyle(list).gap) || 0;
  const wide = !!list.closest('.row.wide');
  const preferred = wide ? Math.min(380, Math.max(240, innerWidth * .22)) : Math.min(200, Math.max(128, innerWidth * .115));
  const count = Math.max(1, Math.round((available + gap) / (preferred + gap)));
  const width = (available - gap * (count - 1)) / count;
  const signature = [available, count, width, list.children.length].join('|');
  if (list.dataset.railFit === signature && list.dataset.railRestoreIndex === undefined) return;
  const index = Math.min(Number(list.dataset.railRestoreIndex ?? posterRailIndex(list)), Math.max(0, list.children.length - count));
  delete list.dataset.railRestoreIndex; delete list.dataset.railTargetIndex;
  shell.style.setProperty('--rail-card-width', width + 'px');
  list.dataset.railPageSize = String(count); list.dataset.railSpan = String(width + gap); list.dataset.railFit = signature;
  list.scrollTo({ left: index * (width + gap), behavior: 'instant' });
}
function updateRecommendationControls() {
  document.querySelectorAll('.recommend-section,.browse-section').forEach(section => {
    const list = section.querySelector('.scroller'), next = section.querySelector('[data-recommend-next],[data-row-next]'), prev = section.querySelector('[data-recommend-prev],[data-row-prev]');
    if (list.dataset.railTargetIndex !== undefined && Math.abs(list.scrollLeft - Number(list.dataset.railTargetIndex) * Number(list.dataset.railSpan)) < 1) delete list.dataset.railTargetIndex;
    next.hidden = prev.hidden = list.scrollWidth <= list.clientWidth + 1;
    prev.disabled = list.scrollLeft <= 1;
    next.disabled = list.scrollLeft + list.clientWidth >= list.scrollWidth - 1;
  });
}
function fitPosterRails() {
  document.querySelectorAll('.recommend-section .scroller,.browse-section .scroller').forEach(fitPosterRail);
  updateRecommendationControls();
}
let posterRailObserver;
function setupRecommendationControls() {
  posterRailObserver?.disconnect();
  const lists = document.querySelectorAll('.recommend-section .scroller,.browse-section .scroller');
  lists.forEach(list => list.addEventListener('scroll', updateRecommendationControls, { passive: true }));
  fitPosterRails();
  if (typeof ResizeObserver !== 'undefined') {
    posterRailObserver = new ResizeObserver(fitPosterRails);
    lists.forEach(list => posterRailObserver.observe(list.parentElement));
  }
}

// ---------- Artwork guard: fall back to poster, then a still from the file ----------
const artChecked = new Map();
function ensureArtwork() {
  document.querySelectorAll('.bg[data-art]').forEach(el => {
    let list; try { list = JSON.parse(el.dataset.art || '[]'); } catch { return; }
    const current = el.style.backgroundImage.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
    const start = Math.max(0, list.indexOf(current));
    // A picture that is not landscape (e.g. a poster used because TMDB has no backdrop) is flagged so phones can show it whole.
    const apply = (url, ratio) => { el.style.backgroundImage = 'url("' + url + '")'; el.classList.remove('art-missing'); el.classList.toggle('art-tall', ratio > 0 && ratio < 1.4); };
    const tryAt = i => {
      if (i >= list.length) { el.classList.add('art-missing'); return; }
      const url = list[i];
      if (artChecked.has(url)) { artChecked.get(url) ? apply(url, artChecked.get(url)) : tryAt(i + 1); return; }
      const probe = new Image();
      probe.onload = () => { const ratio = probe.naturalWidth / (probe.naturalHeight || 1) || 1.78; artChecked.set(url, ratio); apply(url, ratio); };
      probe.onerror = () => { artChecked.set(url, false); tryAt(i + 1); };
      probe.src = url;
    };
    tryAt(start);
  });
}

function layoutLightArtwork() {
  // Measure shared layout; never change content size or position for a theme.
  const light = document.documentElement.dataset.theme === 'light';
  for (const root of document.querySelectorAll('.hero,.detail')) {
    root.style.removeProperty('--art-height'); root.style.removeProperty('--art-fade'); root.style.removeProperty('--hcontent-top');
    const images = root.querySelectorAll('.slide .bg,.detail > .bg');
    images.forEach(bg => {
      for (const prop of ['--art-solid','--art-mid1','--art-mid2','--art-end']) bg.style.removeProperty(prop);
      if (!light) return;
      const slide = bg.closest('.slide');
      // Include wrapped secondary actions so glass buttons never straddle the image fade.
      const cta = slide ? slide.querySelector('[data-play-item]') : root.querySelector('.dleft .hbtns');
      if (!cta) return;
      const base = root.getBoundingClientRect().top;
      const full = bg.offsetHeight;
      const solid = Math.max(0, Math.min(full - 1, cta.getBoundingClientRect().bottom - base));
      const fade = Math.max(1, Math.min(full - solid, Math.min(170, Math.max(80, innerWidth * .1))));
      bg.style.setProperty('--art-solid', solid.toFixed(2) + 'px');
      bg.style.setProperty('--art-mid1', (solid + fade * .28).toFixed(2) + 'px');
      bg.style.setProperty('--art-mid2', (solid + fade * .7).toFixed(2) + 'px');
      bg.style.setProperty('--art-end', (solid + fade).toFixed(2) + 'px');
    });
  }
}
let artworkFrame = 0, artworkTimers = [];
function settleLightArtwork() {
  cancelAnimationFrame(artworkFrame); artworkTimers.forEach(clearTimeout);
  const update = () => { layoutLightArtwork(); updateNavContrast(); };
  artworkFrame = requestAnimationFrame(update);
  artworkTimers = [setTimeout(update, 350), setTimeout(update, 1200)];
}
document.fonts?.ready.then(settleLightArtwork);
window.addEventListener('load', settleLightArtwork);
window.addEventListener('cofilmthemechange', settleLightArtwork);
window.addEventListener('resize', () => { clearTimeout(layoutLightArtwork._t); layoutLightArtwork._t = setTimeout(layoutLightArtwork, 120); });

// ---------- Navigation text contrast: image area versus light page ----------
function updateNavContrast() {
  const nav = $('#nav'); if (!nav) return;
  const nr = nav.getBoundingClientRect(), y = nr.top + nr.height / 2;
  const art = $('.slide.on .bg') || $('.detail > .bg');
  let onArt = false;
  if (art && !art.classList.contains('art-missing')) {
    const r = art.getBoundingClientRect();
    let bottom = r.bottom;
    if (document.documentElement.dataset.theme === 'light') {
      const style = getComputedStyle(art), solid = parseFloat(style.getPropertyValue('--art-solid')), end = parseFloat(style.getPropertyValue('--art-end'));
      if (Number.isFinite(solid) && Number.isFinite(end)) bottom = r.top + solid + (end - solid) * .7;
    }
    onArt = y >= r.top && y < bottom;
  }
  nav.classList.toggle('nav-on-art', onArt);
}
let navContrastFrame = 0;
function scheduleNavContrast() {
  if (navContrastFrame) return;
  navContrastFrame = requestAnimationFrame(() => { navContrastFrame = 0; updateNavContrast(); });
}
window.addEventListener('scroll', scheduleNavContrast, { passive: true });
window.addEventListener('cofilmthemechange', scheduleNavContrast);

// ---------- router ----------
function routeInfo() {
  const h = location.hash.replace(/^#/, '') || '/';
  if (h.startsWith('/t/')) return { name: 'detail', arg: decodeURIComponent(h.slice(3)) };
  if (h.startsWith('/person/')) return { name: 'person', arg: h.slice(8).split(/[/?]/)[0] };
  if (h.startsWith('/search')) return { name: 'search' };
  if (h.startsWith('/movies')) return { name: 'movies' };
  if (h.startsWith('/shows')) return { name: 'shows' };
  return { name: 'home' };
}
let lastRoute = '';
const savedScroll = new Map();
function render() {
  stopMovieGalaxy();
  if (routeInfo().name !== 'movies') movieMenuOpen = '';
  closeTrailer();                                                  // leaving the page also stops its trailer
  if (location.hash.startsWith('#/genres')) {                       // old Genres links keep working
    let genre = ''; try { genre = decodeURIComponent(location.hash.split('/')[2] || ''); } catch {}
    if (genre) LS.set('view:movies', { ...movieView(), genre });
    history.replaceState(null, '', location.pathname + location.search + '#/movies');
  }
  clearTimeout(rt); // A full render supersedes any pending metadata render.
  const r = routeInfo();
  const sig = location.hash;
  const keepScroll = sig === lastRoute;
  const y = scrollY;
  const castIndex = keepScroll ? castStartIndex($('.cast')) : 0;
  const railSections = '.recommend-section,.browse-section';
  const railIndex = keepScroll ? new Map([...document.querySelectorAll(railSections)].map(s => [s.dataset.rowKey, posterRailIndex(s.querySelector('.scroller'))])) : null;
  let html = '';
  if (r.name === 'detail') html = viewDetail(r.arg);
  else if (r.name === 'person') html = viewPerson(r.arg);
  else if (r.name === 'search') html = viewSearch();
  else if (r.name === 'movies') html = viewList('movie');
  else if (r.name === 'shows') html = viewList('series');
  else html = viewHome();
  $('#view').innerHTML = html;
  // Home and film pages: the page takes the colours of the film on screen, always in the dark cinematic look.
  const tinted = r.name === 'detail' || r.name === 'home' || r.name === 'person', rootEl = document.documentElement;
  rootEl.classList.toggle('film-tint', tinted);
  const darkLock = tinted || r.name === 'movies' || r.name === 'search';   // the Movies wall is always the textured black look too
  rootEl.classList.toggle('movies-dark', r.name === 'movies' || r.name === 'search');
  if (darkLock !== (rootEl.dataset.themeLock === 'dark')) { if (darkLock) rootEl.dataset.themeLock = 'dark'; else delete rootEl.dataset.themeLock; window.cofilmRefreshTheme?.(); }
  if (keepScroll && $('.cast')) $('.cast').dataset.restoreIndex = String(castIndex);
  if (railIndex) document.querySelectorAll(railSections).forEach(s => { s.querySelector('.scroller').dataset.railRestoreIndex = String(railIndex.get(s.dataset.rowKey) || 0); });
  document.querySelectorAll('#nav a').forEach(a => { const active = a.dataset.route === (r.name === 'detail' ? '' : r.name); a.classList.toggle('on', active); if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (r.name === 'home') { startHero(); warmHero(); if (hero.list[hero.idx]) setAmbient(bgOf(hero.list[hero.idx])); } else stopHero();
  // Coming back from a person page returns to where you were on the film page.
  const cameFromPerson = !keepScroll && lastRoute.startsWith('#/person/') && savedScroll.has(sig);
  if (!keepScroll && lastRoute) savedScroll.set(lastRoute, y);
  scrollTo(0, keepScroll ? y : cameFromPerson ? savedScroll.get(sig) : 0);
  lastRoute = sig;
  if (!$('#search').hidden) renderSearch();
  if (r.name === 'detail') setTimeout(() => { if (routeInfo().name === 'detail') warmPlayer(); }, 1200);
  requestAnimationFrame(() => {
    applyGlass();
    setupCastControls();
    setupRecommendationControls();
    ensureArtwork();
    applyWalls();
    ensureWalls();
    settleLightArtwork();
    updateNavContrast();
    if (r.name === 'movies' && !moviesFlowActive(movieView())) {
      const box = document.querySelector('.movies-galaxy');
      const keys = (box?.dataset.galaxyKeys || '').split(',').filter(Boolean);
      const picked = keys.map(k => state.items.find(it => it.key === k)).filter(Boolean);
      startMovieGalaxy(picked);
    }
  });
}
// Hero pictures are large. Decode each one BEFORE its cross-fade starts, so the animation never waits on a decode
// (that wait showed up as roughly a second of 10-20 fps every time the slide changed).
const decodedImages = new Map();
function decodeImage(url) {
  if (!url) return Promise.resolve();
  if (!decodedImages.has(url)) { const img = new Image(); img.src = url; decodedImages.set(url, (img.decode ? img.decode() : Promise.resolve()).catch(() => {})); }
  return decodedImages.get(url);
}
function slideImage(i) {
  const bg = document.querySelector(`.slide[data-i="${i}"] .bg`);
  const src = bg?.classList.contains('has-wall') && phoneWallMedia() ? bg.style.getPropertyValue('--wall') : bg?.style.backgroundImage;
  return (String(src || '').match(/url\(["']?([^"')]+)/) || [])[1] || '';
}
let heroSwitch = 0, heroWarmKey = '';
function showSlide(i) {
  if (!hero.list.length) return;
  hero.idx = (i + hero.list.length) % hero.list.length;
  const idx = hero.idx, token = ++heroSwitch;
  Promise.race([decodeImage(slideImage(idx)), new Promise(r => setTimeout(r, 700))]).then(() => { if (token === heroSwitch) applySlide(idx); });
}
function applySlide(idx) {
  document.querySelectorAll('.slide').forEach(s => {
    const active = +s.dataset.i === idx;
    s.classList.toggle('on', active); s.inert = !active; s.setAttribute('aria-hidden', String(!active));
  });
  requestAnimationFrame(() => { layoutLightArtwork(); updateNavContrast(); });
  document.querySelectorAll('.dots [data-slide]').forEach(d => {
    const active = +d.dataset.slide === idx;
    d.classList.toggle('on', active); d.setAttribute('aria-current', String(active));
  });
  setAmbient(bgOf(hero.list[idx]));
}
// Quietly decode the other slides shortly after the home page appears, one at a time.
function warmHero() {
  const key = hero.list.map(it => it.key).join('|');
  if (!key || key === heroWarmKey) return;
  heroWarmKey = key;
  setTimeout(async () => { for (let i = 0; i < hero.list.length; i++) await decodeImage(slideImage(i)); }, 1500);
}
function startHero() { stopHero(); if (hero.list.length > 1) hero.timer = setInterval(() => showSlide(hero.idx + 1), 8000); }
function stopHero() { clearInterval(hero.timer); }
// Swipe the hero artwork left/right to change slides (vertical scrolling and taps are untouched).
let heroTouch = null, heroSwipedAt = 0;
document.addEventListener('touchstart', e => {
  const t = e.touches[0];
  heroTouch = e.touches.length === 1 && e.target.closest?.('.hero') && !e.target.closest('[data-hero-controls]') ? { x: t.clientX, y: t.clientY } : null;
  if (heroTouch) stopHero();                                  // don't auto-advance under the finger
}, { passive: true });
document.addEventListener('touchend', e => {
  if (!heroTouch) return;
  const t = e.changedTouches[0], dx = t.clientX - heroTouch.x, dy = t.clientY - heroTouch.y;
  heroTouch = null;
  if (Math.abs(dx) >= 45 && Math.abs(dx) > Math.abs(dy) * 1.5) { heroSwipedAt = performance.now(); showSlide(hero.idx + (dx < 0 ? 1 : -1)); }
  startHero();
}, { passive: true });
document.addEventListener('touchcancel', () => { if (heroTouch) { heroTouch = null; startHero(); } }, { passive: true });
// A swipe must never also open the film under the finger.
document.addEventListener('click', e => {
  if (performance.now() - heroSwipedAt < 500 && e.target.closest?.('.hero')) { e.preventDefault(); e.stopPropagation(); }
}, true);
window.addEventListener('hashchange', () => { if (location.hash === '#search') { history.replaceState(null, '', location.pathname + (lastRoute || '')); openSearch(); return; } if (location.hash === '#settings') { history.replaceState(null, '', location.pathname); openSetup(); return; } render(); });

// ---------- search ----------
const fold = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function searchText(it) {
  if (it._st && it._stm === it.meta) return it._st;
  const m = it.meta || {}, cr = m.id ? LS.get('tmdbc:' + m.id) : null;
  it._st = fold([title(it), it.parsed.title, m.year || it.parsed.year, ...(m.genres || []), ...(m.cast || []), ...(m.director || []),
    ...(cr?.cast || []).map(p => p.n + ' ' + (p.r || '')), ...(cr?.crew || []).map(p => p.n), m.country, it.files.map(f => f.name.replace(/[._]+/g, ' ')).join(' ')].join(' | '));
  it._stm = it.meta;
  return it._st;
}
// Search results use exactly the poster size of the home rows (same fitting rule as fitPosterRail).
function fitSearchGrid() {
  const g = $('#results');
  if (!g || $('#search').hidden) return;
  if (innerWidth <= 600) { g.style.gridTemplateColumns = ''; return; }  // phones: the three-column rule applies
  const cs = getComputedStyle(g), gap = 20;
  const available = g.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  if (available <= 0) return;
  const preferred = Math.min(200, Math.max(128, innerWidth * .115));
  const count = Math.max(1, Math.round((available + gap) / (preferred + gap)));
  g.style.gridTemplateColumns = `repeat(${count}, ${(available - gap * (count - 1)) / count}px)`;
}
function searchHtml(query) {
  const words = fold(query || '').split(/\s+/).filter(Boolean);
  let list;
  if (!words.length) list = [...state.items].sort((a, b) => b.added - a.added);
  else {
    list = state.items.map(it => {
      const t = searchText(it), tl = fold(title(it));
      if (!words.every(w => t.includes(w))) return null;
      const q = words.join(' ');
      const score = (tl === q ? 100 : tl.startsWith(q) ? 50 : tl.includes(q) ? 25 : 0) + (parseFloat(it.meta?.rating) || 0);
      return { it, score };
    }).filter(Boolean).sort((a, b) => b.score - a.score).map(x => x.it);
  }
  return (words.length ? `<p class="empty" style="grid-column:1/-1;margin:0;padding:0">${list.length} result${list.length === 1 ? '' : 's'}</p>` : '') +
    (list.map(it => card(it, { caption: [yearOf(it), (it.meta?.genres || [])[0]].filter(Boolean).join(' · ') })).join('') || '<p class="empty">No results</p>');
}
function renderSearch() {
  $('#results').innerHTML = searchHtml($('#q').value);
  fitSearchGrid(); requestAnimationFrame(fitSearchGrid);  // the scrollbar may appear after layout
}
// Touch screens search on an ordinary page (#/search), not in a full-screen layer: on iPhone, showing the layer froze the
// screen for 2+ seconds (measured from a Mac through Web Inspector) however light its contents were, while ordinary pages are fast.
const searchOnPage = () => !!window.matchMedia?.('(pointer: coarse)').matches;
let searchQuery = '';
function viewSearch() {
  return `<div class="page search-page"><h1>Search</h1>
    <div class="sfield"><input id="sq" type="text" inputmode="search" enterkeyhint="search" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Search the library" value="${esc(searchQuery)}"></div>
    <div id="sresults" class="grid">${searchHtml(searchQuery)}</div></div>`;
}
// iPhone only opens the keyboard when focus happens inside the tap itself, so the field is focused synchronously.
// The page behind is hidden and the hero paused while search is open: nothing underneath has to be painted or blurred.
function openSearch() {
  if (searchOnPage()) { if (routeInfo().name !== 'search') location.hash = '#/search'; return; }
  $('#search').hidden = false; document.documentElement.classList.add('search-open'); document.body.style.overflow = 'hidden';
  stopHero();
  try { $('#q').focus({ preventScroll: true }); } catch { $('#q').focus(); }
  renderSearch(); requestAnimationFrame(fitSearchGrid); requestAnimationFrame(applyGlass);
}
function closeSearch() {
  $('#search').hidden = true; document.documentElement.classList.remove('search-open'); document.body.style.overflow = '';
  if (routeInfo().name === 'home') startHero();
}
$('#q').oninput = renderSearch;
document.addEventListener('input', e => { if (e.target.id !== 'sq') return; searchQuery = e.target.value; const g = $('#sresults'); if (g) g.innerHTML = searchHtml(searchQuery); });
$('#searchLink').onclick = e => { e.preventDefault(); openSearch(); };


// ---------- access code: decrypts config.enc.json (OneDrive link + TMDB key) ----------
async function unlockWithCode(raw) {
  let code = String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
  if (/^[a-z0-9]{8}$/.test(code)) code = code.slice(0, 4) + '-' + code.slice(4);
  const f = await (await fetch('config.enc.json?t=' + Date.now(), { cache: 'no-store' })).json();
  const b = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b(f.salt), iterations: f.iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b(f.iv) }, key, b(f.data));
  const cfg = JSON.parse(new TextDecoder().decode(plain));
  LS.set('od:link', cfg.link); if (cfg.tmdb) LS.set('tmdb:key', cfg.tmdb); LS.del('od:files');
  ratingsKey = null;
  return true;
}
async function tryUnlock(code) {
  $('#codeMsg').textContent = 'Checking…';
  token().catch(() => {});                                   // independent of the code; overlap with decryption
  try { await unlockWithCode(code); $('#codeMsg').textContent = ''; $('#setup').hidden = true; load(true); loadRatings(); }
  catch (e) { console.warn(e); $('#codeMsg').textContent = 'That code did not work. Please check it and try again.'; }
}
$('#unlockBtn').onclick = () => tryUnlock($('#codeInput').value);
$('#codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock($('#codeInput').value); });

// ---------- setup ----------
function openSetup() { $('#linkInput').value = LS.get('od:link') || ''; $('#tmdbInput').value = LS.get('tmdb:key') || ''; $('#setup').hidden = false; }
$('#saveLink').onclick = () => {
  const v = $('#linkInput').value.trim();
  if (!/^https:\/\/(1drv\.ms|onedrive\.live\.com|.*sharepoint\.com)/.test(v)) { alert('That does not look like a OneDrive share link'); return; }
  const k = $('#tmdbInput').value.trim(); if (k) LS.set('tmdb:key', k); else LS.del('tmdb:key');
  LS.set('od:link', v); LS.del('od:files'); $('#setup').hidden = true; ratingsKey = null; load(true); loadRatings();
};
$('#cancelSetup').onclick = () => { $('#setup').hidden = true; };
$('#clearCache').onclick = () => { Object.keys(localStorage).filter(k => /^(meta[0-9]?|tmdbc|tmdbp|tmdbt|tmdbw):/.test(k)).forEach(k => localStorage.removeItem(k)); $('#setup').hidden = true; load(true); };

// ---------- resize: one layout pass per frame ----------
let resizeFrame = 0;
window.addEventListener('resize', () => {
  if (resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; syncTouchRails(); fitCastRail(); fitPosterRails(); updateNavContrast(); fitSearchGrid(); });
});

// ---------- events ----------
document.addEventListener('pointerdown', e => { if (e.target.closest?.('[data-play],[data-play-item]')) warmPlayer(); }, { passive: true });
document.addEventListener('click', e => {
  const t = e.target;
  const trailer = t.closest?.('[data-trailer]');
  if (trailer && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) {   // Cmd/Ctrl-click still opens YouTube
    if (openTrailer(trailer.dataset.trailer, trailer.dataset.trailerTitle)) { e.preventDefault(); return; }
  }
  if (t.closest?.('[data-trailer-close]') || t.id === 'trailer') { e.preventDefault(); closeTrailer(); return; }
  if (t.closest('[data-hero-controls]')) {
    e.preventDefault(); e.stopPropagation();
    const slide = t.closest('[data-slide]');
    if (slide) { showSlide(+slide.dataset.slide); startHero(); }
    return; // The surrounding padding is a safe zone, never a movie link.
  }
  const recommendNext = t.closest('[data-recommend-next],[data-row-next],[data-recommend-prev],[data-row-prev]');
  if (recommendNext) {
    const dir = recommendNext.matches('[data-recommend-prev],[data-row-prev]') ? -1 : 1;
    e.preventDefault(); e.stopPropagation(); // Never activate the poster beneath the button.
    if (recommendNext.disabled || recommendNext.hidden) return;
    const list = recommendNext.closest('.recommend-section,.browse-section').querySelector('.scroller');
    const count = Number(list.dataset.railPageSize) || 1;
    const index = Math.min(Math.max(0, list.children.length - count), Math.max(0, posterRailIndex(list) + dir * count));
    list.dataset.railTargetIndex = String(index); // Preserve the requested page if metadata rerenders mid-animation.
    list.scrollTo({ left: index * Number(list.dataset.railSpan), behavior: 'smooth' });
    return;
  }
  const castScroll = t.closest('[data-cast-scroll]');
  if (castScroll) {
    const list = castScroll.closest('.cast-section').querySelector('.cast');
    const count = Number(list.dataset.pageSize) || 1;
    const dir = Number(castScroll.dataset.castScroll) || 1;
    if (castScroll.disabled) return;
    const index = Math.min(Math.max(0, list.children.length - count), Math.max(0, castStartIndex(list) + dir * count));
    list.scrollTo({ left: index * Number(list.dataset.cardSpan), behavior: 'instant' });
    return;
  }
  const pl = t.closest('[data-play]');
  if (pl) { e.preventDefault(); closeSearch(); play(pl.dataset.play, pl.hasAttribute('data-restart')); return; }
  const pi = t.closest('[data-play-item]');
  if (pi) { const it = state.items.find(x => x.key === pi.dataset.playItem); const p = progressOf(it); play((p?.f || it.files[0]).id); return; }
  if (t.closest('[data-back]')) { e.preventDefault(); if (history.length > 1) history.back(); else location.hash = '#/'; return; }
  const bio = t.closest('[data-bio-toggle]');
  if (bio) { const id = bio.dataset.bioToggle; if (bioOpen.has(id)) bioOpen.delete(id); else bioOpen.add(id); render(); return; }
  const retry = t.closest('[data-person-retry]');
  if (retry) { personFailed.delete(retry.dataset.personRetry); render(); return; }
  if (t.closest('[data-galaxy-reshuffle]')) { restartMovieGalaxy(); setMovieView({ galaxySeed: Date.now() }); return; }
  const pageBtn = t.closest('[data-movie-page]');
  if (pageBtn && !pageBtn.disabled) {
    const v = movieView();
    const dir = pageBtn.dataset.moviePage === 'next' ? 1 : -1;
    setMovieView({ page: Math.max(1, (v.page || 1) + dir) });
    return;
  }
  const pick = t.closest('[data-movie-pick]');
  if (pick) {
    const name = pick.dataset.moviePick;
    const value = pick.dataset.movieValue ?? '';
    movieMenuOpen = '';                                   // one choice per list: choosing closes it
    if (name === 'sort' || value !== movieView()[name]) setMovieView({ [name]: value }, `[data-movie-panel="${name}"]`); else syncMovieMenu();
    return;
  }
  const dockPanel = t.closest('[data-movie-panel]');
  if (dockPanel) { const n = dockPanel.dataset.moviePanel; movieMenuOpen = movieMenuOpen === n ? '' : n; syncMovieMenu(); return; }
  if (movieMenuOpen && !t.closest('[data-movie-dock]')) { movieMenuOpen = ''; syncMovieMenu(); }
  if (t.closest('[data-movie-4k]')) { setMovieView({ only4k: !movieView().only4k }, '[data-movie-4k]'); return; }
  if (t.closest('[data-movie-reset]')) { LS.del('view:movies'); render(); keepFocus('[data-movie-panel]'); return; }
  if (t.closest('[data-close-search]')) { closeSearch(); return; }
  if (t.closest('#search .card')) { closeSearch(); return; }
});
$('#pclose').onclick = () => closePlayer();
for (const type of ['pointermove', 'pointerdown', 'touchstart', 'keydown', 'focusin']) $('#player').addEventListener(type, () => wakePlayerBar(), { passive: true });
// Cmd/Ctrl/Alt combinations belong to the browser (Cmd+F find, Cmd+K, ...). The player's own handler ignores modifiers,
// so stop it from seeing them; the browser still gets the key because we never cancel it.
document.addEventListener('keydown', e => {
  if (!$('#player').hidden && (e.metaKey || e.ctrlKey || e.altKey) && (isSpaceKey(e) || /^(f|m|k|ArrowUp|ArrowDown)$/i.test(e.key))) e.stopPropagation();
}, true);
document.addEventListener('keyup', e => { if (isSpaceKey(e) && playerKeyTarget(e)) e.preventDefault(); });
document.addEventListener('keydown', e => {
  // Episode rows are buttons for keyboard users too.
  if ((e.key === 'Enter' || isSpaceKey(e)) && e.target.matches?.('.ep[data-play]')) { e.preventDefault(); play(e.target.dataset.play); return; }
  // Player shortcuts (not while typing in a field, never with Cmd/Ctrl/Alt, so browser shortcuts keep working).
  // The player has its own shortcuts when it has focus and marks the key as handled; never act twice.
  if (playerKeyTarget(e) && !e.defaultPrevented) {
    const key = isSpaceKey(e) ? ' ' : e.key.length === 1 ? e.key.toLowerCase() : e.key, action = PLAYER_KEYS[key];
    const isArrow = key.startsWith('Arrow');
    if (action && !(isArrow && e.shiftKey)) { e.preventDefault(); if (isArrow || !e.repeat) action(); return; }
  }
  if (e.key === '/' && $('#search').hidden && $('#player').hidden && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); openSearch(); return; }
  if (e.key !== 'Escape') return;
  if (closeTrailer()) return;
  if (movieMenuOpen) { movieMenuOpen = ''; syncMovieMenu(); return; }
  if (!$('#player').hidden && !document.fullscreenElement) closePlayer();
  else if (!$('#search').hidden) closeSearch();
  else if (!$('#setup').hidden) $('#setup').hidden = true;
});

// link via URL hash (#link=...) for quick setup on a new device
const urlCode = new URLSearchParams(location.search).get('code') || new URLSearchParams(location.hash.slice(1)).get('code');
// A shared link with ?code= opens straight into the library: unlock quietly, ask only if the code is wrong.
let autoUnlock = null;
if (urlCode) {
  const route = location.hash.startsWith('#/') ? location.hash : '';      // keep a shared film/page link
  history.replaceState(null, '', location.pathname + route);
  if (!LS.get('od:link')) {
    toast('Loading…');
    token().catch(() => {});                                               // overlap with the key derivation
    autoUnlock = unlockWithCode(urlCode)
      .then(() => { load(true); loadRatings(); })
      .catch(e => { console.warn(e); toast(''); $('#toast').hidden = true; openSetup(); $('#codeInput').value = urlCode; $('#codeMsg').textContent = 'That code did not work. Please check it and try again.'; })
      .finally(() => { autoUnlock = null; });
  }
}
if (/^#(link|tmdb)=/.test(location.hash)) {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('link') && h.get('link') !== LS.get('od:link')) { LS.set('od:link', h.get('link')); LS.del('od:files'); }
  if (h.get('tmdb')) LS.set('tmdb:key', h.get('tmdb'));
  history.replaceState(null, '', location.pathname);
}
if (location.hash === '#settings') { history.replaceState(null, '', location.pathname); setTimeout(openSetup, 0); }
render();
load();
loadRatings();
// Installable app (Add to Home Screen). Registration never blocks the page.
if ('serviceWorker' in navigator && location.protocol === 'https:') addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(e => console.warn('service worker', e)));
