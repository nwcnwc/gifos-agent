#!/usr/bin/env node
// gifos-agent-stdio: one agent seat, driven over stdin/stdout as JSON lines. It is how an SDK in another language
// (the Python package) takes part: this process holds the seat, the caller sends calls and reads answers and events.
//
//   in  (one JSON object per line):
//     {"id":1,"join":"<meeting link>","opts":{"name":"Ada (Sam's assistant)","password":"..."}}   first
//     {"id":2,"call":"chat","args":{"text":"hello"}}      any call of the page's gifosAgent contract
//     {"id":3,"call":"leave"}                             leaves, answers, then this process exits
//   out (one JSON object per line):
//     {"id":1,"ok":true,"core":false,"state":{...}}       the answer to a join
//     {"id":2,"ok":true,"answer":{...}}                   the answer to a call, as the page gave it
//     {"id":2,"ok":false,"error":"<the page's sentence>"}
//     {"event":{"type":"line","data":{...}}}              every page event (audio and video frames excepted)
// Diagnostics go to stderr. The process leaves the meeting when stdin closes.
import readline from 'node:readline';
import { join } from './index.js';

const out = (o) => { try { process.stdout.write(JSON.stringify(o) + '\n'); } catch (e) {} };
let meet = null, leaving = false;

async function leave(code) {
  if (leaving) return;
  leaving = true;
  if (meet) await meet.leave().catch(() => {});
  setTimeout(() => process.exit(code || 0), 100);
}

async function handle(m) {
  if (m.join !== undefined) {
    if (meet) return out({ id: m.id, ok: false, error: 'This seat already joined a meeting.' });
    const o = m.opts || {};
    try {
      meet = await join(String(m.join), { name: o.name, owner: o.owner, notesTo: o.notesTo, password: o.password, core: !!o.core, coreKeys: Array.isArray(o.coreKeys) ? o.coreKeys.map(String) : undefined, relay: o.relay, profile: o.profile, voice: o.core ? false : o.voice, joinMs: o.joinMs, readyMs: o.readyMs });
    } catch (e) { return out({ id: m.id, ok: false, error: String((e && e.message) || e) }); }
    meet.on('*', (ev) => { if (!/frame$/.test(ev.type)) out({ event: { type: ev.type, data: ev.data === undefined ? null : ev.data } }); });
    meet.on('left', () => { leave(0); });
    return out({ id: m.id, ok: true, core: !!meet.core, state: await meet.state().catch(() => null) });
  }
  if (typeof m.call !== 'string') return out({ id: m.id, ok: false, error: 'Send {"join": link} or {"call": name, "args": {...}}.' });
  if (!meet) return out({ id: m.id, ok: false, error: 'Join a meeting first.' });
  if (m.call === 'leave') { await meet.leave().catch(() => {}); out({ id: m.id, ok: true }); return leave(0); }
  try { out({ id: m.id, ok: true, answer: await meet.call(m.call, m.args || {}) }); }
  catch (e) { out({ id: m.id, ok: false, error: String((e && e.message) || e) }); }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let m; try { m = JSON.parse(line); } catch (e) { return out({ id: null, ok: false, error: 'Not a JSON line.' }); }
  handle(m || {}).catch((e) => out({ id: m && m.id, ok: false, error: String((e && e.message) || e) }));
});
rl.on('close', () => { leave(0); });
process.on('SIGTERM', () => { leave(0); });
process.on('SIGINT', () => { leave(0); });
