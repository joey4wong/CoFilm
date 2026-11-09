import test from 'node:test';
import assert from 'node:assert/strict';
import { parseName, keyOf, isFreshMeta, tscore, sortMovieFacts, filterMovieFacts, decadeOf, titleSortKey, titlesWithPerson, personKey, compactPerson, libraryMatches, formatDay, lifeLine } from '../lib/catalog.mjs';

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

test('a TMDB person record is reduced to what the page needs',()=>{
  const p=compactPerson({name:'Silke Bodenbender',biography:'  Born in Bonn.  ',birthday:'1974-01-12',place_of_birth:'Bonn, Germany',profile_path:'/a.jpg',combined_credits:{cast:[{media_type:'movie',id:402637,character:'Inga'},{media_type:'person',id:9},{media_type:'tv',id:5,character:'Anna'}],crew:[{media_type:'movie',id:7,job:'Director'}]}},123);
  assert.equal(p.bio,'Born in Bonn.');assert.equal(p.t,123);assert.deepEqual(p.cast,[['movie',402637,'Inga'],['tv',5,'Anna']]);assert.deepEqual(p.crew,[['movie',7,'Director']]);
  assert.deepEqual(compactPerson({name:'X'}).cast,[]);assert.equal(compactPerson({name:'X'}).bio,'');
});
test('library titles are matched by TMDB id and type, never by name',()=>{
  const person={cast:[['movie',10,'Hero'],['tv',20,'Guest']],crew:[['movie',30,'Writer'],['movie',30,'Director'],['movie',40,'Producer']]};
  const items=[{key:'a',type:'movie',tmdbId:10},{key:'b',type:'movie',tmdbId:20},{key:'c',type:'tv',tmdbId:20},{key:'d',type:'movie',tmdbId:30},{key:'e',type:'movie',tmdbId:99},{key:'f',type:'movie',tmdbId:null},{key:'g',type:'movie',tmdbId:'40'}];
  assert.deepEqual(libraryMatches(items,person),[{key:'a',role:'Hero'},{key:'c',role:'Guest'},{key:'d',role:'Director'},{key:'g',role:'Producer'}]);   // movie 20 is not tv 20; Director wins over other jobs
  assert.deepEqual(libraryMatches(items,{cast:[],crew:[]}),[]);
});
test('life dates read naturally and empty parts are skipped',()=>{
  assert.equal(formatDay('1974-01-12'),'January 12, 1974');assert.equal(formatDay(''),'');assert.equal(formatDay('1974'),'');
  assert.equal(lifeLine({birth:'1974-01-12',place:'Bonn, Germany'}),'Born January 12, 1974 \u00b7 Bonn, Germany');
  assert.equal(lifeLine({birth:'1920-03-01',death:'1999-05-02',place:''}),'Born March 1, 1920 \u00b7 Died May 2, 1999');assert.equal(lifeLine({}),'');
});
