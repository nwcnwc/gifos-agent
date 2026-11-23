// Test helpers: a throwaway Ed25519 key, and a site's files with js/core/core.sig.json signed by it.
import crypto from 'node:crypto';
import { signedBytes } from '../../src/core-trust.js';

export function testKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, pub: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64') };
}
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
// files: { 'js/...': text } -> { '/js/...': text } plus /js/core/core.sig.json (build 0.9.28 unless given)
export function signSite(files, key, o = {}) {
  const list = {};
  for (const [p, t] of Object.entries(files)) if (!(o.unlisted || []).includes(p)) list[p] = sha(t);
  const build = o.build || '0.9.28';
  const sig = crypto.sign(null, signedBytes(build, list), key.privateKey).toString('base64');
  const out = {};
  for (const [p, t] of Object.entries(files)) out['/' + p] = t;
  for (const [p, t] of Object.entries(o.after || {})) out['/' + p] = t;   // served bytes changed after signing
  out['/js/core/core.sig.json'] = JSON.stringify({ v: 1, build, files: o.tamper ? Object.assign({}, list, o.tamper) : list, sig });
  return out;
}
