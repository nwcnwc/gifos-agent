// Which GifOS core may run on this computer: only one signed by GifOS (docs/core-trust.md).
//
// The site serves js/core/core.sig.json: { v: 1, build, files: { <path>: <sha256 hex> }, sig: <base64 Ed25519> }. The
// signature covers SIGNED_PREFIX + "build <build>\n" + one "<sha256>  <path>\n" line per file, sorted by path. The key
// is pinned here, never taken from the site (a hostile site would serve its own key).
import crypto from 'node:crypto';

// The gifos.app domain signing key (public half; the same key signs the store's apps: https://gifos.app/gifos.key).
export const GIFOS_CORE_KEYS = Object.freeze(['0Kv26DhQ3tTeGGjTjIAViSWlAgkXYM8xPxZu+AObDKY=']);
export const SIGNED_PREFIX = 'gifos-core-sig-v1\n';
export const SIG_PATH = 'js/core/core.sig.json';

// The oldest signed core this SDK runs: a site cannot replay an older signed release. Raised with each SDK release that
// needs a newer core.
export const MIN_CORE_BUILD = '0.9.28';
const MAX_LIST = 256 * 1024, MAX_FILES = 400, MAX_FILE = 8 * 1024 * 1024;
export function buildBefore(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0), pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0; }
  return false;
}

const NOT_SIGNED = 'This site\'s GifOS core is not signed by GifOS, so it will not run on this computer. Join without { core: true } to use a browser instead.';

export function signedBytes(build, files) {
  const paths = Object.keys(files).sort();
  let s = SIGNED_PREFIX + 'build ' + String(build) + '\n';
  for (const p of paths) s += files[p] + '  ' + p + '\n';
  return Buffer.from(s, 'utf8');
}

const PATH_OK = /^js\/[a-z0-9._\/-]+$/i;
function verifyList(doc, keys) {
  if (!doc || doc.v !== 1 || typeof doc.sig !== 'string' || !doc.files || typeof doc.files !== 'object' || typeof doc.build !== 'string') return null;
  if (Object.keys(doc.files).length > MAX_FILES) return null;
  for (const [p, h] of Object.entries(doc.files)) if (!PATH_OK.test(p) || p.includes('..') || !/^[0-9a-f]{64}$/.test(String(h))) return null;
  const msg = signedBytes(doc.build, doc.files);
  const sig = Buffer.from(doc.sig, 'base64');
  if (sig.length !== 64) return null;
  for (const k of keys) {
    const raw = Buffer.from(String(k), 'base64');
    if (raw.length !== 32) continue;
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
    if (crypto.verify(null, msg, pub, sig)) return { build: doc.build, files: doc.files };
  }
  return null;
}

// Fetch the signed list and every file it names from the meeting's origin; check the signature and each file's hash.
// -> { build, origin, texts: { <path>: text } }, or throws one plain sentence. Nothing here runs any of it.
export async function fetchSignedCore(origin, opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  const keys = opts.keys && opts.keys.length ? opts.keys : GIFOS_CORE_KEYS;
  const base = new URL('/', origin).href;
  const get = async (rel) => {
    let last = null;
    for (let i = 0; i < 4; i++) {
      let r;
      try { r = await fetchFn(new URL(rel, base).href, { cache: 'no-store', redirect: 'error' }); }
      catch (e) { last = e; await new Promise((res) => setTimeout(res, 250 * (i + 1))); continue; }
      if (!r.ok) return { status: r.status };
      const bytes = Buffer.from(await r.arrayBuffer());   // hash the bytes as served, then decode
      if (bytes.length > MAX_FILE) throw new Error('This site\'s GifOS core has a file larger than any core file (' + rel + '), so it will not run.');
      return { bytes, text: new TextDecoder().decode(bytes) };
    }
    throw new Error('Could not load the GifOS core from ' + base + ' (' + String((last && last.message) || last) + ').');
  };
  const s = await get(SIG_PATH);
  if (s.status === 404 && !opts.sigOnly) {
    const n = await get('js/core/node.js');
    if (n.status) throw new Error('This site has no GifOS core for agents (' + new URL('js/core/node.js', base).href + ' answered ' + n.status + '). Join without { core: true }.');
    throw new Error(NOT_SIGNED);
  }
  if (s.status) throw new Error('This site has no GifOS core for agents (' + new URL(SIG_PATH, base).href + ' answered ' + s.status + '). Join without { core: true }.');
  if (s.bytes.length > MAX_LIST) throw new Error(NOT_SIGNED);
  let doc; try { doc = JSON.parse(s.text); } catch (e) { throw new Error(NOT_SIGNED); }
  const list = verifyList(doc, keys);
  if (!list) throw new Error(NOT_SIGNED);
  if (buildBefore(list.build, MIN_CORE_BUILD)) throw new Error('This site serves an old GifOS core (' + list.build + '); this agent runs ' + MIN_CORE_BUILD + ' or later. Join without { core: true }, or use a newer meeting site.');
  if (!list.files['js/core/node.js']) throw new Error(NOT_SIGNED);
  const texts = {};
  const todo = Object.keys(list.files);
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (todo.length) {
      const rel = todo.shift();
      const r = await get(rel);
      if (r.status) throw new Error('This site\'s GifOS core is missing a signed file (' + rel + ' answered ' + r.status + '), so it will not run.');
      const h = crypto.createHash('sha256').update(r.bytes).digest('hex');
      if (h !== list.files[rel]) throw new Error('This site\'s GifOS core was changed after GifOS signed it (' + rel + '), so it will not run on this computer.');
      texts[rel] = r.text;
    }
  }));
  return { build: list.build, origin: base, texts };
}
