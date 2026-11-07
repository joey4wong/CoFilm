import test from 'node:test';
import assert from 'node:assert/strict';
import { parseName, keyOf, isFreshMeta, tscore } from '../lib/catalog.mjs';

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
