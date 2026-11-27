// Hosting a hosted room (a room with a host password). The meeting page turns the host password into the room's host
// key the same way every time: PBKDF2-SHA-256 over "gifos-admin:<room>" (310000 rounds) gives a 32-byte seed; the
// seed's Ed25519 public key, hashed with SHA-256, gives the room's verifier (its first 24 hex digits, the v= in the
// link). The page keeps the key on the device as gifos_vadm_<room>.<verifier>, where "Host a private meeting" puts it.
// Only the key goes to the page; the password itself never leaves this process.
//
//   hostKey(room, password)  -> { key, verifier }   key: the seed as hex (secret), verifier: 24 hex digits (public)
//   hostLink(link, password) -> { link, room, verifier, key }   the link with v= filled in (or checked, if it has one)
import crypto from 'node:crypto';

const ROOM = /^[a-z0-9-]{1,64}$/;
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

export function hostKey(room, password) {
  const r = String(room || '');
  const pw = String(password || '').trim();
  if (!ROOM.test(r)) throw new Error('A hosted room name is 1 to 64 letters a-z, digits or dashes.');
  if (!pw) throw new Error('Give the host password.');
  const seed = crypto.pbkdf2Sync(pw, 'gifos-admin:' + r, 310000, 32, 'sha256');
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { key: seed.toString('hex'), verifier: crypto.createHash('sha256').update(pub).digest('hex').slice(0, 24) };
}

// The room in a link (#room=<room>[&v=<verifier>]), with this password's verifier filled in. A link whose v= is a
// different room's is refused: the password is for another room, or the link has a typo.
export function hostLink(link, password) {
  const u = new URL(link);
  const h = new URLSearchParams(u.hash.replace(/^#/, ''));
  const room = h.get('room') || '';
  if (!room) throw new Error('A host password needs a link that names its room: https://gifos.app/meet#room=<room>.');
  const { key, verifier } = hostKey(room, password);
  const v = (h.get('v') || '').toLowerCase();
  if (v && v !== verifier) throw new Error('That host password is not this room\'s: the link\'s v= is another hosted room.');
  if (!v) { h.set('v', verifier); u.hash = h.toString(); }
  return { link: u.toString(), room, verifier, key };
}
