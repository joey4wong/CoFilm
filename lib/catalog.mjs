// Shared pure catalog rules. Keep filename keys stable so saved playback progress survives.
export const VIDEO_EXT = /\.(mkv|mp4|m4v|mov|avi|ts|m2ts|webm|wmv|flv)$/i;
export const SUB_EXT = /\.(srt|ass|ssa|vtt)$/i;
const STRONG = /^(\d{3,4}p|blu-?ray|bdrip|brrip|web-?dl|webrip|web|hdtv|hdrip|dvdrip|uhd|4k|remux|hdr|hdr10\+?|dv|x26[45]|h\.?26[45]|hevc|avc|10bit|8bit|ddp?\d?(\.\d)?|aac\d?(\.\d)?|dts(-hd)?|truehd|atmos|cc|it|amzn|nf|ma)$/i;
const EDITION = /^(unrated|extended|dubbed|repack|proper|imax|remastered|directors|cut|uncut|criterion|multi|dual|limited|internal|bluray)$/i;

export function parseName(name) {
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
export const keyOf = p => (p.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()) + '|' + (p.year || '');


const fold = s => String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss');
export const norm = s => fold(s).replace(/[^\p{L}\p{N}]+/gu, '');
export const words = s => fold(s).replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter(Boolean);
export const tscore = (n, t) => { const a = words(t), b = words(n); if (norm(n) && norm(n) === norm(t)) return 100; return a.filter(w => b.includes(w)).length + (a.length && a[0] === b[0] ? .5 : 0); };

export function isFreshMeta(entry, now = Date.now()) {
  const age = now - entry?.t;
  return !!entry && Number.isFinite(entry.t) && age >= 0 && age < (entry.ok ? 7 * 864e5 : 30 * 60e3);
}

// ---- Movies page: sorting and filtering (pure, so they can be tested) ----
export const MOVIE_SORTS = [['added', 'Recently added'], ['year-desc', 'Year: newest first'], ['year-asc', 'Year: oldest first'], ['rating', 'Rating: highest first'], ['title', 'Title: A to Z'], ['country', 'Country: A to Z'], ['4k', '4K first']];
export const titleSortKey = t => fold(t).replace(/^(the|a|an) /, '').trim();
export const decadeOf = y => { const n = parseInt(y, 10); return n >= 1800 && n < 3000 ? Math.floor(n / 10) * 10 : null; };
// A "fact" is { title, year, countries[], genres[], rating, is4k, added } for one movie.
export function filterMovieFacts(list, view = {}) {
  return list.filter(f => (!view.decade || decadeOf(f.year) === Number(view.decade)) && (!view.country || f.countries.includes(view.country)) && (!view.genre || (f.genres || []).includes(view.genre)) && (!view.only4k || f.is4k));
}
export function sortMovieFacts(list, sort = 'added') {
  const byTitle = (a, b) => titleSortKey(a.title).localeCompare(titleSortKey(b.title));
  const missingLast = (a, b, dir) => a == null || a === '' ? (b == null || b === '' ? 0 : 1) : b == null || b === '' ? -1 : dir * (a < b ? -1 : a > b ? 1 : 0);
  const rank = {
    added: (a, b) => b.added - a.added || byTitle(a, b),
    'year-desc': (a, b) => missingLast(a.year, b.year, -1) || byTitle(a, b),
    'year-asc': (a, b) => missingLast(a.year, b.year, 1) || byTitle(a, b),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0) || byTitle(a, b),
    title: byTitle,
    country: (a, b) => missingLast(a.countries[0] && fold(a.countries[0]), b.countries[0] && fold(b.countries[0]), 1) || byTitle(a, b),
    '4k': (a, b) => Number(b.is4k) - Number(a.is4k) || b.added - a.added || byTitle(a, b),
  };
  return [...list].sort(rank[sort] || rank.added);
}
// Other library titles that share a person with this one (names compared without accents or punctuation).
export const personKey = n => fold(n).replace(/[^a-z0-9]+/g, ' ').trim();
export function titlesWithPerson(others, name, namesOf) {
  const key = personKey(name);
  return key ? others.filter(x => namesOf(x).some(n => personKey(n) === key)) : [];
}

// ---- People: TMDB person record, and which library titles they appear in ----
// Keep only what the page needs: a full filmography can be hundreds of entries.
export function compactPerson(j, now = Date.now()) {
  const credit = (list, role) => (list || []).filter(c => (c.media_type === 'movie' || c.media_type === 'tv') && Number.isInteger(c.id)).map(c => [c.media_type, c.id, role(c) || '']);
  return {
    v: 1, t: now, name: j.name || '', bio: String(j.biography || '').trim(), birth: j.birthday || '', death: j.deathday || '', place: j.place_of_birth || '', photo: j.profile_path || '',
    cast: credit(j.combined_credits?.cast, c => c.character), crew: credit(j.combined_credits?.crew, c => c.job),
  };
}
// items: [{ key, type: 'movie'|'tv', tmdbId }]. Matches by TMDB id (never by name), so same-name films cannot be confused.
export function libraryMatches(items, person) {
  const out = [];
  for (const it of items) {
    if (!it.tmdbId) continue;
    const hit = (person.cast || []).find(c => c[0] === it.type && c[1] === Number(it.tmdbId));
    const crew = (person.crew || []).filter(c => c[0] === it.type && c[1] === Number(it.tmdbId));
    const job = crew.find(c => c[2] === 'Director') || crew[0];
    if (hit) out.push({ key: it.key, role: hit[2] || 'Cast' });
    else if (job) out.push({ key: it.key, role: job[2] || 'Crew' });
  }
  return out;
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function formatDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}` : '';
}
export function lifeLine(p) {
  const born = formatDay(p.birth), died = formatDay(p.death);
  return [born && 'Born ' + born, died && 'Died ' + died, p.place].filter(Boolean).join(' \u00b7 ');
}
