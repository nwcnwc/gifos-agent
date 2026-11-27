#!/usr/bin/env node
// A 24/7 channel: host a broadcast room and play a playlist of video files to its Stage, one after another, forever.
// Viewers watch at the room's broadcast link (or its gifos.tv listing) and see each film marked Prerecorded.
//
//   GIFOS_HOST_PASSWORD=... node tv-channel.mjs <room> <playlist.json> [--listed https://gifos.tv/...]
//        [--credentials pass.gif] [--state ./state] [--site https://gifos.app] [--name "My TV (Sam's channel)"]
//
// playlist.json: [{"file": "films/one.webm", "title": "One"}, ...] (paths relative to the playlist file). WebM (VP8 or
// VP9 with Opus) or MP4 (H.264 with AAC) at 640x360 plays well on small computers. Long files (a "reel" of several
// films joined into one) give the smoothest channel: each new file costs viewers a second or two of quiet.
//
// It keeps its place in <state>/position.json, writes <state>/health.json every few seconds (for a watchdog), loads
// the page again when GifOS releases a new version, and exits non-zero when it cannot keep the broadcast going: run
// it under a supervisor that restarts it (systemd Restart=always, pm2, a shell loop).
import fs from 'node:fs';
import path from 'node:path';
import { join, watchSite } from '@gifos-app/agent';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const [room, playlistFile] = argv;
const password = process.env.GIFOS_HOST_PASSWORD || '';
if (!room || !playlistFile || !password) {
  console.error('usage: GIFOS_HOST_PASSWORD=... node tv-channel.mjs <room> <playlist.json> [--listed URL] [--credentials pass.gif]');
  process.exit(2);
}
const SITE = opt('site', 'https://gifos.app').replace(/\/+$/, '');
const STATE = path.resolve(opt('state', 'state'));
const NAME = opt('name', 'My TV (a GifOS channel)');
fs.mkdirSync(STATE, { recursive: true });
const log = (ev, o) => console.log(JSON.stringify({ t: new Date().toISOString(), ev, ...o }));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const writeJson = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o)); fs.renameSync(f + '.tmp', f); };
const playlist = () => readJson(playlistFile, []).map((c) => ({ ...c, path: path.resolve(path.dirname(playlistFile), c.file) })).filter((c) => fs.existsSync(c.path));

async function hostRoom() {
  const meet = await join(SITE + '/cast#room=' + room, {
    name: NAME,
    hostPassword: password,                    // this seat is the room's host
    listed: opt('listed'),                     // keep the room's gifos.tv listing live while it hosts
    credentials: opt('credentials'),           // a pass or subscription file: room size and the other rights it grants
    voice: false,
    profile: path.join(STATE, 'profile'),
  });
  log('joined', { link: meet.link });
  return meet;
}

let meet = await hostRoom();
let moving = Promise.resolve(), rejoining = false;
// A new GifOS release: leave and join again, so the seat runs the release fresh viewers get.
watchSite(SITE, ({ to }) => {
  moving = (async () => { rejoining = true; log('site.update', { to }); await meet.leave().catch(() => {}); meet = await hostRoom(); rejoining = false; })();
}, { everyMs: 5 * 60 * 1000 });
// The seat must stay in the room as its host. Out of it for two minutes: exit, and the supervisor starts afresh.
let hostedAt = Date.now();
setInterval(async () => {
  const st = rejoining ? null : await meet.state().catch(() => null);
  if (rejoining || (st && st.joined && st.me && st.me.admin)) hostedAt = Date.now();
  else if (Date.now() - hostedAt > 120000) { log('fatal', { m: 'not hosting the room' }); process.exit(1); }
}, 10000);

let { i = -1 } = readJson(path.join(STATE, 'position.json'), {});
let resume = null, fails = 0, tries = 0;
for (;;) {
  await moving;
  const list = playlist();
  if (!list.length) throw new Error('the playlist names no file that exists');
  if (resume && list[resume.i]) i = resume.i; else i = (i + 1) % list.length;
  const clip = list[i], startAt = resume ? resume.pos : 0;
  resume = null;
  let film;
  try {
    film = await meet.stage.play(clip.path, { startAt, clear: true });
  } catch (e) {
    log('play.fail', { i, file: clip.file, m: e.message });
    if (++fails >= 5 || (meet.closed && !rejoining)) throw e;   // the browser is gone: start afresh                 // the supervisor starts a fresh process
    await new Promise((r) => setTimeout(r, 5000));
    continue;
  }
  fails = 0;
  writeJson(path.join(STATE, 'position.json'), { i, file: clip.file });
  log('play', { i, file: clip.file, title: clip.title, len: Math.round(film.len), startAt });
  const health = setInterval(() => writeJson(path.join(STATE, 'health.json'), { t: Date.now(), i, file: clip.file }), 5000);
  const end = await film.ended;
  clearInterval(health);
  log('played', { i, file: clip.file, pos: Math.round(end.pos), len: Math.round(end.len), why: end.why, skips: end.skips });
  // Stopped well before its end (a page reload, a bad spot in the file): go on a little past where it was, up to 5
  // times in a row; then the next file, so a broken file cannot hold the channel.
  tries = end.early ? tries + 1 : 0;
  if (end.early && tries <= 5) resume = { i, pos: end.pos + 3 * tries };
}
