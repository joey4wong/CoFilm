import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { webcrypto, createHash } from 'node:crypto';
import { createRatingsCrypto, readRatings, sameRatings, writeRatingsIfChanged } from './ratings-store.mjs';
const link='https://example.invalid/test-library', codec=createRatingsCrypto(link);
function fixture(t) { const dir=fs.mkdtempSync(path.join(process.env.COFILM_TEST_TMP || os.tmpdir(),'cofilm-test-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); return path.join(dir,'ratings.enc.json'); }

test('rating encryption is compatible with browser WebCrypto',async()=>{const value={items:{one:{imdb:{v:'6.1'}}}},e=codec.encrypt(value);const raw=createHash('sha256').update('cofilm-ratings:'+link).digest();const key=await webcrypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);const decoded=JSON.parse(Buffer.from(await webcrypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(e.iv,'base64')},key,Buffer.from(e.data,'base64'))).toString());assert.deepEqual(decoded,value);assert.deepEqual(codec.decrypt(e),value);});
test('hashed IDs match browser HMAC format',async()=>{const raw=createHash('sha256').update('cofilm-ratings:'+link).digest(),k=await webcrypto.subtle.importKey('raw',raw,{name:'HMAC',hash:'SHA-256'},false,['sign']);const browser=Buffer.from(await webcrypto.subtle.sign('HMAC',k,Buffer.from('tt5994792'))).toString('hex').slice(0,32);assert.equal(codec.hashId('tt5994792'),browser);});
test('a corrupt existing file fails closed and is unchanged',t=>{const f=fixture(t);fs.writeFileSync(f,'broken data');assert.throws(()=>readRatings(f,codec),/refusing to overwrite/);assert.equal(fs.readFileSync(f,'utf8'),'broken data');});
test('a wrong share key fails closed',t=>{const f=fixture(t);fs.writeFileSync(f,JSON.stringify(codec.encrypt({items:{old:{}}})));assert.throws(()=>readRatings(f,createRatingsCrypto('other link')),/refusing to overwrite/);});
test('an unchanged rating does not get re-encrypted or committed',t=>{const f=fixture(t),prev={items:{one:{db:{v:'7',status:'rated',checkedAt:'before'}}}};fs.writeFileSync(f,JSON.stringify(codec.encrypt(prev)));const before=fs.readFileSync(f,'utf8');assert.equal(writeRatingsIfChanged(f,codec,prev,{one:{db:{v:'7',status:'rated',checkedAt:'after'}}}),false);assert.equal(fs.readFileSync(f,'utf8'),before);});
test('score, vote count and availability changes are meaningful',()=>{assert.equal(sameRatings({a:{v:'7'}},{a:{v:'8'}}),false);assert.equal(sameRatings({a:{n:1}},{a:{n:2}}),false);assert.equal(sameRatings({a:{status:'rated'}},{a:{status:'unavailable'}}),false);});
test('old records cannot silently disappear',t=>{const f=fixture(t);assert.throws(()=>writeRatingsIfChanged(f,codec,{items:{old:{}}},{}),/drop an existing/);assert.equal(fs.existsSync(f),false);});
test('changed data is verified, saved atomically and readable',t=>{const f=fixture(t);assert.equal(writeRatingsIfChanged(f,codec,{items:{}},{one:{imdb:{v:'6.1'}}},'test-time'),true);assert.deepEqual(readRatings(f,codec),{updated:'test-time',items:{one:{imdb:{v:'6.1'}}}});assert.equal(fs.existsSync(f+'.tmp'),false);});
