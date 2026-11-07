// Keep this AES-GCM envelope and hashed IDs compatible with the browser reader.
import crypto from 'node:crypto';
import fs from 'node:fs';

export function createRatingsCrypto(link) {
  const key = crypto.createHash('sha256').update('cofilm-ratings:' + link.trim()).digest();
  const hashId = id => crypto.createHmac('sha256', key).update(id).digest('hex').slice(0, 32);
  function encrypt(value) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final(), c.getAuthTag()]);
    return { v: 1, iv: iv.toString('base64'), data: data.toString('base64') };
  }
  function decrypt(envelope) {
    const data = Buffer.from(envelope.data, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    d.setAuthTag(data.subarray(-16));
    return JSON.parse(Buffer.concat([d.update(data.subarray(0, -16)), d.final()]).toString('utf8'));
  }
  return { encrypt, decrypt, hashId };
}
function validItems(items) { return !!items && typeof items === 'object' && !Array.isArray(items); }
export function readRatings(file, codec) {
  if (!fs.existsSync(file)) return { items: {} };
  try {
    const value = codec.decrypt(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!validItems(value.items)) throw Error('Invalid rating items');
    return value;
  } catch { throw Error('Existing ratings could not be read or decrypted; refusing to overwrite them.'); }
}
const observationFields = new Set(['checkedAt', 'attemptedAt']);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => !observationFields.has(k) && value[k] !== undefined).map(k => [k, canonical(value[k])]));
  return value;
}
export function sameRatings(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
export function writeRatingsIfChanged(file, codec, previous, items, now = new Date().toISOString()) {
  if (!validItems(items)) throw Error('Invalid new rating items');
  for (const id of Object.keys(previous.items)) if (!Object.hasOwn(items, id)) throw Error('Refusing to drop an existing rating record.');
  if (sameRatings(previous.items, items)) return false;
  const value = { updated: now, items }, envelope = codec.encrypt(value);
  if (JSON.stringify(codec.decrypt(envelope)) !== JSON.stringify(value)) throw Error('Encrypted rating verification failed.');
  const tmp = file + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(envelope), { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
  return true;
}
