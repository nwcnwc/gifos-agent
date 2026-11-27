// Hosting a room (hostKey, hostLink, join's hostPassword) and playing a file to the Stage (meet.stage.play) over a
// fake transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Meeting, hostKey, hostLink } from '../../src/index.js';

test('hostKey: the Ed25519 key from a 32-byte seed is the standard one (RFC 8032 test 1)', () => {
  // hostKey's seed comes from PBKDF2; the key pair from the seed must match every other Ed25519 (the page's included).
  const seed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
  const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  assert.equal(pub, 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
});

test('hostKey: PBKDF2 over gifos-admin:<room>, verifier = first 24 hex of SHA-256(public key)', () => {
  const { key, verifier } = hostKey('demo-room', 'correct horse');
  const seed = crypto.pbkdf2Sync('correct horse', 'gifos-admin:demo-room', 310000, 32, 'sha256').toString('hex');
  assert.equal(key, seed);
  assert.match(verifier, /^[0-9a-f]{24}$/);
  assert.deepEqual(hostKey('demo-room', ' correct horse \n'), { key, verifier }, 'the password is trimmed, as the page trims it');
  assert.notEqual(hostKey('demo-room2', 'correct horse').verifier, verifier, 'another room, another key');
  assert.throws(() => hostKey('Demo Room', 'x'), /room name/);
  assert.throws(() => hostKey('demo-room', ''), /host password/);
});

test('hostLink: fills in v=, keeps a matching v=, refuses another room\'s v=', () => {
  const { verifier } = hostKey('demo-room', 'pw1');
  const a = hostLink('https://gifos.app/cast#room=demo-room', 'pw1');
  assert.equal(a.verifier, verifier);
  assert.equal(new URLSearchParams(new URL(a.link).hash.slice(1)).get('v'), verifier);
  assert.equal(hostLink('https://gifos.app/cast#room=demo-room&v=' + verifier.toUpperCase(), 'pw1').verifier, verifier);
  assert.throws(() => hostLink('https://gifos.app/cast#room=demo-room&v=' + 'a'.repeat(24), 'pw1'), /not this room/);
  assert.throws(() => hostLink('https://gifos.app/cast', 'pw1'), /names its room/);
});

test('join: listed needs hostPassword; hostPassword is browser mode', async () => {
  const { join } = await import('../../src/index.js');
  await assert.rejects(join('https://gifos.app/cast#room=demo-room', { name: "TV (Sam's assistant)", listed: 'https://gifos.tv/x' }), /listed needs hostPassword/);
  await assert.rejects(join('https://gifos.app/cast#room=demo-room', { name: "TV (Sam's assistant)", hostPassword: 'pw', core: true }), /browser mode|core mode is off|GIFOS_CORE_MODE/i);
});

function playTransport(script) {
  let push = null, i = 0;
  const t = {
    played: [], stopped: 0, clears: 0,
    onEvent(fn) { push = fn; },
    emit: (type, data) => push({ type, data }),
    async call() { return { ok: true }; },
    async close() {},
    async playFile(file, o) { t.played.push([file, o]); return script.start || { ok: true, pos: 0.1, len: 100 }; },
    async playing() { const s = script.states[Math.min(i++, script.states.length - 1)]; if (s instanceof Error) throw s; return s; },
    async stopPlaying() { t.stopped++; return { ok: true }; },
    async pickClear() { t.clears++; return true; },
  };
  return t;
}
const tmpFile = () => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-play-')), 'clip.webm'); fs.writeFileSync(f, 'x'); return f; };

test('stage.play: resolves when the film moves; ended says how it stopped (the real end)', async () => {
  const f = tmpFile();
  const t = playTransport({ states: [{ playing: true, pos: 50, len: 100, skips: 0 }, { playing: true, pos: 98, len: 100, skips: 1 }, { playing: false, pos: 0, len: 100 }] });
  const meet = new Meeting(t);
  const seen = [];
  meet.on('played', (d) => seen.push(d));
  const r = await meet.stage.play(f, { startAt: 12, clear: true });
  assert.equal(r.len, 100);
  assert.equal(t.played[0][0], f);
  assert.equal(t.played[0][1].startAt, 12);
  const end = await r.ended;
  assert.equal(end.early, false);
  assert.equal(end.why, 'ended');
  assert.equal(end.pos, 98);
  assert.equal(end.skips, 1);
  assert.ok(t.clears >= 1, 'clear picks No blur while it plays');
  assert.equal(seen.length, 1);
});

test('stage.play: a film that stops well before its length is early', async () => {
  const t = playTransport({ states: [{ playing: true, pos: 30, len: 100, skips: 0 }, { playing: false, pos: 0, len: 0 }] });
  const r = await new Meeting(t).stage.play(tmpFile());
  const end = await r.ended;
  assert.equal(end.early, true);
  assert.equal(end.pos, 30);
  assert.equal(end.why, 'stopped');
});

test('stage.play: the page answers a refusal; a missing file and core mode are errors; leave ends the wait', async () => {
  await assert.rejects(new Meeting(playTransport({ start: { ok: false, error: 'This page has no Rebroadcast button.' }, states: [] })).stage.play(tmpFile()), /no Rebroadcast button/);
  await assert.rejects(new Meeting(playTransport({ states: [] })).stage.play('/nonexistent/clip.webm'), /No such file/);
  const core = { onEvent() {}, async call() { return { ok: true }; }, async close() {} };
  await assert.rejects(new Meeting(core).stage.play(tmpFile()), /browser mode/);
  assert.equal(await new Meeting(core).stage.playing(), null);
  const t = playTransport({ states: [{ playing: true, pos: 1, len: 100 }] });
  const meet = new Meeting(t);
  const r = await meet.stage.play(tmpFile());
  await meet.close();
  assert.equal((await r.ended).why, 'closed');
});

test('stage.play: a page that stops answering (reloading) ends the film after a few tries', async () => {
  const e = new Error('Execution context was destroyed');
  const t = playTransport({ states: [{ playing: true, pos: 5, len: 100 }, e, e, e, e, e, e, e] });
  const end = await (await new Meeting(t).stage.play(tmpFile())).ended;
  assert.equal(end.why, 'page');
  assert.equal(end.pos, 5);
});
