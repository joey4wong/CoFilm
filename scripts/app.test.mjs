import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { libraryMatches, lifeLine } from '../lib/catalog.mjs';
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
test('player engine loads only on viewing intent (PLAY, a film page, a touch on PLAY), never at startup',()=>{
  const calls=[...source.matchAll(/(?<!function )loadPlayerLib\(/g)].length, warms=[...source.matchAll(/(?<!function )warmPlayer\(/g)].map(m=>source.slice(Math.max(0,m.index-160),m.index));
  assert.equal(calls,2); assert.match(source,/const lib = loadPlayerLib\(\)/);                       // play() + warmPlayer()
  assert.equal(warms.length,2); assert.ok(warms.some(c=>c.includes("r.name === 'detail'"))); assert.ok(warms.some(c=>c.includes("addEventListener('pointerdown'")));
  assert.match(source,/function warmPlayer\(\) \{\n  if \(navigator\.connection\?\.saveData\) return;/);  // respects data saver
  assert.doesNotMatch(source,/requestIdleCallback/);
});
test('a pending carousel destination survives repeated renders',()=>{const start=source.indexOf('function posterRailIndex('),end=source.indexOf('function fitPosterRail(',start),f=vm.runInNewContext('('+source.slice(start,end).trim()+')',{getComputedStyle:()=>({gap:'20px'})});const list={firstElementChild:{getBoundingClientRect:()=>({width:160})},scrollLeft:0,dataset:{railRestoreIndex:'13'}};assert.equal(f(list),13);delete list.dataset.railRestoreIndex;list.dataset.railTargetIndex='7';assert.equal(f(list),7);});
function ratingFixture() {const legacyImdbRatings=new Map(),state={ratings:{}},calls={fetch:0};const context={legacyImdbRatings,state,META:'https://example.invalid',fetch:async()=>{calls.fetch++;return{ok:true,json:async()=>({meta:{imdbRating:'7.2'}})}},location:{hash:''},enc:encodeURIComponent,scheduleRender:()=>{},console};return{context,calls,f:fn('function imdbRatingOf(','function ratingsHtml(',context)};}
test('a TMDB fallback never appears under the IMDb logo',()=>{const{f,calls}=ratingFixture();const it={meta:{id:'tt1',rating:'8.9',imdbRating:null},parsed:{kind:'movie'}};assert.equal(f(it,{}),null);assert.equal(f(it,{imdb:{v:'6.1'}}),'6.1');assert.equal(calls.fetch,0);});
test('legacy metadata supplements only the actual IMDb source, once',async()=>{const{f,calls,context}=ratingFixture(),it={key:'test',meta:{id:'tt1',rating:'8.9'},parsed:{kind:'movie'}};assert.equal(f(it,{}),null);for(let i=0;i<5;i++)await Promise.resolve();assert.equal(f(it,{}),'7.2');assert.equal(calls.fetch,1);assert.equal(context.legacyImdbRatings.get('tt1'),'7.2');});

function seekFixture(duration,currentTime) {
  const shown=[],context={player:{duration,currentTime},SKIP_SECONDS:10,toast:(m)=>shown.push(m)};
  return{context,shown,seekBy:fn('function seekBy(','function togglePlay(',context)};
}
test('arrow-key skip moves 10 seconds and stays inside the film',()=>{
  const f=seekFixture(100,50);f.seekBy(10);assert.equal(f.context.player.currentTime,60);f.seekBy(-10);assert.equal(f.context.player.currentTime,50);
  f.context.player.currentTime=4;f.seekBy(-10);assert.equal(f.context.player.currentTime,0);
  f.context.player.currentTime=95;f.seekBy(10);assert.equal(f.context.player.currentTime,100);
});
test('skipping does nothing before the video has loaded',()=>{const f=seekFixture(0,0);f.seekBy(10);assert.equal(f.context.player.currentTime,0);assert.deepEqual(f.shown,[]);});
test('player shortcuts are limited to an open player, never typing fields or Cmd/Ctrl/Alt',()=>{
  const open={hidden:false},context={$:()=>open};
  const from=source.indexOf('const playerKeyTarget = ')+'const playerKeyTarget = '.length;
  const ok=vm.runInNewContext('const isSpaceKey = e => e.key === \' \' || e.code === \'Space\'; ('+source.slice(from,source.indexOf(';\n',from))+')',context);
  const ev=(extra={})=>({key:'f',altKey:false,ctrlKey:false,metaKey:false,target:{tagName:'DIV',id:''},...extra});
  assert.equal(ok(ev()),true);
  assert.equal(ok(ev({target:{tagName:'INPUT'}})),false);
  assert.equal(ok(ev({metaKey:true})),false);
  assert.equal(ok(ev({ctrlKey:true})),false);
  assert.equal(ok(ev({key:' ',target:{tagName:'BUTTON',id:'pclose'}})),false);   // Space on Close still closes
  assert.equal(ok(ev({key:'',code:'Space',target:{tagName:'BUTTON',id:'pclose'}})),false);   // layouts that report Space only by position
  assert.equal(ok(ev({key:'',code:'Space'})),true);
  open.hidden=true;assert.equal(ok(ev()),false);
});
function playerFixture(player) { const shown=[],context={player,SKIP_SECONDS:10,toast:m=>shown.push(m),document:{}};return{context,shown,fns:vm.runInNewContext('({togglePlay,toggleMute,changeVolume})',Object.assign(context,{}),{}) } }
function fnMany(names,context){const code=names.map(n=>{const s=source.indexOf('function '+n+'(');const e=source.indexOf('\n}\n',s)+2;return source.slice(s,e)}).join('\n');return vm.runInNewContext('(()=>{'+code+';return {'+names.join(',')+'}})()',context)}
test('Space pauses a playing video and plays a paused one',()=>{
  const calls=[];const p={paused:false,play:()=>{calls.push('play');return Promise.resolve()},pause:()=>calls.push('pause')};
  const {togglePlay}=fnMany(['togglePlay'],{player:p});togglePlay();p.paused=true;togglePlay();assert.deepEqual(calls,['pause','play']);
});
test('M toggles mute and says so',()=>{
  const shown=[],p={muted:false,volume:0.5};const {toggleMute}=fnMany(['toggleMute'],{player:p,toast:m=>shown.push(m)});
  toggleMute();assert.equal(p.muted,true);toggleMute();assert.equal(p.muted,false);assert.deepEqual(shown,['Muted','Volume 50%']);
});
test('Up/Down change volume in 10% steps, stay between 0 and 100%, and unmute when raised',()=>{
  const shown=[],p={muted:true,volume:0.95};const {changeVolume}=fnMany(['changeVolume'],{player:p,toast:m=>shown.push(m)});
  changeVolume(0.1);assert.equal(p.volume,1);assert.equal(p.muted,false);
  changeVolume(0.1);assert.equal(p.volume,1);
  p.volume=0.05;changeVolume(-0.1);assert.equal(p.volume,0);
  p.volume=0.3;changeVolume(-0.1);assert.equal(p.volume,0.2);assert.equal(shown.at(-1),'Volume 20%');
});
test('F enters fullscreen on the player and leaves it when already fullscreen',async()=>{
  const log=[],p={requestFullscreen:()=>{log.push('enter');return Promise.resolve()}},doc={fullscreenElement:null,exitFullscreen:()=>log.push('exit')};
  const {toggleFullscreen}=fnMany(['toggleFullscreen'],{player:p,document:doc});toggleFullscreen();doc.fullscreenElement={};toggleFullscreen();assert.deepEqual(log,['enter','exit']);
});
test('key map covers Space, F, M, arrows and ignores Shift+arrow',()=>{
  for(const k of ["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","' ': togglePlay","f: toggleFullscreen","m: toggleMute"])assert.ok(source.includes(k),k);
  assert.match(source,/isArrow && e\.shiftKey/);assert.match(source,/isArrow \|\| !e\.repeat/);
});
test('rail positions are remembered for every recommendation row, not just the first',()=>{
  assert.match(source,/railIndex = keepScroll \? new Map\(\[\.\.\.document\.querySelectorAll\(railSections\)\]/);
  assert.doesNotMatch(source,/id="related-list"/);
});
test('every detail row has its own id so several recommendation rows can coexist',()=>{
  const {row}=fnMany(['row'],{esc:s=>String(s),card:()=>'<a class="card"></a>'});
  const a=row('More from A',[1],{advance:true,key:'director-a'}),b=row('More with B',[1],{advance:true,key:'cast-b'});
  assert.match(a,/id="related-director-a"/);assert.match(b,/id="related-cast-b"/);assert.match(a,/aria-controls="related-director-a"/);assert.equal(row('x',[],{advance:true}),'');
});

test('a key the player already handled (focused player) is not handled a second time',()=>{
  assert.match(source,/if \(playerKeyTarget\(e\) && !e\.defaultPrevented\)/);
});

test('modifier combinations never reach the player, and are never cancelled either',()=>{
  const start=source.indexOf("document.addEventListener('keydown', e => {\n  if (!$('#player').hidden && (e.metaKey");
  assert.ok(start>0);const block=source.slice(start,source.indexOf('}, true);',start));
  assert.match(block,/e\.stopPropagation\(\)/);assert.doesNotMatch(block,/preventDefault/);
});

test('Genres lives in the Movies toolbar; the nav has no Genres tab and old links are redirected',()=>{
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/data-route="genres"/);assert.match(source,/select\('genre', 'Genre'/);
  assert.match(source,/startsWith\('#\/genres'\)/);assert.match(source,/history\.replaceState\(null, '', location\.pathname \+ location\.search \+ '#\/movies'\)/);
  assert.doesNotMatch(source,/function viewGenres/);
});

test('the genre list shows plain names in A to Z order, without counts',()=>{
  assert.match(source,/genres\.map\(g => \[g, g\]\)/);assert.doesNotMatch(source,/g \+ ' \\u00b7 ' \+ n/);assert.match(source,/localeCompare\(y\)\);   \/\/ A to Z, no counts/);
});

test('player header: hides after 3 s of playing, but never while paused, hovered or when Close has focus',()=>{
  const classes=new Set(),timers=[];const box={hidden:false,classList:{add:c=>classes.add(c),remove:c=>classes.delete(c)},querySelector:()=>({matches:()=>ctx.hover}),contains:()=>ctx.closeFocused};
  const closeBtn={},ctx={player:{paused:false},hover:false,closeFocused:false,$:s=>s==='#player'?box:closeBtn,document:{get activeElement(){return ctx.closeFocused?closeBtn:null}},playerIdleTimer:0,
    setTimeout:(f,ms)=>{timers.push({f,ms});return timers.length},clearTimeout:()=>{}};
  const {wakePlayerBar}=fnMany(['wakePlayerBar'],ctx);
  wakePlayerBar();assert.equal(timers.at(-1).ms,3000);timers.at(-1).f();assert.equal(classes.has('idle'),true);
  wakePlayerBar();assert.equal(classes.has('idle'),false);                                  // activity shows it again
  ctx.player.paused=true;timers.at(-1).f();assert.equal(classes.has('idle'),false);          // paused: stay visible
  ctx.player.paused=false;ctx.hover=true;wakePlayerBar();timers.at(-1).f();assert.equal(classes.has('idle'),false);
  ctx.hover=false;ctx.closeFocused=true;wakePlayerBar();timers.at(-1).f();assert.equal(classes.has('idle'),false);
  box.hidden=true;ctx.closeFocused=false;wakePlayerBar();timers.at(-1).f();assert.equal(classes.has('idle'),false);
});
test('player header never uses the frosted overlay layer and is the same in both themes',()=>{
  const css=fs.readFileSync(new URL('../style.css',import.meta.url),'utf8');
  assert.match(css,/#player::before\{display:none\}/);
  assert.doesNotMatch(css,/\[data-theme="light"\][^{]*(\.ptop|#pclose|\.pclose|#player)/);
  assert.match(css,/\.ptop\{position:absolute/);assert.match(css,/#player\.idle \.ptop\{opacity:0\}/);
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');assert.match(html,/id="pclose" class="pclose lg"[^>]*aria-label="Close player"/);assert.doesNotMatch(html,/Close<\/button>/);
});

test('the player close button uses the shared Liquid Glass lens, identical in both themes',()=>{
  const css=fs.readFileSync(new URL('../style.css',import.meta.url),'utf8');
  assert.match(css,/#player \.pclose\.lg,#trailer \.pclose\.lg\{background:rgba\(255,255,255,\.1\)!important;box-shadow:/);   // out-ranks [data-theme="light"] .lg
  assert.doesNotMatch(css,/\.pclose[^{]*\{[^}]*backdrop-filter/);                                          // the lens comes from .lg, not a private blur
  assert.match(source,/wakePlayerBar\(\); requestAnimationFrame\(applyGlass\)/);
});

test('player controls and menus get the shared glass lens, watched without per-frame work',()=>{
  for(const c of ['.movi-play-pause','.movi-controls-right','.movi-volume-container','.movi-time','.movi-center-play-pause'])assert.ok(source.includes(c),c);
  for(const c of ['.movi-settings-menu','.movi-subtitle-track-menu','.movi-audio-track-menu','.movi-speed-menu','.movi-quality-menu','.movi-context-menu'])assert.ok(source.includes(c),c);
  assert.match(source,/attributeFilter: \['class', 'hidden'\]/);assert.doesNotMatch(source,/attributeFilter: \[[^\]]*'style'/);
  assert.match(source,/wrap\.prepend\(player\);\n  watchPlayerGlass\(player\);/);assert.match(source,/unwatchPlayerGlass\(\);/);
  assert.match(source,/glassPlayerControls\(activeFilters\);/);           // player lenses are kept alive by the shared cache cleanup
});
test('a player control only gets its lens rewritten when its size actually changes',()=>{
  const writes=[];const mk=(w,h)=>({offsetWidth:w,offsetHeight:h,style:{setProperty:(k,v)=>writes.push(k+'='+v)}});
  const els=[mk(162,42)];const root={getElementById:()=>({}),querySelectorAll:sel=>sel.includes('play-pause')?els:[]};
  const ctx={player:{shadowRoot:root},GLASS_ON:true,document:{},getComputedStyle:()=>({borderTopLeftRadius:'21px'}),glassFilter:(W,H,R)=>`lg-${W}x${H}-${R}`,playerGlassMO:null,playerGlassRO:null,playerGlassValue:new WeakMap(),
    PLAYER_GLASS_CHROME:'.movi-play-pause',PLAYER_GLASS_PANELS:'.none',PLAYER_GLASS_CSS:''};
  const {lensFor,glassPlayerControls}=fnMany(['lensFor','glassPlayerControls'],ctx);
  glassPlayerControls(new Set());assert.equal(writes.length,2);assert.match(writes[0],/url\(#lg-162x42-21\) blur\(\.6px\)/);
  glassPlayerControls(new Set());assert.equal(writes.length,2);                    // unchanged size: no rewrite
  els[0].offsetWidth=200;glassPlayerControls(new Set());assert.equal(writes.length,4);assert.match(writes[2],/lg-200x42-21/);
  els[0].offsetWidth=0;const active=new Set();glassPlayerControls(active);assert.equal(active.size,0);   // hidden controls are skipped
});

test('player control groups use the corner glint rim, not a uniform white outline',()=>{
  const css=source.slice(source.indexOf('const PLAYER_GLASS_CSS'),source.indexOf('const playerGlassValue'));
  assert.doesNotMatch(css,/inset 0 0 0 \.5px rgba\(255,255,255,\.18\),inset 0 1px 0 rgba\(255,255,255,\.3\),inset 0 -12px/);
  assert.match(css,/::after\{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px/);
  assert.match(css,/linear-gradient\(140deg,rgba\(255,255,255,\.7\) 0%/);   // identical to the site's .lg rim
});

test('trailer opens in a window with a safe YouTube embed, and closing removes it',()=>{
  const frame={innerHTML:''},close={focus:()=>{}},box={hidden:true,querySelector:s=>s==='.trailer-frame'?frame:close};
  const ret={focused:false,focus(){this.focused=true}};const body={style:{overflow:''}};
  const ctx={$:()=>box,esc:s=>String(s).replace(/"/g,'&quot;'),document:{body,activeElement:ret},requestAnimationFrame:f=>f(),applyGlass:()=>{},trailerReturnFocus:null};
  const {openTrailer,closeTrailer}=fnMany(['openTrailer','closeTrailer'],ctx);
  assert.equal(openTrailer('P8xLgg-MNKw','Troy'),true);assert.equal(box.hidden,false);assert.equal(body.style.overflow,'hidden');
  assert.match(frame.innerHTML,/youtube-nocookie\.com\/embed\/P8xLgg-MNKw\?autoplay=1/);assert.match(frame.innerHTML,/referrerpolicy="strict-origin-when-cross-origin"/);assert.match(frame.innerHTML,/allowfullscreen/);
  assert.equal(closeTrailer(),true);assert.equal(frame.innerHTML,'');assert.equal(box.hidden,true);assert.equal(body.style.overflow,'');assert.equal(ret.focused,true);
  assert.equal(closeTrailer(),false);
  assert.equal(openTrailer('bad"key><script>',''),false);assert.equal(box.hidden,true);
});
test('trailer wiring: Cmd/Ctrl-click keeps YouTube, Escape and navigation close it',()=>{
  assert.match(source,/data-trailer="\$\{esc\(tr\.key\)\}"/);assert.match(source,/!e\.metaKey && !e\.ctrlKey && !e\.shiftKey && !e\.altKey && e\.button === 0/);
  assert.match(source,/if \(e\.key !== 'Escape'\) return;\n  if \(closeTrailer\(\)\) return;/);assert.match(source,/function render\(\) \{\n  closeTrailer\(\);/);
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');assert.match(html,/id="trailer" class="trailer-modal" role="dialog" aria-modal="true"/);
});
test('home and film pages take the film colours like the reference: one blurred layer, long fade, no solid bottom',()=>{
  const css=fs.readFileSync(new URL('../style.css',import.meta.url),'utf8');
  assert.match(css,/\.film-tint body\{background:transparent\}/);
  assert.match(css,/\.film-tint #ambient \.amb\{transform:translate\(-44%,-44%\) scale\(4\.88\);filter:blur\(31px\) saturate\(\.96\)/);
  assert.match(css,/\.film-tint :is\(\.detail \.bg,\.hero \.slide \.bg\)\{-webkit-mask-image:linear-gradient\(to bottom,#000 0,#000 44%,rgba\(0,0,0,\.72\) 68%,transparent 94%\)/);
  assert.doesNotMatch(css,/page-detail/);
  assert.match(source,/const tinted = r\.name === 'detail' \|\| r\.name === 'home'/);
  const theme=fs.readFileSync(new URL('../theme.js',import.meta.url),'utf8');assert.match(theme,/root\.dataset\.themeLock \|\|/);assert.match(theme,/window\.cofilmRefreshTheme = refreshTheme/);
});

test('cast cards link to the person page when the TMDB person id is known; credits cache is v3',()=>{
  assert.match(source,/href=\"#\/person\/\$\{p\.i\}\"/);assert.match(source,/c\?\.v === 3 && Date\.now\(\)/);assert.doesNotMatch(source,/v: 2, cast/);
  assert.match(source,/\{ i: p\.id, n: p\.name, r: p\.character/);assert.match(source,/\{ i: p\.id, n: p\.name, r: 'Director'/);
});
test('person route, tinted look, remembered scroll, and cache clearing are wired in',()=>{
  assert.match(source,/startsWith\('\/person\/'\)\) return \{ name: 'person'/);assert.match(source,/else if \(r\.name === 'person'\) html = viewPerson\(r\.arg\)/);
  assert.match(source,/r\.name === 'detail' \|\| r\.name === 'home' \|\| r\.name === 'person'/);assert.match(source,/cameFromPerson/);assert.match(source,/tmdbc\|tmdbp\|tmdbt/);
});
function personPageFixture(over={}) {
  const store={},shown={bg:null};
  const ctx={LS:{get:k=>k==='tmdb:key'?(over.noKey?null:'key'):(store[k]??null)},personOf:id=>over.person??null,personFailed:new Set(over.failed||[]),bioOpen:new Set(over.open||[]),state:{items:over.items||[]},
    esc:s=>String(s),yearOf:it=>String(it.year||''),card:(it,o)=>'<card '+it.key+' '+o.caption+'>',bgOf:it=>'bg-'+it.key,setAmbient:u=>{shown.bg=u},castPlaceholder:n=>'<placeholder '+n+'>',
    libraryMatches,lifeLine};
  return{ctx,shown,view:fnMany(['viewPerson'],ctx).viewPerson};
}
test('person page: bio, library films with their role, and graceful empty states',()=>{
  const items=[{key:'movie:queen|2017',year:2016,parsed:{kind:'movie'},meta:{tmdbId:402637}},{key:'movie:other|2000',year:2000,parsed:{kind:'movie'},meta:{tmdbId:1}}];
  const person={v:1,name:'Silke Bodenbender',bio:'Short bio.',birth:'1974-01-12',place:'Bonn',photo:'/a.jpg',cast:[['movie',402637,'Inga']],crew:[]};
  const f=personPageFixture({person,items});const html=f.view('123');
  assert.match(html,/Silke Bodenbender/);assert.match(html,/Born January 12, 1974/);assert.match(html,/Short bio\./);assert.match(html,/<card movie:queen\|2017 2016 \u00b7 Inga>/);assert.doesNotMatch(html,/movie:other/);assert.equal(f.shown.bg,'bg-movie:queen|2017');
  assert.doesNotMatch(html,/bio-toggle/);                                                   // short bio: no Read more
  const none=personPageFixture({person:{...person,bio:'',cast:[]},items}).view('123');assert.doesNotMatch(html.replace(/Short bio\./,''),/person-bio.*undefined/);assert.doesNotMatch(none,/person-bio/);assert.match(none,/None of this person/);   // no bio: section omitted
});
test('person page: long bios collapse with Read more, bad ids and missing key are handled',()=>{
  const long={v:1,name:'A',bio:'x'.repeat(800),birth:'',place:'',photo:'',cast:[],crew:[]};
  const closed=personPageFixture({person:long}).view('5'),open=personPageFixture({person:long,open:['5']}).view('5');
  assert.match(closed,/person-bio clamped/);assert.match(closed,/Read more/);assert.match(open,/Show less/);assert.doesNotMatch(open,/clamped/);
  assert.match(personPageFixture().view('abc'),/Person not found/);
  assert.match(personPageFixture({noKey:true}).view('5'),/Add a TMDB key/);
  assert.match(personPageFixture({failed:['5']}).view('5'),/Try again/);
  assert.match(personPageFixture().view('5'),/Loading/);
});

function ambientFixture() {
  const mk=()=>({cls:new Set(),style:{},classList:{add(c){this.s.add(c)},remove(c){this.s.delete(c)},s:null}});
  const layers=[mk(),mk()];layers.forEach(l=>{l.classList.s=l.cls});
  const timers=[],decodes=[];
  const ctx={$:()=>({querySelectorAll:()=>layers}),Image:function(){this.decode=()=>new Promise(r=>decodes.push(r))},setTimeout:(f)=>{timers.push(f)},ambientFront:0,ambientSrc:'',ambientToken:0};
  const api=fnMany(['setAmbient'],Object.assign(ctx,{ambientSource:s=>s?String(s).replace(/\/t\/p\/(?:w\d+|original)\//,'/t/p/w300/'):''}));
  return{layers,timers,decodes,setAmbient:api.setAmbient};
}
test('ambient layer: small image, decoded before it fades in, cross-fades by opacity, newest request wins',async()=>{
  const f=ambientFixture();
  f.setAmbient('https://image.tmdb.org/t/p/w1280/abc.jpg');assert.equal(f.layers[0].cls.size+f.layers[1].cls.size,0);   // nothing visible until decoded
  f.decodes[0]();await Promise.resolve();await Promise.resolve();
  assert.match(f.layers[1].style.backgroundImage,/\/t\/p\/w300\/abc\.jpg/);assert.ok(f.layers[1].cls.has('on'));
  f.setAmbient('https://image.tmdb.org/t/p/w1280/def.jpg');f.setAmbient('https://image.tmdb.org/t/p/w1280/ghi.jpg');   // two quick changes
  f.decodes[1]();f.decodes[2]();await Promise.resolve();await Promise.resolve();
  assert.match(f.layers[0].style.backgroundImage,/ghi\.jpg/);assert.doesNotMatch(f.layers[0].style.backgroundImage,/def\.jpg/);   // the superseded image never shows
  f.setAmbient('https://image.tmdb.org/t/p/w1280/ghi.jpg');assert.equal(f.decodes.length,3);                                    // same image: no work
  f.setAmbient('');assert.equal(f.layers[0].cls.size+f.layers[1].cls.size,0);
});
test('ambient layer is built at a quarter size and fades by opacity only',()=>{
  const css=fs.readFileSync(new URL('../style.css',import.meta.url),'utf8');
  assert.match(css,/#ambient \.amb\{[^}]*width:25%;height:25%[^}]*transition:opacity \.9s ease;will-change:opacity/);
  assert.doesNotMatch(css,/#ambient\{[^}]*transition:background-image/);assert.doesNotMatch(css,/\.film-tint #ambient\{[^}]*filter/);
  assert.match(fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),/<div id="ambient" aria-hidden="true"><div class="amb"><\/div><div class="amb"><\/div><\/div>/);
});

test('hero: the next picture is decoded before the slide changes; the newest request wins; slow decodes do not stall',async()=>{
  const applied=[],decodes=new Map(),timers=[];
  const ctx={hero:{list:[{},{},{}],idx:0},heroSwitch:0,decodedImages:new Map(),slideImage:i=>'img'+i,decodeImage:u=>new Promise(r=>decodes.set(u,r)),applySlide:i=>applied.push(i),setTimeout:(f,ms)=>{timers.push({f,ms});return timers.length}};
  const {showSlide}=fnMany(['showSlide'],ctx);
  showSlide(1);assert.equal(ctx.hero.idx,1);assert.deepEqual(applied,[]);                 // not shown until decoded
  const flush=()=>new Promise(r=>setImmediate(r));decodes.get('img1')();await flush();assert.deepEqual(applied,[1]);
  showSlide(2);showSlide(0);decodes.get('img2')();decodes.get('img0')();await flush();assert.deepEqual(applied,[1,0]);   // slide 2 was superseded
  showSlide(5);assert.equal(ctx.hero.idx,2);                                              // wraps around
  assert.equal(timers.at(-1).ms,700);                                                      // never waits more than 0.7 s for a decode
});
test('decodeImage decodes each hero picture once and tolerates failures',async()=>{
  let made=0;const ctx={decodedImages:new Map(),Image:function(){made++;this.decode=()=>Promise.reject(new Error('bad'))}};
  const {decodeImage}=fnMany(['decodeImage'],ctx);
  await decodeImage('a');await decodeImage('a');assert.equal(made,1);await decodeImage('');assert.equal(made,1);
});
test('home warms the other hero pictures one by one',()=>{assert.match(source,/if \(r\.name === 'home'\) \{ startHero\(\); warmHero\(\);/);assert.match(source,/for \(let i = 0; i < hero\.list\.length; i\+\+\) await decodeImage\(slideImage\(i\)\)/);});

test('phones held upright show the whole backdrop; a poster used as artwork keeps the full wall',()=>{
  const css=fs.readFileSync(new URL('../style.css',import.meta.url),'utf8');
  const block=css.slice(css.indexOf('@media (max-width:820px) and (max-aspect-ratio:1/1){'));
  assert.match(block,/\.film-tint :is\(\.slide \.bg,\.detail > \.bg\):not\(\.art-tall\)\{[^}]*height:56\.25vw;background-size:100% auto/);
  assert.doesNotMatch(block,/background-size:cover/);assert.doesNotMatch(css,/\.art-tall\{background-size:auto 100%/);
  assert.match(block,/\.film-tint \.hero\{height:calc\(56\.25vw \+ 366px\)/);
  assert.match(block,/\.detail:not\(:has\(> \.bg\.art-tall\)\) \.dtop\{min-height:0;justify-content:flex-start;padding-top:calc\(56\.25vw - 28px\)/);
});
test('artwork that is not landscape is flagged and shown whole on phones; landscape stays untouched',()=>{
  const els=[],mk=()=>{const cls=new Set();return{dataset:{art:JSON.stringify(['wide.jpg'])},style:{backgroundImage:'url("wide.jpg")'},classList:{add:c=>cls.add(c),remove:c=>cls.delete(c),toggle:(c,on)=>on?cls.add(c):cls.delete(c)},cls}};
  const sizes={'wide.jpg':[1280,720],'tall.jpg':[1280,1920]};
  const ctx={artChecked:new Map(),document:{querySelectorAll:()=>els},Image:function(){Object.defineProperty(this,'src',{set:u=>{this.naturalWidth=sizes[u][0];this.naturalHeight=sizes[u][1];setImmediate(()=>this.onload())}})}};
  const {ensureArtwork}=fnMany(['ensureArtwork'],ctx);
  const w=mk(),p=mk();p.dataset.art=JSON.stringify(['tall.jpg']);p.style.backgroundImage='url("tall.jpg")';els.push(w,p);ensureArtwork();
  return new Promise(r=>setTimeout(()=>{assert.equal(w.cls.has('art-tall'),false);assert.equal(p.cls.has('art-tall'),true);r()},20));
});

test('artIsPoster: the page picture is the poster only when both share the same TMDB file',()=>{
  const {artIsPoster}=fnMany(['tmdbPath','artIsPoster'],{bgOf:it=>it.meta.background});
  const I='https://image.tmdb.org/t/p/';
  assert.equal(artIsPoster({meta:{poster:I+'w500/p.jpg',background:I+'w1280/p.jpg'}}),true);      // no backdrop: poster reused
  assert.equal(artIsPoster({meta:{poster:I+'w500/p.jpg',background:I+'w1280/b.jpg'}}),false);     // real backdrop
  assert.equal(artIsPoster({meta:{poster:'',background:''}}),false);
});
test('a select is never focused from code on touch screens (iPhone opens its picker)',()=>{
  let focused=0;const sel={tagName:'SELECT',focus:()=>focused++},btn={tagName:'BUTTON',focus:()=>focused+=10};
  const mk=(el,touch)=>fnMany(['keepFocus'],{$:()=>el,window:{matchMedia:()=>({matches:touch})}}).keepFocus;
  mk(sel,true)('x');assert.equal(focused,0);mk(sel,false)('x');assert.equal(focused,1);mk(btn,true)('x');assert.equal(focused,11);
  assert.match(source,/LS\.del\('view:movies'\); render\(\); keepFocus\('\[data-movie-view="sort"\]'\)/);
});
