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

const VIDEO_EXT = /\.(mkv|mp4|m4v|mov|avi|ts|m2ts|webm|wmv|flv)$/i;
const SUB_EXT = /\.(srt|ass|ssa|vtt)$/i;
const STRONG = /^(\d{3,4}p|blu-?ray|bdrip|brrip|web-?dl|webrip|web|hdtv|hdrip|dvdrip|uhd|4k|remux|hdr|hdr10\+?|dv|x26[45]|h\.?26[45]|hevc|avc|10bit|8bit|ddp?\d?(\.\d)?|aac\d?(\.\d)?|dts(-hd)?|truehd|atmos|cc|it|amzn|nf|ma)$/i;
const EDITION = /^(unrated|extended|dubbed|repack|proper|imax|remastered|directors|cut|uncut|criterion|multi|dual|limited|internal|bluray)$/i;

const state = { items: [], genre: 'All', q: '', sort: 'added', listedAt: 0 };

// ---------- OneDrive (anonymous share access) ----------
function shareId(link) {
  const b64 = btoa(unescape(encodeURIComponent(link.trim())));
  return 'u!' + b64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}
async function token(force) {
  const c = LS.get('od:token');
  if (!force && c && Date.parse(c.exp) - Date.now() > 3600e3) return c.token;
  const r = await fetch('https://api-badgerp.svc.ms/v1.0/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: BADGER_APP }),
  });
  if (!r.ok) throw new Error('Could not get access token ' + r.status);
  const j = await r.json();
  LS.set('od:token', { token: j.token, exp: j.expiryTimeUtc });
  return j.token;
}
async function odGet(url, retry = true) {
  const r = await fetch(url, { headers: { Authorization: 'Badger ' + await token(), Prefer: 'autoredeem' } });
  if (r.status === 401 && retry) { await token(true); return odGet(url, false); }
  if (!r.ok) throw new Error('OneDrive returned ' + r.status);
  return r.json();
}
async function listAll(link) {
  const sid = shareId(link);
  const out = [];
  async function walk(url, path, depth) {
    let next = url;
    while (next) {
      const j = await odGet(next);
      for (const c of j.value || []) {
        if (c.folder && depth < 4) {
          const d = c.parentReference?.driveId;
          await walk(`${API}/drives/${d}/items/${c.id}/children?$top=500&$expand=thumbnails`, path.concat(c.name), depth + 1).catch(e => console.warn('subfolder read failed', c.name, e));
        } else if (c.file) { c.__path = path; out.push(c); }
      }
      next = j['@odata.nextLink'];
    }
  }
  await walk(`${API}/shares/${sid}/driveitem/children?$top=500&$expand=thumbnails&$select=id,name,size,createdDateTime,lastModifiedDateTime,webUrl,file,folder,video,parentReference,@content.downloadUrl`, [], 0);
  return out;
}

// ---------- filename parsing ----------
function parseName(name) {
  let base = name.replace(/\.[a-z0-9]{2,4}$/i, m => (VIDEO_EXT.test(m) || SUB_EXT.test(m) ? '' : m));
  base = base.replace(/\[[^\]]*\]/g, ' ').replace(/[\u4e00-\u9fff]+/g, ' ');
  const ep = base.match(/^(.*?)[ ._-]+S(\d{1,2})[ ._-]?E(\d{1,3})/i);
  if (ep) {
    const title = ep[1].replace(/[._]+/g, ' ').trim();
    return { kind: 'series', title, season: +ep[2], episode: +ep[3], year: null };
  }
  const tok = base.split(/[ ._]+/).filter(Boolean);
  let q = tok.findIndex((t, i) => i > 0 && STRONG.test(t));
  if (q < 0) q = tok.length;
  let y = -1;
  for (let i = 1; i < q; i++) if (/^(19|20)\d\d$/.test(tok[i])) y = i;
  const tt = (y > 0 ? tok.slice(0, y) : tok.slice(0, q)).filter((t, i) => i === 0 || !EDITION.test(t));
  return { kind: 'movie', title: tt.join(' ').replace(/\s+-\s*$/, '').trim(), year: y > 0 ? +tok[y] : null };
}
const keyOf = p => (p.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()) + '|' + (p.year || '');

// ---------- metadata (Cinemeta, no API key) ----------
const TMDB_API = 'https://api.themoviedb.org/3';
const normT = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const wordsT = s => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
function titleScore(name, t) {
  if (normT(name) === normT(t)) return 100;
  const tw = wordsT(t), xw = wordsT(name), ov = tw.filter(w => xw.includes(w)).length;
  return ov + (xw[0] === tw[0] ? 0.5 : 0);
}
// TMDB search: returns full TMDB details (with external_ids) of the best match, or null
async function tmdbLookup(p, key, tmdbId) {
  const tv = p.kind === 'series', type = tv ? 'tv' : 'movie';
  const get = async u => (await fetch(`${TMDB_API}${u}${u.includes('?') ? '&' : '?'}api_key=${key}`)).json();
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
async function findMeta(p) {
  const ck = 'meta:' + p.kind + ':' + keyOf(p);
  const vk = 'meta3:' + p.kind + ':' + keyOf(p);
  const cached = LS.get(vk);
  const age = cached ? Date.now() - cached.t : Infinity;
  if (cached && (cached.ok ? age < 7 * 864e5 : age < 3 * 864e5)) return cached.ok ? cached.m : null;
  let m = null;
  try {
    const manual = LS.get('fix:' + p.kind + ':' + keyOf(p));
    let id = manual, td = null;
    const key = LS.get('tmdb:key');
    // 1) TMDB first (more accurate matching), unless a manual IMDb fix exists
    if (key) {
      try {
        if (manual) {
          const f = await (await fetch(`${TMDB_API}/find/${manual}?api_key=${key}&external_source=imdb_id`)).json();
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
        const j = await (await fetch(`${META}/catalog/${p.kind}/top/search=${encodeURIComponent(t)}.json`)).json();
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
    if (id) { try { d = (await (await fetch(`${META}/meta/${p.kind}/${id}.json`)).json()).meta; } catch {} }
    if (d || td) {
      const T = td || {}, I = 'https://image.tmdb.org/t/p/';
      const tYear = (T.release_date || T.first_air_date || '').slice(0, 4);
      const tRun = T.runtime || T.episode_run_time?.[0];
      m = {
        id: id || ('tmdb' + T.id), tmdbId: T.id || d?.moviedb_id,
        name: T.title || T.name || d?.name, year: tYear || d?.releaseInfo || d?.year,
        desc: T.overview || d?.description,
        rating: d?.imdbRating || (T.vote_average ? T.vote_average.toFixed(1) : ''),
        genres: (T.genres || []).map(g => g.name.replace('Science Fiction', 'Sci-Fi')).filter(Boolean).length ? T.genres.map(g => g.name.replace('Science Fiction', 'Sci-Fi')) : (d?.genres || d?.genre || []),
        cast: d?.cast || [], director: d?.director || (T.created_by || []).map(c => c.name), runtime: tRun ? tRun + ' min' : d?.runtime,
        poster: T.poster_path ? I + 'w500' + T.poster_path : (id ? `https://images.metahub.space/poster/medium/${id}/img` : ''),
        background: T.backdrop_path ? I + 'w1280' + T.backdrop_path : d?.background,
        country: (T.production_countries || []).map(c => c.name).join(', ') || d?.country,
        videos: (d?.videos || []).map(v => ({ s: v.season, e: v.episode, name: v.name || v.title, thumb: v.thumbnail, desc: v.overview || v.description })),
        logo: d?.logo || (id ? `https://images.metahub.space/logo/medium/${id}/img` : ''), writer: d?.writer || [], awards: d?.awards,
      };
    }
  } catch (e) { console.warn('meta', p.title, e); }
  if (!m && cached?.ok) { LS.set(vk, { ...cached, t: Date.now() }); return cached.m; }
  LS.set(vk, { ok: !!m, m, t: Date.now() });
  LS.del(ck);
  return m;
}
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
    const file = { id: v.id, name: v.name, size: v.size, url: v['@content.downloadUrl'], web: v.webUrl, added: Date.parse(v.lastModifiedDateTime || v.createdDateTime),
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
  LS.set('od:files', files.map(f => ({ id: f.id, name: f.name, size: f.size, '@content.downloadUrl': f['@content.downloadUrl'], webUrl: f.webUrl, createdDateTime: f.createdDateTime, lastModifiedDateTime: f.lastModifiedDateTime, video: f.video, file: f.file, thumbnails: f.thumbnails })));
  LS.set('od:listedAt', Date.now());
}
async function applyFiles(files) {
  const old = new Map(state.items.map(it => [it.key, it.meta]));
  const before = state.items.length;
  state.listedAt = LS.get('od:listedAt');
  state.items = buildItems(files);
  for (const it of state.items) if (old.has(it.key)) it.meta = old.get(it.key);
  render();
  await pool(state.items, 6, async it => { const m = await findMeta(it.parsed); if (m !== it.meta) { it.meta = m; scheduleRender(); } });
  render();
  applyErotic();
  return state.items.length - before;
}
async function load(force) {
  const link = LS.get('od:link');
  if (!link) { openSetup(); return; }
  if (loading) return; loading = true;
  try {
    const cached = LS.get('od:files');
    if (cached && !state.items.length && !force) await applyFiles(cached);
    else if (!cached) toast('Loading OneDrive…');
    const files = await listAll(link);
    saveFiles(files);
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
  if (txt.includes('\uFFFD')) { try { txt = new TextDecoder('gb18030').decode(buf); } catch {} }
  if (/\.(ass|ssa)$/i.test(s.name)) txt = assToSrt(txt);
  if (/\.vtt$/i.test(s.name)) return { url: URL.createObjectURL(new Blob([txt], { type: 'text/vtt' })), fmt: 'vtt' };
  return { url: URL.createObjectURL(new Blob([txt], { type: 'text/plain' })), fmt: 'srt' };
}


// ---------- OneDrive read-ahead source ----------
// The player's demuxer issues many small range reads. Each OneDrive request costs ~200-300 ms of latency,
// so we fetch big aligned blocks (in parallel), keep them in an LRU cache and prefetch ahead of playback.
class ODSource {
  constructor(file, refresh) {
    this.f = file; this.url = file.url; this.size = file.size; this.refresh = refresh;
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
    const parts = [];
    for (let i = first; i <= last; i++) parts.push(this._block(i, true));
    // prefetch ahead when reading forward (playback), not for one-off probes at the end of the file
    if (this.last >= 0 && first >= this.last && first - this.last <= 2) {
      const maxB = Math.floor((this.size - 1) / this.BS);
      for (let i = last + 1; i <= Math.min(maxB, last + this.AHEAD); i++) if (!this.cache.has(i)) this._block(i, false);
    }
    this.last = last;
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
// The player engine is ~11 MB, so it is only downloaded when you press play (and warmed up after the page is idle).
let playerLib = null;
function loadPlayerLib() { return playerLib ||= import('https://cdn.jsdelivr.net/npm/movi-player/dist/element.js'); }
(window.requestIdleCallback || (f => setTimeout(f, 4000)))(() => setTimeout(loadPlayerLib, 3000));
let player = null, saveTimer = 0, current = null;
async function play(fileId, restart) {
  let it, f;
  for (const x of state.items) for (const y of x.files) if (y.id === fileId) { it = x; f = y; }
  if (!f) return;
  f = await freshFile(f);
  current = { it, f };
  $('#ptitle').textContent = title(it) + (it.parsed.kind === 'series' ? ` · S${f.s}E${f.e}` : '');
  $('#player').hidden = false; document.body.style.overflow = 'hidden';
  const wrap = $('#pwrap'); wrap.innerHTML = '';
  await loadPlayerLib();
  await customElements.whenDefined('movi-player');
  player = document.createElement('movi-player');
  player.setAttribute('controls', ''); player.setAttribute('crossorigin', 'anonymous');
  player.setAttribute('fallback', 'native'); player.setAttribute('persist', 'volume speed subtitlelang audiolang');
  if (it.meta?.background) player.setAttribute('poster', it.meta.background);
  for (const s of f.subs) {
    try {
      const b = await subBlob(s);
      const tr = document.createElement('track');
      tr.kind = 'subtitles'; tr.label = /\.(ass|ssa)$/i.test(s.name) ? 'Subtitles (ASS)' : 'Subtitles'; tr.srclang = 'und'; tr.src = b.url;
      if (b.fmt === 'srt') tr.dataset.format = 'srt';
      if (s === f.subs[0]) tr.default = true;
      player.appendChild(tr);
    } catch (e) { console.warn('subtitle load failed', s.name, e); }
  }
  const fileRef = f;
  wrap.appendChild(player);
  player.sourceAdapter = new ODSource(f, async () => { await load(true); for (const x of state.items) for (const y of x.files) if (y.id === fileRef.id) return y.url; return null; });
  const saved = LS.get('pos:' + f.id);
  const startAt = !restart && saved && saved.t > 30 && saved.t < saved.d - 60 ? saved.t : 0;
  let seeked = false;
  const trySeek = () => { if (!seeked && startAt && player.duration > 0) { seeked = true; player.currentTime = startAt; } };
  player.addEventListener('loadedmetadata', trySeek);
  player.addEventListener('durationchange', trySeek);
  player.addEventListener('ended', () => { LS.del('pos:' + f.id); });
  clearInterval(saveTimer);
  saveTimer = setInterval(() => {
    if (!player || !player.duration || player.paused) return;
    if (player.currentTime > 5) LS.set('pos:' + f.id, { t: player.currentTime, d: player.duration, at: Date.now() });
  }, 5000);
  setTimeout(() => { trySeek(); player.play?.().catch(() => {}); }, 300);
}
function closePlayer() {
  if (player && current && player.duration && player.currentTime > 5) LS.set('pos:' + current.f.id, { t: player.currentTime, d: player.duration, at: Date.now() });
  clearInterval(saveTimer);
  try { player?.pause(); } catch {}
  $('#pwrap').innerHTML = ''; player = null; current = null;
  $('#player').hidden = true; document.body.style.overflow = '';
  render();
}


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
const posterOf = it => it.meta?.id ? it.meta.poster : it.files[0].thumb;
const bgOf = it => it.meta?.background || it.files[0].thumb || '';
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
  return `<a class="card" href="#/t/${enc(it.key)}">
    <div class="pos"><div class="ph">${opts.wide ? '' : esc(title(it))}</div>${img ? `<img loading="lazy" src="${esc(img)}" alt="${esc(title(it))}" data-fb="${esc(f.thumb || '')}" onerror="if(this.dataset.fb&&this.src!==this.dataset.fb){this.src=this.dataset.fb}else{this.remove()}">` : ''}
      ${q ? `<span class="q">${q}</span>` : ''}
      ${pct > 1 ? `<div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>` : ''}</div>
    ${opts.caption ? `<div class="cap">${esc(title(it))}</div><div class="sub">${esc(opts.caption)}</div>` : ''}</a>`;
}
function row(name, list, opts = {}) {
  if (!list.length) return '';
  return `<section class="row ${opts.wide ? 'wide' : ''}"><h2>${esc(name)}</h2><div class="scroller">${list.map(it => card(it, { wide: opts.wide, caption: opts.caption?.(it) })).join('')}</div></section>`;
}
const setAmbient = url => { $('#ambient').style.backgroundImage = url ? `url("${url}")` : 'none'; };

// ---------- views ----------
const hero = { idx: 0, timer: 0, paused: false, list: [] };
function viewHome() {
  const items = state.items;
  const byAdded = [...items].sort((a, b) => b.added - a.added);
  hero.list = byAdded.filter(it => it.meta?.background).slice(0, 6);
  if (hero.idx >= hero.list.length) hero.idx = 0;
  const cw = items.map(it => ({ it, p: progressOf(it) })).filter(x => x.p && x.p.t > 30 && x.p.t < x.p.d - 120).sort((a, b) => b.p.at - a.p.at).map(x => x.it);
  const rated = items.filter(it => parseFloat(it.meta?.rating) >= 7).sort((a, b) => parseFloat(b.meta.rating) - parseFloat(a.meta.rating));
  const gcount = new Map();
  for (const it of items) for (const g of it.meta?.genres || []) gcount.set(g, (gcount.get(g) || 0) + 1);
  const genres = [...gcount.entries()].filter(x => x[1] >= 3).sort((a, b) => b[1] - a[1]).slice(0, 6).map(x => x[0]);
  const shows = items.filter(it => it.parsed.kind === 'series');
  const classics = items.filter(it => parseInt(yearOf(it), 10) && parseInt(yearOf(it), 10) < 2000).sort((a, b) => yearOf(a) - yearOf(b));
  const slides = hero.list.map((it, i) => `<div class="slide ${i === hero.idx ? 'on' : ''}" data-i="${i}">
      <div class="bg" style="background-image:url('${esc(bgOf(it))}')"></div>
      <div class="hcontent">${titleBlock(it)}${metaRow(it)}<p class="desc">${esc(it.meta?.desc || '')}</p>
        <div class="hbtns"><button class="pill" data-play-item="${esc(it.key)}">${I.play}${progressOf(it)?.t > 30 ? 'RESUME' : 'PLAY'}</button>
        <span class="duo lg"><a href="#/t/${enc(it.key)}" aria-label="Details">${I.info}</a></span></div></div></div>`).join('');
  return `${hero.list.length ? `<section class="hero">${slides}
      <div class="dots"><button class="pp" id="heroPause" aria-label="Pause slideshow">${hero.paused ? I.play : I.pause}</button>${hero.list.map((_, i) => `<button data-slide="${i}" class="${i === hero.idx ? 'on' : ''}" aria-label="Slide ${i + 1}"></button>`).join('')}</div></section>` : '<div style="height:130px"></div>'}
    <div class="rows" ${hero.list.length ? '' : 'style="margin-top:0"'}>
      ${row('Continue watching', cw, { wide: true, caption: it => { const p = progressOf(it); return `${fmtTime(p.d - p.t)} left`; } })}
      ${row('Recently added', byAdded.slice(0, 20))}
      ${row('Top rated', rated)}
      ${row('Shows', shows)}
      ${genres.map(g => row(g, items.filter(it => it.meta?.genres?.includes(g)))).join('')}
      ${row('Classics', classics)}
      ${!items.length ? '<p class="empty">No titles loaded yet.</p>' : ''}
    </div>`;
}
function viewList(kind) {
  const list = state.items.filter(it => it.parsed.kind === kind).sort((a, b) => b.added - a.added);
  setAmbient(list[0] ? bgOf(list[0]) : '');
  return `<div class="page"><h1>${kind === 'movie' ? 'Movies' : 'Shows'} <span style="color:var(--dim);font-size:18px">${list.length}</span></h1>
    <div class="grid">${list.map(it => card(it, { caption: [yearOf(it), it.meta?.runtime].filter(Boolean).join(' · ') })).join('') || '<p class="empty">Nothing here yet</p>'}</div></div>`;
}
function viewGenres(sel) {
  const gcount = new Map();
  for (const it of state.items) for (const g of it.meta?.genres || []) gcount.set(g, (gcount.get(g) || 0) + 1);
  const gs = [...gcount.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  sel = sel && gs.includes(sel) ? sel : gs[0];
  const list = state.items.filter(it => it.meta?.genres?.includes(sel)).sort((a, b) => (parseFloat(b.meta?.rating) || 0) - (parseFloat(a.meta?.rating) || 0));
  setAmbient(list[0] ? bgOf(list[0]) : '');
  return `<div class="page"><h1>Genres</h1><div class="chips">${gs.map(g => `<button data-genre="${esc(g)}" class="${g === sel ? 'on' : ''}">${esc(g)} · ${gcount.get(g)}</button>`).join('')}</div>
    <div class="grid">${list.map(it => card(it, { caption: [yearOf(it), it.meta?.rating ? '★ ' + it.meta.rating : ''].filter(Boolean).join(' · ') })).join('')}</div></div>`;
}
// ---------- TMDB credits (cast photos) ----------
const TMDB_IMG = 'https://image.tmdb.org/t/p/w300';
const creditsPending = new Set();
function creditsOf(it) {
  const id = it.meta?.id; if (!id) return null;
  const c = LS.get('tmdbc:' + id);
  if (c && Date.now() - (c.t || 0) < 7 * 864e5) return c;
  const key = LS.get('tmdb:key');
  if (key && !creditsPending.has(id)) {
    creditsPending.add(id);
    (async () => {
      try {
        let hit, f = { movie_results: [], tv_results: [] };
        if (it.meta.tmdbId) { hit = { id: it.meta.tmdbId }; if (it.parsed.kind === 'series') f.tv_results = [hit]; else f.movie_results = [hit]; }
        else { f = await (await fetch(`https://api.themoviedb.org/3/find/${id}?api_key=${key}&external_source=imdb_id`)).json(); hit = (f.movie_results || [])[0] || (f.tv_results || [])[0]; }
        if (!hit) { LS.set('tmdbc:' + id, { cast: [], crew: [], t: Date.now() }); return; }
        const tv = !(f.movie_results || [])[0];
        const cr = await (await fetch(`https://api.themoviedb.org/3/${tv ? 'tv' : 'movie'}/${hit.id}/${tv ? 'aggregate_credits' : 'credits'}?api_key=${key}`)).json();
        const cast = (cr.cast || []).slice(0, 20).map(p => ({ n: p.name, r: p.character || p.roles?.[0]?.character || '', p: p.profile_path }));
        const crew = (cr.crew || []).filter(p => p.job === 'Director' || p.jobs?.some(j => j.job === 'Director')).slice(0, 3).map(p => ({ n: p.name, r: 'Director', p: p.profile_path }));
        LS.set('tmdbc:' + id, { cast, crew, t: Date.now() });
        if (location.hash.includes(enc(it.key))) render();
      } catch (e) { console.warn('tmdb', e); }
    })();
  }
  return c || null;
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
  } catch (e) { console.warn('ratings', e); }
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

function ratingsHtml(it) {
  const m = it.meta || {}, r = ratingsOf(it) || {}, id = /^tt/.test(m.id || '') ? m.id : '';
  const q = encodeURIComponent(m.name || it.parsed.title);
  const imdbU = r.imdb?.u || (id ? `https://www.imdb.com/title/${id}/` : `https://www.imdb.com/find/?q=${q}`);
  const imdbV = r.imdb?.v || m.rating;
  const rtU = r.rt?.u || `https://www.rottentomatoes.com/search?search=${q}`;
  const dbU = r.db?.u || `https://search.douban.com/movie/subject_search?search_text=${id || q}`;
  const ICON = {
    imdb: '<b class="ic imdbmark">IMDb</b>',
    fresh: '<svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="13.6" r="9.2" fill="#fa320a"/><ellipse cx="8.6" cy="10.6" rx="2.2" ry="1.3" fill="#ff8a6b" opacity=".55" transform="rotate(-30 8.6 10.6)"/><path fill="#00912d" d="M12.1 5.6c-.9-1.9-2.9-2.8-4.9-2.4 1.6.6 2.6 1.6 3 2.6-1.9-.9-4-.6-5.4.7 2-.1 3.6.4 4.6 1.4-1 .7-1.6 1.9-1.5 3.2 1-1.1 2.3-1.7 3.6-1.6.9 1.1 2.2 1.6 3.6 1.5-1-.8-1.4-1.9-1.4-2.9 1.4-.2 2.9.2 4 1.1-.4-1.7-1.8-2.9-3.4-3.3.8-.7 1.9-1 3-1-1.5-.9-3.5-.7-4.7.3-.1-.6-.3-1.1-.5-1.6z"/></svg>',
    rotten: '<svg viewBox="0 0 24 24" class="ic"><path fill="#0fc755" d="M12 2.6c.9 0 1.2 1.7 2 2.1.9.4 2.2-.8 3-.2.7.6-.3 2 .1 2.8.4.9 2.3.8 2.6 1.7.3.9-1.3 1.6-1.3 2.6 0 .9 1.7 1.6 1.4 2.5-.3.9-2.2.6-2.7 1.4-.5.8.5 2.4-.2 3-.7.6-2.1-.6-3-.2-.8.4-1 2.3-1.9 2.3s-1.2-1.8-2-2.2c-.9-.4-2.3.8-3 .2-.8-.6.2-2.1-.2-2.9-.5-.8-2.4-.6-2.7-1.5-.3-.9 1.4-1.6 1.4-2.5S2.1 11.1 2.4 10.2c.3-.9 2.2-.8 2.6-1.6.4-.8-.6-2.3.1-2.9.7-.6 2.1.6 3 .2.8-.4 1-2.3 1.9-2.3z"/></svg>',
    douban: '<svg viewBox="0 0 24 24" class="ic"><rect width="24" height="24" rx="5.5" fill="#00b51d"/><text x="12" y="17.6" text-anchor="middle" font-family="PingFang SC,Hiragino Sans GB,Microsoft YaHei,sans-serif" font-weight="700" font-size="15" fill="#fff">\u8c46</text></svg>',
  };
  const rtPct = parseInt(r.rt?.v || '', 10);
  const a = (cls, icon, label, val, url) => `<a class="rate ${cls}" href="${esc(url)}" target="_blank" rel="noopener" title="${label}">${icon}<span>${esc(val || '–')}</span></a>`;
  return `<div class="rates">${a('imdb', ICON.imdb, 'IMDb', imdbV ? imdbV : '', imdbU)}${a('rt', isNaN(rtPct) || rtPct >= 60 ? ICON.fresh : ICON.rotten, 'Rotten Tomatoes (critics)', r.rt?.v || '', rtU)}${a('db', ICON.douban, 'Douban', r.db?.v || '', dbU)}</div>`;
}

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
  const hue = s => [...s].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  const similar = state.items.filter(x => x !== it && (x.meta?.genres || []).some(g => (m.genres || []).includes(g)))
    .map(x => ({ x, s: (x.meta.genres || []).filter(g => (m.genres || []).includes(g)).length })).sort((a, b) => b.s - a.s).slice(0, 15).map(o => o.x);
  const face = p => p.p
    ? `<div class="face" style="background:#222 url('${TMDB_IMG}${esc(p.p)}') center/cover"></div>`
    : `<div class="face" style="background:linear-gradient(160deg,hsl(${hue(p.n)} 35% 32%),hsl(${(hue(p.n) + 40) % 360} 30% 16%))">${esc(p.n.split(' ').map(w => w[0]).slice(0, 2).join(''))}</div>`;
  const subsTxt = f.subs.length ? 'Subtitles: ' + f.subs.map(s => s.name.split('.').pop().toUpperCase()).join('/') : '';
  return `<div class="detail"><div class="bg" style="background-image:url('${esc(bgOf(it))}')"></div>
    <div class="dtop"><div class="dleft">${titleBlock(it)}${metaRow(it, true)}
      <p class="desc">${esc(m.desc || 'No details found for this title. Use the edit button below to fix the match.')}</p>
      <div class="hbtns">
        ${isS ? `<button class="pill" data-play="${esc((pr?.f || f).id)}">${I.play}${pr ? 'RESUME S' + pr.f.s + 'E' + pr.f.e : 'PLAY'}</button>`
              : `<button class="pill" data-play="${esc(f.id)}">${I.play}${resume ? 'RESUME ' + fmtTime(pr.t) : 'PLAY'}</button>`}
        ${resume && !isS ? `<span class="duo lg"><button data-play="${esc(f.id)}" data-restart title="Start over">${I.restart}</button></span>` : ''}
      </div>
      <div class="fileinfo">${it.files.length === 1 ? `${esc(f.name)}<br>${[fmtSize(f.size), f.video?.width ? f.video.width + '×' + f.video.height : '', f.video?.fourCC, subsTxt].filter(Boolean).map(esc).join(' · ')}` : `${it.files.length} files · ${fmtSize(it.files.reduce((a, x) => a + x.size, 0))}`}</div>
    </div>
    <div class="infobox lg"><dl>${infos.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v === '__RATINGS__' ? ratingsHtml(it) : esc(v)}</dd>`).join('')}</dl></div></div>
    ${isS ? `<section class="row"><h2>Episodes</h2><div class="eps">${it.files.map(x => { const e = epName(x.s, x.e), p = LS.get('pos:' + x.id); return `<div class="ep" data-play="${esc(x.id)}"><img loading="lazy" src="${esc(e.thumb || x.thumb || '')}" alt="" onerror="this.style.visibility='hidden'"><div><div class="t">${x.e}. ${esc(e.name || 'Episode ' + x.e)}</div><div class="m">S${x.s}E${String(x.e).padStart(2, '0')} · ${fmtSize(x.size)}${p && p.d ? ' · Watched to ' + fmtTime(p.t) : ''}</div></div></div>`; }).join('')}</div></section>` : ''}
    ${people.length ? `<section class="row"><h2>Cast</h2><div class="cast">${people.map(p => `<div class="person">${face(p)}<div class="n">${esc(p.n)}</div><div class="r">${esc(p.r)}</div></div>`).join('')}</div></section>` : ''}
    ${row('More like this', similar)}
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
  const id = `lg-${W}x${H}-${R}`;
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
function applyGlass() {
  if (!GLASS_ON) return;
  document.querySelectorAll('.lg').forEach(el => {
    const W = Math.round(el.offsetWidth), H = Math.round(el.offsetHeight);
    if (!W || !H) return;
    const R = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, W / 2, H / 2);
    const bezel = Math.max(12, Math.min(R, Math.min(W, H) * .42, 40));
    const S = Math.round(bezel * 3.2);
    const id = glassFilter(W, H, Math.round(R), Math.round(bezel), S);
    el.style.backdropFilter = `url(#${id}) blur(.6px) saturate(1.5) brightness(1.05)`;
  });
}
let glassT = 0;
window.addEventListener('resize', () => { clearTimeout(glassT); glassT = setTimeout(applyGlass, 150); });

// ---------- router ----------
function routeInfo() {
  const h = location.hash.replace(/^#/, '') || '/';
  if (h.startsWith('/t/')) return { name: 'detail', arg: decodeURIComponent(h.slice(3)) };
  if (h.startsWith('/movies')) return { name: 'movies' };
  if (h.startsWith('/shows')) return { name: 'shows' };
  if (h.startsWith('/genres')) return { name: 'genres', arg: decodeURIComponent(h.split('/')[2] || '') };
  return { name: 'home' };
}
let lastRoute = '';
function render() {
  const r = routeInfo();
  const sig = location.hash;
  const keepScroll = sig === lastRoute;
  const y = scrollY;
  let html = '';
  if (r.name === 'detail') html = viewDetail(r.arg);
  else if (r.name === 'movies') html = viewList('movie');
  else if (r.name === 'shows') html = viewList('series');
  else if (r.name === 'genres') html = viewGenres(r.arg);
  else html = viewHome();
  $('#view').innerHTML = html;
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.route === (r.name === 'detail' ? '' : r.name)));
  if (r.name === 'home') { startHero(); if (hero.list[hero.idx]) setAmbient(bgOf(hero.list[hero.idx])); } else stopHero();
  scrollTo(0, keepScroll ? y : 0);
  lastRoute = sig;
  if (!$('#search').hidden) renderSearch();
  requestAnimationFrame(applyGlass);
}
function showSlide(i) {
  if (!hero.list.length) return;
  hero.idx = (i + hero.list.length) % hero.list.length;
  document.querySelectorAll('.slide').forEach(s => s.classList.toggle('on', +s.dataset.i === hero.idx));
  document.querySelectorAll('.dots [data-slide]').forEach(d => d.classList.toggle('on', +d.dataset.slide === hero.idx));
  setAmbient(bgOf(hero.list[hero.idx]));
}
function startHero() { stopHero(); if (!hero.paused && hero.list.length > 1) hero.timer = setInterval(() => showSlide(hero.idx + 1), 8000); }
function stopHero() { clearInterval(hero.timer); }
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
function renderSearch() {
  const words = fold($('#q').value).split(/\s+/).filter(Boolean);
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
  $('#results').innerHTML = (words.length ? `<p class="empty" style="grid-column:1/-1;margin:0;padding:0">${list.length} result${list.length === 1 ? '' : 's'}</p>` : '') +
    (list.map(it => card(it, { caption: [yearOf(it), (it.meta?.genres || [])[0]].filter(Boolean).join(' · ') })).join('') || '<p class="empty">No results</p>');
}
function openSearch() { $('#search').hidden = false; document.body.style.overflow = 'hidden'; renderSearch(); setTimeout(() => $('#q').focus(), 50); }
function closeSearch() { $('#search').hidden = true; document.body.style.overflow = ''; }
$('#q').oninput = renderSearch;
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
$('#clearCache').onclick = () => { Object.keys(localStorage).filter(k => /^(meta3?|tmdbc):/.test(k)).forEach(k => localStorage.removeItem(k)); $('#setup').hidden = true; load(true); };

// ---------- events ----------
document.addEventListener('click', e => {
  const t = e.target;
  const pl = t.closest('[data-play]');
  if (pl) { e.preventDefault(); closeSearch(); play(pl.dataset.play, pl.hasAttribute('data-restart')); return; }
  const pi = t.closest('[data-play-item]');
  if (pi) { const it = state.items.find(x => x.key === pi.dataset.playItem); const p = progressOf(it); play((p?.f || it.files[0]).id); return; }
  const sl = t.closest('[data-slide]');
  if (sl) { showSlide(+sl.dataset.slide); startHero(); return; }
  if (t.closest('#heroPause')) { hero.paused = !hero.paused; t.closest('#heroPause').innerHTML = hero.paused ? I.play : I.pause; hero.paused ? stopHero() : startHero(); return; }
  const g = t.closest('[data-genre]');
  if (g) { location.hash = '#/genres/' + enc(g.dataset.genre); return; }
  if (t.closest('[data-close-search]')) { closeSearch(); return; }
  if (t.closest('#search .card')) { closeSearch(); return; }
});
$('#pclose').onclick = closePlayer;
document.addEventListener('keydown', e => {
  if (e.key === '/' && $('#search').hidden && $('#player').hidden && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); openSearch(); return; }
  if (e.key !== 'Escape') return;
  if (!$('#player').hidden && !document.fullscreenElement) closePlayer();
  else if (!$('#search').hidden) closeSearch();
  else if (!$('#setup').hidden) $('#setup').hidden = true;
});

// link via URL hash (#link=...) for quick setup on a new device
const urlCode = new URLSearchParams(location.search).get('code') || new URLSearchParams(location.hash.slice(1)).get('code');
if (urlCode) {
  history.replaceState(null, '', location.pathname);
  if (!LS.get('od:link')) setTimeout(() => { openSetup(); $('#codeInput').value = urlCode; tryUnlock(urlCode); }, 0);
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
