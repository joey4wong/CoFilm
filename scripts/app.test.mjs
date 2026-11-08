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
  assert.match(css,/#player \.pclose\.lg\{background:rgba\(255,255,255,\.1\)!important;box-shadow:/);   // out-ranks [data-theme="light"] .lg
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
