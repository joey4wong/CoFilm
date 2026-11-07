import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
function fn(name,next,context) { const start=source.indexOf(name),end=source.indexOf(next,start); assert.ok(start>=0&&end>start); return vm.runInNewContext('('+source.slice(start,end).trim()+')',context); }
function libraryFixture(entry) {
  const calls={renders:0,lookups:0},state={items:[]};
  const context={state,LS:{get:()=>123},buildItems:()=>[{key:'movie:test|2000',parsed:{title:'Test'}}],cachedMetadata:()=>entry,render:()=>calls.renders++,findMeta:async()=>{calls.lookups++;return{id:'tt1'}},pool:async(arr,n,work)=>{for(const x of arr)await work(x)},scheduleRender:()=>{},applyErotic:()=>{}};
  return{calls,state,apply:fn('async function applyFiles(','async function load(',context)};
}
test('cached startup paints immediately without awaiting remote metadata',async()=>{const f=libraryFixture({entry:{ok:true,m:{id:'cached'}},fresh:false});await f.apply([],{refreshMetadata:false});assert.equal(f.calls.lookups,0);assert.equal(f.calls.renders,1);assert.equal(f.state.items[0].meta.id,'cached');});
test('fresh metadata is not processed for a second time after OneDrive refresh',async()=>{const f=libraryFixture({entry:{ok:true,m:{id:'cached'}},fresh:true});await f.apply([]);assert.equal(f.calls.lookups,0);assert.equal(f.calls.renders,1);});
test('stale metadata still refreshes with the existing worker pool',async()=>{const f=libraryFixture({entry:{ok:true,m:{id:'cached'}},fresh:false});await f.apply([]);assert.equal(f.calls.lookups,1);assert.equal(f.state.items[0].meta.id,'tt1');});
test('player import is called only by the playback path, never by startup warmup',()=>{assert.equal([...source.matchAll(/loadPlayerLib\(/g)].length,2);assert.match(source,/await loadPlayerLib\(\)/);assert.doesNotMatch(source,/requestIdleCallback/);});
test('a pending carousel destination survives repeated renders',()=>{const start=source.indexOf('function posterRailIndex('),end=source.indexOf('function fitPosterRail(',start),f=vm.runInNewContext('('+source.slice(start,end).trim()+')',{getComputedStyle:()=>({gap:'20px'})});const list={firstElementChild:{getBoundingClientRect:()=>({width:160})},scrollLeft:0,dataset:{railRestoreIndex:'13'}};assert.equal(f(list),13);delete list.dataset.railRestoreIndex;list.dataset.railTargetIndex='7';assert.equal(f(list),7);});
function ratingFixture() {const legacyImdbRatings=new Map(),state={ratings:{}},calls={fetch:0};const context={legacyImdbRatings,state,META:'https://example.invalid',fetch:async()=>{calls.fetch++;return{ok:true,json:async()=>({meta:{imdbRating:'7.2'}})}},location:{hash:''},enc:encodeURIComponent,scheduleRender:()=>{},console};return{context,calls,f:fn('function imdbRatingOf(','function ratingsHtml(',context)};}
test('a TMDB fallback never appears under the IMDb logo',()=>{const{f,calls}=ratingFixture();const it={meta:{id:'tt1',rating:'8.9',imdbRating:null},parsed:{kind:'movie'}};assert.equal(f(it,{}),null);assert.equal(f(it,{imdb:{v:'6.1'}}),'6.1');assert.equal(calls.fetch,0);});
test('legacy metadata supplements only the actual IMDb source, once',async()=>{const{f,calls,context}=ratingFixture(),it={key:'test',meta:{id:'tt1',rating:'8.9'},parsed:{kind:'movie'}};assert.equal(f(it,{}),null);for(let i=0;i<5;i++)await Promise.resolve();assert.equal(f(it,{}),'7.2');assert.equal(calls.fetch,1);assert.equal(context.legacyImdbRatings.get('tt1'),'7.2');});
