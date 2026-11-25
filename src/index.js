// @gifos-app/agent: join a GifOS meeting as an AI agent. Everything the agent does goes through the meeting page's own
// window.gifosAgent API, so the page keeps every room rule (proof of work, password, host orders, slow mode, blur).
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Meeting } from './meeting.js';
import { agentName, lineMatches, PROTOCOL, EVENTS, ACTIONS } from './protocol.js';
import { launch } from './browser.js';
import { playwrightTransport } from './transport-playwright.js';
import { coreTransport } from './transport-core.js';
import { GIFOS_CORE_KEYS, MIN_CORE_BUILD, signedBytes, fetchSignedCore } from './core-trust.js';
import { kokoroTts } from './tts.js';
import { CORE_MODE, CORE_MODE_OFF } from './flags.js';
import { toWav, toPcm16 } from './audio.js';
import { siteVersion, watchSite, compareVersions } from './site.js';
import { hostKey, hostLink } from './host.js';

export { Meeting, agentName, lineMatches, PROTOCOL, EVENTS, ACTIONS, toWav, toPcm16, playwrightTransport, coreTransport, GIFOS_CORE_KEYS, MIN_CORE_BUILD, signedBytes, fetchSignedCore, CORE_MODE, siteVersion, watchSite, compareVersions, hostKey, hostLink };

// The page address in agent mode. A hash that already carries meeting fields (#room=room) gets agent=1 too.
export function agentUrl(link) {
  const u = new URL(link);
  u.searchParams.set('agent', '1');
  const h = new URLSearchParams(u.hash.replace(/^#/, ''));
  if (Array.from(h.keys()).length) { h.set('agent', '1'); u.hash = h.toString(); }
  return u.toString();
}

// The room in a meeting link: /meet#room=<room>[&v=<verifier>] (the link GifOS
// hands out), the older /meet/<room> or /cast/<room>, or #room=<room>[&v=<verifier>] on the page itself.
// The old #v=<room>&av=<verifier> form names no room.
export function roomOf(link) {
  try {
    const u = new URL(link);
    const h = new URLSearchParams(u.hash.replace(/^#/, ''));
    if (h.get('room')) return h.get('room') + (h.get('v') ? '.' + h.get('v').toLowerCase() : '');
    const m = u.pathname.match(/\/(?:meet|cast|m)\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  } catch (e) { return ''; }
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'agent';

// Wait for the page to say the seat is joined, or that the room asks for a password (the agent asks its
// human for it, never guesses).
function seated(meet, ms) {
  return new Promise((resolve, reject) => {
    const offs = [];
    const done = (fn, v) => { offs.forEach((f) => f()); clearTimeout(t); fn(v); };
    offs.push(meet.on('joined', (d) => done(resolve, d)));
    offs.push(meet.on('password', () => done(reject, new Error('The room asks for a password. Ask your human for it and pass { password }.'))));
    offs.push(meet.on('left', (d) => done(reject, new Error('The page left the meeting (' + ((d && d.reason) || 'unknown') + ').'))));
    const t = ms ? setTimeout(() => done(reject, new Error('The meeting did not seat this agent in ' + Math.round(ms / 1000) + ' s.')), ms) : null;
  });
}

// join(url, { name, owner?, core?, tts?, voice?, password?, hostPassword?, listed?, credentials?, relay?, profile?, headless?, joinMs?, chromium?, meshC?, payUrl? }) -> Meeting
// chromium: a Playwright `chromium` you already load (your own Playwright install); by default the SDK loads its own.
// core: true joins with no browser: the meeting's own core, signed by GifOS, runs in a sandboxed child process (loaded
// from the meeting's site; docs/core-trust.md; coreKeys trusts your own signing key instead) over real WebRTC.
// Voice, ears and pictures go through the core's Node media plane; the seat takes its row's duties like any seat.
// No camera of its own yet: video.out answers that it cannot make a camera with no browser.
// meshC (core only, for tests): room shape C (2..5). deriveMeet folds a C other than 5 into the relay session id: every seat of the room
// must carry the same C, and a non-default C only takes effect with DEBUG=on in the link (gifos-net.js SCALE.C).
// hostPassword: host the link's hosted room. The seat holds the room's host key (derived here; the password stays in
// this process) the way the page keeps it after "Host a private meeting", so it joins as the room's host. A link with
// no v= gets this password's verifier; meet.link is the room's link either way.
// listed: the room's gifos.tv listing (the address "Publish to GifOS.tv" gave). The page then keeps the listing live
// while this seat hosts the room: its on-air note, a keep-alive every few minutes, its off-air note when it leaves.
// credentials: a credentials GIF (a subscription file or a pass; a path or the bytes), used before the seat knocks.
// payUrl (core only, for tests): the payment service of a local GifOS stack (subscriptions, room capture); the core's
// own default is pay.gifos.app, as for a page with no window.GIFOS_PAY_URL.
export async function join(url, opts = {}) {
  if (opts.core && !CORE_MODE) throw new Error(CORE_MODE_OFF);
  const name = agentName(opts.name, opts.owner);
  let store = {};
  if (opts.hostPassword) {
    if (opts.core) throw new Error('hostPassword works in browser mode for now (join without { core: true }).');
    const h = hostLink(url, opts.hostPassword);
    url = h.link;
    store['gifos_vadm_' + h.room + '.' + h.verifier] = h.key;
    if (opts.listed) {
      if (!/^https:\/\/\S+$/.test(String(opts.listed))) throw new Error('listed is the room\'s gifos.tv listing address (https://...).');
      store['gifos_tv:' + h.room + '.' + h.verifier] = JSON.stringify({ url: String(opts.listed), at: Date.now() });
    }
  } else if (opts.listed) throw new Error('listed needs hostPassword: only the room\'s host keeps its listing live.');
  // The agent's own profile keeps its person key, so it is the same person across joins.
  const profile = opts.profile || path.join(os.homedir(), '.gifos-agent', slug(name) + '-' + crypto.createHash('sha256').update(name).digest('hex').slice(0, 6));
  if (opts.core) return joinCore(url, name, profile, opts);
  const chromium = opts.chromium || (await import('playwright')).chromium;
  const { context, used } = await launch(chromium, profile, opts);
  const page = context.pages()[0] || await context.newPage();
  const transport = await playwrightTransport(page, { name, relay: opts.relay, room: roomOf(url), password: opts.password, store, onClose: () => context.close() });
  const tts = opts.tts || (opts.voice === false ? null : await kokoroTts(opts.kokoro || {}));
  const meet = new Meeting(transport, { tts });
  meet.browser = used;
  meet.page = page;
  meet.link = url;
  const sit = seated(meet, opts.joinMs === undefined ? 120000 : opts.joinMs);
  try {
    await page.goto(agentUrl(url), { waitUntil: 'domcontentloaded' });
    await transport.ready(opts.readyMs === undefined ? 60000 : opts.readyMs);
    if (opts.credentials) meet.rightsAtJoin = await meet.useCredentials(opts.credentials);
    const st = await meet.state().catch(() => null);
    if (!(st && st.joined)) await sit; else sit.catch(() => {});
    if (opts.owner || opts.notesTo) await meet.profile({ owner: opts.owner, notesTo: opts.notesTo }).catch(() => {});
  } catch (e) {
    sit.catch(() => {});
    await context.close().catch(() => {});
    throw e;
  }
  return meet;
}

async function joinCore(url, name, profile, opts) {
  const tts = opts.tts || (opts.voice === false ? null : await kokoroTts(opts.kokoro || {}));   // the voice first: the seat speaks through the core's media plane
  const transport = await coreTransport(agentUrl(url), { name, relay: opts.relay, room: roomOf(url), password: opts.password, profile, coreKeys: opts.coreKeys, log: opts.log, meshC: opts.meshC, payUrl: opts.payUrl });
  const meet = new Meeting(transport, { tts });
  meet.core = true;
  meet.link = url;
  const sit = seated(meet, opts.joinMs === undefined ? 120000 : opts.joinMs);
  try {
    await transport.ready(opts.readyMs === undefined ? 60000 : opts.readyMs);
    if (opts.credentials) meet.rightsAtJoin = await meet.useCredentials(opts.credentials);
    const st = await meet.state().catch(() => null);
    if (!(st && st.joined)) await sit; else sit.catch(() => {});
    if (opts.owner || opts.notesTo) await meet.profile({ owner: opts.owner, notesTo: opts.notesTo }).catch(() => {});
  } catch (e) {
    sit.catch(() => {});
    await transport.close().catch(() => {});
    throw e;
  }
  return meet;
}

// connect(page): drive a GifOS page you already opened in agent mode (your own Playwright session).
export async function connect(page, opts = {}) {
  const transport = await playwrightTransport(page, { name: opts.name || '' });
  await transport.ready(opts.readyMs === undefined ? 60000 : opts.readyMs);
  await transport.hookNow();
  return new Meeting(transport, { tts: opts.tts || null });
}
