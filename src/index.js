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
import { kokoroTts } from './tts.js';
import { toWav, toPcm16 } from './audio.js';

export { Meeting, agentName, lineMatches, PROTOCOL, EVENTS, ACTIONS, toWav, toPcm16, playwrightTransport, coreTransport };

// The page address in agent mode. A hash that already carries meeting fields (#v=room) gets agent=1 too.
export function agentUrl(link) {
  const u = new URL(link);
  u.searchParams.set('agent', '1');
  const h = new URLSearchParams(u.hash.replace(/^#/, ''));
  if (Array.from(h.keys()).length) { h.set('agent', '1'); u.hash = h.toString(); }
  return u.toString();
}

// The room in a meeting link: /meet/<room>, or #v=<room> on the page itself.
export function roomOf(link) {
  try {
    const u = new URL(link);
    const h = new URLSearchParams(u.hash.replace(/^#/, ''));
    if (h.get('v')) return h.get('v') + (h.get('av') ? '.' + h.get('av') : '');
    const m = u.pathname.match(/\/(?:meet|m)\/([^/?#]+)/);
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

// join(url, { name, owner?, core?, tts?, voice?, password?, relay?, profile?, headless?, joinMs?, chromium? }) -> Meeting
// chromium: a Playwright `chromium` you already load (your own Playwright install); by default the SDK loads its own.
// core: true joins with no browser: the meeting's own core runs in this process (loaded from the meeting's site) over
// real WebRTC data channels. Text only for now (chat, lines, people, hands, stage, apps); no voice or video yet.
export async function join(url, opts = {}) {
  const name = agentName(opts.name, opts.owner);
  // The agent's own profile keeps its person key, so it is the same person across joins.
  const profile = opts.profile || path.join(os.homedir(), '.gifos-agent', slug(name) + '-' + crypto.createHash('sha256').update(name).digest('hex').slice(0, 6));
  if (opts.core) return joinCore(url, name, profile, opts);
  const chromium = opts.chromium || (await import('playwright')).chromium;
  const { context, used } = await launch(chromium, profile, opts);
  const page = context.pages()[0] || await context.newPage();
  const transport = await playwrightTransport(page, { name, relay: opts.relay, room: roomOf(url), password: opts.password, onClose: () => context.close() });
  const tts = opts.tts || (opts.voice === false ? null : await kokoroTts(opts.kokoro || {}));
  const meet = new Meeting(transport, { tts });
  meet.browser = used;
  meet.page = page;
  const sit = seated(meet, opts.joinMs === undefined ? 120000 : opts.joinMs);
  try {
    await page.goto(agentUrl(url), { waitUntil: 'domcontentloaded' });
    await transport.ready(opts.readyMs === undefined ? 60000 : opts.readyMs);
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
  const transport = await coreTransport(agentUrl(url), { name, relay: opts.relay, room: roomOf(url), password: opts.password, profile, webrtc: opts.webrtc, log: opts.log });
  const meet = new Meeting(transport, { tts: null });
  meet.core = true;
  const sit = seated(meet, opts.joinMs === undefined ? 120000 : opts.joinMs);
  try {
    await transport.ready(opts.readyMs === undefined ? 60000 : opts.readyMs);
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
