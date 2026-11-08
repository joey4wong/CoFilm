import test from 'node:test';
import assert from 'node:assert/strict';
import { parseName, keyOf, isFreshMeta, tscore, sortMovieFacts, filterMovieFacts, decadeOf, titleSortKey, titlesWithPerson, personKey } from '../lib/catalog.mjs';

test('movie filename keeps its stable progress/cache key', () => {
  const p = parseName('Konigin.der.Nacht.2017.1080p.AMZN.WEB-DL.DDP2.0.H.264.mkv');
  assert.deepEqual(p, { kind: 'movie', title: 'Konigin der Nacht', year: 2017 });
  assert.equal(keyOf(p), 'konigin der nacht|2017');
});
test('episode parsing retains season and episode', () => assert.deepEqual(parseName('Vladimir.S01E03.1080p.WEB-DL.mkv'), { kind: 'series', title: 'Vladimir', year: null, season: 1, episode: 3 }));
test('a numeric movie title is not mistaken for its release year', () => assert.equal(parseName('1900.1976.1080p.BluRay.mp4').title, '1900'));
test('shared matching recognizes accents but not unrelated Chinese titles', () => { assert.equal(tscore('Königin der Nacht','Konigin der Nacht'),100); assert.equal(tscore('夜之女王','女王'),0); });
test('successful metadata is fresh for 7 days; failures are retried after 30 minutes', () => { const now=10*864e5; assert.equal(isFreshMeta({ok:true,t:now-6*864e5},now),true); assert.equal(isFreshMeta({ok:true,t:now-7*864e5},now),false); assert.equal(isFreshMeta({ok:false,t:now-10*60e3},now),true); assert.equal(isFreshMeta({ok:false,t:now-31*60e3},now),false); });
test('invalid or future cache timestamps are refreshed', () => { assert.equal(isFreshMeta(null,10),false); assert.equal(isFreshMeta({ok:true,t:11},10),false); assert.equal(isFreshMeta({ok:true},10),false); });

const F=(title,year,countries,rating,is4k,added,genres=[])=>({title,year,countries,genres,rating,is4k,added});
const films=[F('The Zebra',1999,['France'],7.1,false,3),F('Alpha',2020,['Japan','France'],8.2,true,1),F('Bravo',null,[],0,false,5),F('An Apple',1985,['Canada'],6.0,true,4),F('Delta',2020,['Spain'],8.2,false,2)];
const names=l=>l.map(f=>f.title);
test('sorting by year puts unknown years last in both directions',()=>{assert.deepEqual(names(sortMovieFacts(films,'year-desc')),['Alpha','Delta','The Zebra','An Apple','Bravo']);assert.deepEqual(names(sortMovieFacts(films,'year-asc')),['An Apple','The Zebra','Alpha','Delta','Bravo']);});
test('rating sort is high to low with ties broken by title',()=>assert.deepEqual(names(sortMovieFacts(films,'rating')).slice(0,3),['Alpha','Delta','The Zebra']));
test('title sort ignores leading The/A/An',()=>{assert.deepEqual(names(sortMovieFacts(films,'title')),['Alpha','An Apple','Bravo','Delta','The Zebra']);assert.equal(titleSortKey('The Hunger'),'hunger');});
test('country sort uses the first country and puts unknown last',()=>assert.deepEqual(names(sortMovieFacts(films,'country')),['An Apple','The Zebra','Alpha','Delta','Bravo']));
test('4K first keeps newest first inside each group',()=>assert.deepEqual(names(sortMovieFacts(films,'4k')),['An Apple','Alpha','Bravo','The Zebra','Delta']));
test('unknown sort falls back to recently added and the input is not mutated',()=>{const copy=[...films];assert.deepEqual(names(sortMovieFacts(films,'nonsense')),['Bravo','An Apple','The Zebra','Delta','Alpha']);assert.deepEqual(films,copy);});
test('filters combine: decade, any listed country, 4K only',()=>{assert.deepEqual(names(filterMovieFacts(films,{decade:2020})),['Alpha','Delta']);assert.deepEqual(names(filterMovieFacts(films,{country:'France'})),['The Zebra','Alpha']);assert.deepEqual(names(filterMovieFacts(films,{decade:'2020',only4k:true})),['Alpha']);assert.equal(filterMovieFacts(films,{}).length,5);});
test('decades are computed from the year',()=>{assert.equal(decadeOf('1999'),1990);assert.equal(decadeOf(2020),2020);assert.equal(decadeOf(null),null);assert.equal(decadeOf('abc'),null);});
test('same-person matching ignores accents, case and punctuation',()=>{const lib=[{n:['Zoë Kravitz']},{n:['Someone Else']},{n:['zoe  kravitz.']}];assert.equal(titlesWithPerson(lib,'ZOE KRAVITZ',x=>x.n).length,2);assert.equal(titlesWithPerson(lib,'',x=>x.n).length,0);assert.equal(personKey('Emily Atef'),'emily atef');});

test('genre filter matches any listed genre and combines with the other filters',()=>{
  const g=[F('A',2000,['France'],7,false,1,['Drama','Romance']),F('B',2001,['France'],6,true,2,['Horror']),F('C',2002,['Japan'],8,true,3,['Drama'])];
  assert.deepEqual(names(filterMovieFacts(g,{genre:'Drama'})),['A','C']);
  assert.deepEqual(names(filterMovieFacts(g,{genre:'Drama',country:'France'})),['A']);
  assert.deepEqual(names(filterMovieFacts(g,{genre:'Drama',only4k:true})),['C']);
  assert.deepEqual(names(filterMovieFacts(g,{genre:'Western'})),[]);assert.equal(filterMovieFacts(g,{genre:''}).length,3);
  assert.equal(filterMovieFacts([{...g[0],genres:undefined}],{genre:'Drama'}).length,0);   // titles without metadata never crash
});
