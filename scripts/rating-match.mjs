// Unicode-aware identity matching shared by the rating updater and its tests.
const fold = s => String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss');
export const norm = s => fold(s).replace(/[^\p{L}\p{N}]+/gu, '');
export const words = s => fold(s).replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter(Boolean);
export const tscore = (n, t) => { const a = words(t), b = words(n); if (norm(n) && norm(n) === norm(t)) return 100; return a.filter(w => b.includes(w)).length + (a.length && a[0] === b[0] ? .5 : 0); };
// Suggestions are candidates, not identity proof. Require an exact known alias,
// a compatible year, and an unambiguous result rather than the first same-year film.
export function selectDoubanCandidate(rows, aliases, year) {
  const names = new Set(aliases.map(norm).filter(Boolean));
  const hits = new Map();
  for (const x of Array.isArray(rows) ? rows : []) {
    const y = Number.parseInt(x.year, 10);
    if (x.type !== 'movie' || !/^\d+$/.test(String(x.id)) || (year && (!y || Math.abs(y - year) > 1))) continue;
    if (![x.title, x.sub_title].some(n => names.has(norm(n)))) continue;
    hits.set(String(x.id), x);
  }
  return hits.size === 1 ? [...hits.values()][0].id : null;
}
export function doubanRecord(j, id, now = new Date().toISOString()) {
  if (!j || typeof j.title !== 'string' || !j.rating || typeof j.rating.value !== 'number') throw Error('Invalid Douban subject response');
  const value = j.rating.value;
  return { u: 'https://movie.douban.com/subject/' + id + '/', v: value > 0 ? String(value) : null, n: j.rating.count || 0, g: j.genres || [], status: value > 0 ? 'rated' : 'unrated', checkedAt: now };
}
