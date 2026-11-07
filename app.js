// 我的影院: OneDrive share link -> poster wall -> in-browser playback (Movi Player)
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

const state = { items: [], genre: '全部', q: '', sort: 'added', listedAt: 0 };

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
  if (!r.ok) throw new Error('获取访问令牌失败 ' + r.status);
  const j = await r.json();
  LS.set('od:token', { token: j.token, exp: j.expiryTimeUtc });
  return j.token;
}
async function odGet(url, retry = true) {
  const r = await fetch(url, { headers: { Authorization: 'Badger ' + await token(), Prefer: 'autoredeem' } });
  if (r.status === 401 && retry) { await token(true); return odGet(url, false); }
  if (!r.ok) throw new Error('OneDrive 返回 ' + r.status);
  return r.json();
}
async function listAll(link) {
  const sid = shareId(link);
  const root = await odGet(`${API}/shares/${sid}/driveitem`);
  const out = [];
  async function walk(url, path, depth) {
    let next = url;
    while (next) {
      const j = await odGet(next);
      for (const c of j.value || []) {
        if (c.folder && depth < 4) {
          const d = c.parentReference?.driveId || root.parentReference?.driveId;
          await walk(`${API}/drives/${d}/items/${c.id}/children?$top=500&$expand=thumbnails`, path.concat(c.name), depth + 1).catch(e => console.warn('子文件夹读取失败', c.name, e));
        } else if (c.file) { c.__path = path; out.push(c); }
      }
      next = j['@odata.nextLink'];
    }
  }
  await walk(`${API}/shares/${sid}/driveitem/children?$top=500&$expand=thumbnails`, [], 0);
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
async function findMeta(p) {
  const ck = 'meta:' + p.kind + ':' + keyOf(p);
  const cached = LS.get(ck);
  if (cached && (cached.ok || Date.now() - cached.t < 3 * 864e5)) return cached.ok ? cached.m : null;
  let m = null;
  try {
    const manual = LS.get('fix:' + p.kind + ':' + keyOf(p));
    let id = manual;
    if (!id) {
      const tries = [p.title];
      if (/^the /i.test(p.title)) tries.push(p.title.slice(4));
      for (const t of tries) {
        const j = await (await fetch(`${META}/catalog/${p.kind}/top/search=${encodeURIComponent(t)}.json`)).json();
        const list = j.metas || [];
        const yr = x => parseInt(x.releaseInfo || x.year || '0', 10);
        const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
        const words = s => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
        const tw = words(t);
        const score = x => {
          if (norm(x.name) === norm(t)) return 100;
          const xw = words(x.name), ov = tw.filter(w => xw.includes(w)).length;
          return ov + (xw[0] === tw[0] ? 0.5 : 0);
        };
        let hit = null, best = 0;
        for (const x of list) {
          const dy = p.year ? Math.abs(yr(x) - p.year) : 0;
          if (dy > 1) continue;
          const s = score(x) - dy * 0.3;
          if (s > best) { best = s; hit = x; }
        }
        if (hit && best < 1) hit = null;
        if (!hit && p.year) hit = list.slice(0, 3).find(x => yr(x) === p.year) || null;
        if (!hit && !p.year) hit = list[0] || null;
        if (hit) { id = hit.imdb_id || hit.id; break; }
      }
    }
    if (id) {
      const d = (await (await fetch(`${META}/meta/${p.kind}/${id}.json`)).json()).meta;
      if (d) m = {
        id, name: d.name, year: d.releaseInfo || d.year, desc: d.description, rating: d.imdbRating,
        genres: d.genres || d.genre || [], cast: d.cast || [], director: d.director || [], runtime: d.runtime,
        poster: `https://images.metahub.space/poster/medium/${id}/img`, background: d.background, country: d.country,
        videos: (d.videos || []).map(v => ({ s: v.season, e: v.episode, name: v.name || v.title })),
      };
    }
  } catch (e) { console.warn('meta', p.title, e); }
  LS.set(ck, { ok: !!m, m, t: Date.now() });
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

async function load(force) {
  const link = LS.get('od:link');
  if (!link) { openSetup(); return; }
  $('#status').textContent = '正在读取 OneDrive…';
  try {
    let files = !force && LS.get('od:files');
    const fresh = files && Date.now() - (LS.get('od:listedAt') || 0) < 40 * 60e3;
    if (!fresh) {
      files = await listAll(link);
      LS.set('od:files', files.map(f => ({ id: f.id, name: f.name, size: f.size, '@content.downloadUrl': f['@content.downloadUrl'], webUrl: f.webUrl, createdDateTime: f.createdDateTime, lastModifiedDateTime: f.lastModifiedDateTime, video: f.video, file: f.file, thumbnails: f.thumbnails })));
      LS.set('od:listedAt', Date.now());
    }
    state.listedAt = LS.get('od:listedAt');
    state.items = buildItems(files);
    render();
    $('#status').textContent = `共 ${state.items.length} 部，正在获取海报和影片信息…`;
    await pool(state.items, 6, async it => { it.meta = await findMeta(it.parsed); scheduleRender(); });
    $('#status').textContent = `共 ${state.items.length} 部`;
    render();
  } catch (e) {
    console.error(e);
    $('#status').innerHTML = `读取失败：${esc(e.message)}。<button class="ghost small" id="retry">重试</button>`;
    $('#retry').onclick = () => load(true);
  }
}
async function freshFile(f) {
  if (Date.now() - state.listedAt < 40 * 60e3) return f;
  await load(true);
  for (const it of state.items) for (const x of it.files) if (x.id === f.id) return x;
  return f;
}

// ---------- render ----------
let rt = 0;
function scheduleRender() { clearTimeout(rt); rt = setTimeout(render, 250); }
const title = it => it.meta?.name || it.parsed.title;
const fmtSize = b => b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(0) + ' MB';
const fmtTime = s => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
function quality(f) {
  const n = f.name; const w = f.video?.width || 0;
  if (/2160p|4k|uhd/i.test(n) || w >= 3000) return '4K';
  if (/1080p/i.test(n) || w >= 1800) return '1080p';
  if (/720p/i.test(n) || w >= 1200) return '720p';
  return '';
}
function progressOf(it) {
  let best = null;
  for (const f of it.files) { const p = LS.get('pos:' + f.id); if (p && (!best || p.at > best.at)) best = { ...p, f }; }
  return best;
}
function filtered() {
  const q = state.q.trim().toLowerCase();
  let list = state.items.filter(it => {
    if (state.genre !== '全部' && !(it.meta?.genres || []).includes(state.genre)) return false;
    if (!q) return true;
    const hay = [title(it), it.parsed.title, ...(it.meta?.cast || []), ...(it.meta?.director || []), ...(it.meta?.genres || []), it.files.map(f => f.name).join(' ')].join(' ').toLowerCase();
    return hay.includes(q);
  });
  const yr = it => parseInt(it.meta?.year || it.parsed.year || 0, 10);
  const s = { added: (a, b) => b.added - a.added, year: (a, b) => yr(b) - yr(a), rating: (a, b) => (parseFloat(b.meta?.rating) || 0) - (parseFloat(a.meta?.rating) || 0), title: (a, b) => title(a).localeCompare(title(b)) }[state.sort];
  return list.sort(s);
}
function render() {
  // genres
  const g = new Map();
  for (const it of state.items) for (const x of it.meta?.genres || []) g.set(x, (g.get(x) || 0) + 1);
  const gl = ['全部', ...[...g.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0])];
  $('#genres').innerHTML = gl.map(x => `<button class="${x === state.genre ? 'on' : ''}" data-g="${esc(x)}">${esc(x)}</button>`).join('');
  // continue watching
  const cw = state.items.map(it => ({ it, p: progressOf(it) })).filter(x => x.p && x.p.t > 30 && x.p.t < x.p.d - 120).sort((a, b) => b.p.at - a.p.at).slice(0, 12);
  $('#continue').hidden = !cw.length;
  $('#continueRow').innerHTML = cw.map(({ it, p }) => `<div class="cw" data-k="${esc(it.key)}" data-play="${esc(p.f.id)}">
    <img loading="lazy" src="${esc(it.meta?.background || p.f.thumb || '')}" alt=""><div class="bar" style="width:${(p.t / p.d * 100).toFixed(1)}%"></div>
    <div class="t">${esc(title(it))}${it.parsed.kind === 'series' ? ` · S${p.f.s}E${p.f.e}` : ''} · 剩 ${fmtTime(p.d - p.t)}</div></div>`).join('');
  // wall
  const week = Date.now() - 7 * 864e5;
  $('#wall').innerHTML = filtered().map(it => {
    const m = it.meta || {}, f = it.files[0], pr = progressOf(it);
    const poster = m.id ? m.poster : f.thumb;
    const meta = [m.year || it.parsed.year, m.runtime, it.parsed.kind === 'series' ? `${it.files.length} 集` : null].filter(Boolean).join(' · ');
    const d = m.desc ? (m.desc.length > 150 ? m.desc.slice(0, 148) + '…' : m.desc) : '';
    return `<div class="card" data-k="${esc(it.key)}">
      <div class="poster">${poster ? `<img loading="lazy" src="${esc(poster)}" alt="" onerror="this.remove()">` : ''}
        ${!m.id ? `<div class="ph">${esc(it.parsed.title)}</div>` : ''}
        ${m.rating ? `<span class="badge">★ ${esc(m.rating)}</span>` : ''}
        ${quality(f) ? `<span class="badge q">${quality(f)}</span>` : ''}
        ${it.added > week ? '<span class="badge new">新</span>' : ''}
        ${pr && pr.d ? `<div class="prog" style="width:${(pr.t / pr.d * 100).toFixed(1)}%"></div>` : ''}
      </div>
      <div class="info"><div class="t">${esc(title(it))}</div><div class="m">${esc(meta)}</div>
        ${(m.genres || []).length ? `<div class="g">${m.genres.slice(0, 3).map(x => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
        ${d ? `<div class="d">${esc(d)}</div>` : ''}</div></div>`;
  }).join('') || (state.items.length ? '<p style="color:var(--muted)">没有符合条件的影片</p>' : '');
}

// ---------- detail ----------
function openDetail(key) {
  const it = state.items.find(x => x.key === key); if (!it) return;
  const m = it.meta || {}, f = it.files[0], pr = progressOf(it);
  const v = f.video || {};
  const bg = m.background || f.thumb || '';
  const isS = it.parsed.kind === 'series';
  const epName = (s, e) => (m.videos || []).find(x => x.s === s && x.e === e)?.name || '';
  $('#detail').innerHTML = `<div class="dwrap">
    <div class="hero" style="background-image:url('${esc(bg)}')"><button class="ghost x" data-close>✕</button></div>
    <div class="dbody">
      <img class="p" src="${esc(m.id ? m.poster : f.thumb || '')}" alt="" onerror="this.style.visibility='hidden'">
      <div class="dmain">
        <h1>${esc(title(it))}</h1>
        <div class="m">${[m.year || it.parsed.year, m.runtime, m.country].filter(Boolean).map(esc).join(' · ')}${m.rating ? ` · <b>IMDb ★ ${esc(m.rating)}</b>` : ''}</div>
        <div class="actions">
          ${!isS ? `<button data-play="${esc(f.id)}">${pr && pr.t > 30 ? '从 ' + fmtTime(pr.t) + ' 继续' : '▶ 播放'}</button>
          ${pr && pr.t > 30 ? `<button class="ghost" data-play="${esc(f.id)}" data-restart>从头播放</button>` : ''}` : ''}
          <a href="${esc(f.web)}" target="_blank" rel="noopener"><button class="ghost">在 OneDrive 打开</button></a>
          <button class="ghost" data-fix>修正匹配</button>
        </div>
        ${m.genres?.length ? `<div class="kv">类型：<span>${esc(m.genres.join(' / '))}</span></div>` : ''}
        ${m.director?.length ? `<div class="kv">导演：<span>${esc(m.director.join('、'))}</span></div>` : ''}
        ${m.cast?.length ? `<div class="kv">主演：<span>${esc(m.cast.join('、'))}</span></div>` : ''}
        ${m.desc ? `<p class="desc">${esc(m.desc)}</p>` : '<p class="desc" style="color:var(--muted)">没找到这部片的资料，可以点“修正匹配”输入 IMDb 编号（例如 tt0274812）或英文片名。</p>'}
        ${isS ? `<div class="eps">${it.files.map(x => { const p = LS.get('pos:' + x.id); return `<div class="ep"><span>S${x.s}E${String(x.e).padStart(2, '0')} ${esc(epName(x.s, x.e))}${p && p.d ? ` <small style="color:var(--muted)">· 看到 ${fmtTime(p.t)}</small>` : ''}</span><button class="small" data-play="${esc(x.id)}">▶</button></div>`; }).join('')}</div>` : ''}
        ${it.files.map(x => `<div class="file">${esc(x.name)}<br>${[fmtSize(x.size), x.video?.width ? x.video.width + '×' + x.video.height : '', x.video?.fourCC, x.subs.length ? '字幕：' + x.subs.map(s => s.name.split('.').pop()).join(', ') : '无外挂字幕'].filter(Boolean).map(esc).join(' · ')}</div>`).join('')}
      </div>
    </div></div>`;
  $('#detail').hidden = false;
  $('#detail').dataset.k = key;
  document.body.style.overflow = 'hidden';
}
function closeDetail() { $('#detail').hidden = true; document.body.style.overflow = ''; }

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

// ---------- player ----------
let player = null, saveTimer = 0, current = null;
async function play(fileId, restart) {
  let it, f;
  for (const x of state.items) for (const y of x.files) if (y.id === fileId) { it = x; f = y; }
  if (!f) return;
  f = await freshFile(f);
  closeDetail();
  current = { it, f };
  $('#ptitle').textContent = title(it) + (it.parsed.kind === 'series' ? ` · S${f.s}E${f.e}` : '');
  $('#player').hidden = false; document.body.style.overflow = 'hidden';
  const wrap = $('#pwrap'); wrap.innerHTML = '';
  player = document.createElement('movi-player');
  player.setAttribute('controls', ''); player.setAttribute('crossorigin', 'anonymous');
  player.setAttribute('fallback', 'native'); player.setAttribute('persist', 'volume speed subtitlelang audiolang');
  if (it.meta?.background) player.setAttribute('poster', it.meta.background);
  for (const s of f.subs) {
    try {
      const b = await subBlob(s);
      const tr = document.createElement('track');
      tr.kind = 'subtitles'; tr.label = /\.(ass|ssa)$/i.test(s.name) ? '外挂字幕 (ASS)' : '外挂字幕'; tr.srclang = 'zh'; tr.src = b.url;
      if (b.fmt === 'srt') tr.dataset.format = 'srt';
      if (s === f.subs[0]) tr.default = true;
      player.appendChild(tr);
    } catch (e) { console.warn('字幕加载失败', s.name, e); }
  }
  player.setAttribute('src', f.url);
  wrap.appendChild(player);
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

// ---------- setup ----------
function openSetup() { $('#linkInput').value = LS.get('od:link') || ''; $('#setup').hidden = false; }
$('#saveLink').onclick = () => {
  const v = $('#linkInput').value.trim();
  if (!/^https:\/\/(1drv\.ms|onedrive\.live\.com|.*sharepoint\.com)/.test(v)) { alert('这看起来不是 OneDrive 分享链接'); return; }
  LS.set('od:link', v); LS.del('od:files'); $('#setup').hidden = true; load(true);
};
$('#cancelSetup').onclick = () => { $('#setup').hidden = true; };
$('#clearCache').onclick = () => { Object.keys(localStorage).filter(k => k.startsWith('meta:')).forEach(k => localStorage.removeItem(k)); $('#setup').hidden = true; load(true); };
$('#settingsBtn').onclick = openSetup;
$('#refresh').onclick = () => load(true);

// ---------- events ----------
$('#q').oninput = e => { state.q = e.target.value; render(); };
$('#sort').onchange = e => { state.sort = e.target.value; LS.set('ui:sort', state.sort); render(); };
$('#genres').onclick = e => { const b = e.target.closest('button'); if (b) { state.genre = b.dataset.g; render(); } };
document.addEventListener('click', e => {
  const p = e.target.closest('[data-play]');
  if (p) { e.stopPropagation(); play(p.dataset.play, p.hasAttribute('data-restart')); return; }
  if (e.target.closest('[data-close]') || e.target.id === 'detail') { closeDetail(); return; }
  if (e.target.closest('[data-fix]')) {
    const it = state.items.find(x => x.key === $('#detail').dataset.k);
    const v = prompt('输入 IMDb 编号（如 tt0274812），或正确的英文片名：', it.meta?.id || it.parsed.title);
    if (!v) return;
    const ck = it.parsed.kind + ':' + keyOf(it.parsed);
    LS.del('meta:' + ck);
    if (/^tt\d+$/.test(v.trim())) LS.set('fix:' + ck, v.trim());
    else { LS.del('fix:' + ck); it.parsed = { ...it.parsed, title: v.trim() }; }
    findMeta(it.parsed).then(m => { if (/^tt/.test(v.trim()) === false && m) { LS.set('fix:' + ck, m.id); LS.set('meta:' + ck, { ok: true, m, t: Date.now() }); } it.meta = m; render(); openDetail(it.key); });
    return;
  }
  const c = e.target.closest('.card');
  if (c) openDetail(c.dataset.k);
});
$('#pclose').onclick = closePlayer;
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('#player').hidden && !document.fullscreenElement) closePlayer();
  else if (!$('#detail').hidden) closeDetail();
});

// link via URL hash (#link=...) for quick setup on a new device
const h = new URLSearchParams(location.hash.slice(1));
if (h.get('link')) { LS.set('od:link', h.get('link')); LS.del('od:files'); history.replaceState(null, '', location.pathname); }
state.sort = LS.get('ui:sort') || 'added';
$('#sort').value = state.sort;
load();
