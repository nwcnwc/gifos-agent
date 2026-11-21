#!/usr/bin/env node
// shell-bridge: keep one agent in a GifOS meeting and talk to it through files, for an AI agent that works in a
// shell (it is the language model, so it reads and writes; this process holds the seat).
//
//   gifos-agent-bridge <meeting link> --name "Ada (Sam's assistant)" [--dir ./meeting] [--password <from your human>]
//
//   <dir>/events.jsonl    one JSON object per event: {"type":"line","kind":"chat"|"speech","name","text","toMe",...},
//                         people, hand, stage, video, host, left, ready
//   <dir>/commands.jsonl  append one JSON object per line:
//                           {"do":"chat","text":"..."}            {"do":"say","text":"..."}   (needs a voice)
//                           {"do":"hand","up":true}                {"do":"stage"}  {"do":"unstage"}
//                           {"do":"camera","jpeg":"frame.jpg"}     your camera shows that picture (again to change it)
//                           {"do":"camera","off":true}
//                           {"do":"look","who":"Sam","out":"sam.jpg"}   one frame of their camera, saved as a JPEG
//                           {"do":"people"}                        {"do":"leave"}
//   <dir>/results.jsonl   one answer per command: {"n":<line number>,"ok":true,...} or {"n":..,"ok":false,"error":"..."}
//
// The process leaves the meeting when it exits (Ctrl+C, or {"do":"leave"}).
//
//   gifos-agent-bridge next [--dir ./meeting] [--wait 100]
//                         waits for the next line said or typed TO YOU that you have not seen, prints it as JSON and
//                         exits (exit 1 with {"type":"none"} after --wait seconds; {"type":"left"} if the meeting ended).
//                         Loop on it: next -> act -> next. It is how a shell agent waits without ending its turn.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { join } from '@gifos/agent';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

if (argv[0] === 'next') {
  const d = path.resolve(opt('dir', './meeting'));
  fs.mkdirSync(d, { recursive: true });   // next may start before the bridge has made the folder
  const ev = path.join(d, 'events.jsonl'), seen = path.join(d, '.seen');
  const until = Date.now() + 1000 * Number(opt('wait', '100'));
  let from = 0; try { from = Number(fs.readFileSync(seen, 'utf8')) || 0; } catch (e) {}
  for (;;) {
    let lines = [];
    try { lines = fs.readFileSync(ev, 'utf8').split('\n'); } catch (e) {}
    for (let i = from; i < lines.length - 1; i++) {
      let o; try { o = JSON.parse(lines[i]); } catch (e) { continue; }
      const hit = (o.type === 'line' && o.toMe && !o.mine) || o.type === 'left';
      if (hit) { fs.writeFileSync(seen, String(i + 1)); console.log(JSON.stringify(o)); process.exit(0); }
    }
    from = Math.max(from, lines.length - 1);
    fs.writeFileSync(seen, String(from));
    if (Date.now() > until) { console.log(JSON.stringify({ type: 'none', note: 'nothing new for you yet; run next again' })); process.exit(1); }
    await new Promise((r) => setTimeout(r, 500));
  }
}
const link = argv.find((a) => /^https?:\/\//.test(a));
if (!link) { console.error('usage: gifos-agent-bridge <meeting link> --name "Ada (Sam\'s assistant)" [--dir ./meeting] [--password pw]'); process.exit(2); }
const dir = path.resolve(opt('dir', './meeting'));
fs.mkdirSync(dir, { recursive: true });
const EV = path.join(dir, 'events.jsonl'), CMD = path.join(dir, 'commands.jsonl'), RES = path.join(dir, 'results.jsonl');
if (!fs.existsSync(CMD)) fs.writeFileSync(CMD, '');
const put = (f, o) => fs.appendFileSync(f, JSON.stringify(Object.assign({ at: new Date().toISOString() }, o)) + '\n');

// A voice: kokoro-js when installed (the SDK's default), else espeak-ng when on this computer, else none (say rejects).
let tts;
try { await import('kokoro-js'); } catch (e) {
  try { execFileSync('espeak-ng', ['--version'], { stdio: 'ignore' }); tts = async (text) => { const f = path.join(dir, '.say.wav'); execFileSync('espeak-ng', ['-w', f, String(text)]); return { wav: fs.readFileSync(f) }; }; } catch (e2) {}
}

const meet = await join(link, { name: opt('name', 'Assistant'), owner: opt('owner'), password: opt('password'), tts });
put(EV, { type: 'ready', state: await meet.state().catch(() => null) });
console.log('in the meeting; events -> ' + EV + ', commands <- ' + CMD);
meet.on('*', (ev) => { if (!/frame$|^speaking$|^progress$|^say\.done$/.test(ev.type)) put(EV, { type: ev.type, ...(ev.data && typeof ev.data === 'object' ? ev.data : { data: ev.data }) }); });
meet.on('left', () => { setTimeout(() => process.exit(0), 500); });
(async () => { for await (const l of meet.lines({})) { /* subscribing marks the tile "taking notes"; lines reach events.jsonl via '*' */ } })();

let cam = null, camTimer = null;
async function camera(c) {
  if (c.off) { if (camTimer) clearInterval(camTimer); camTimer = null; if (cam) await cam.close(); cam = null; return {}; }
  const jpeg = fs.readFileSync(path.resolve(dir, c.jpeg));
  if (!cam) cam = await meet.video.out.open({ width: 640, height: 480, fps: 5 });
  if (camTimer) clearInterval(camTimer);
  camTimer = setInterval(() => { cam.write(jpeg).catch(() => {}); }, 200);
  await cam.write(jpeg);
  return {};
}
async function look(c) {
  const people = await meet.people();
  const who = people.find((p) => !p.me && (p.id === c.who || String(p.name || '').toLowerCase().includes(String(c.who || '').toLowerCase())));
  if (!who) throw new Error('Nobody called ' + c.who + ' here.');
  const eye = await meet.video.in.open({ who: who.id, fps: 1, width: 640 });
  const t = setTimeout(() => eye.close().catch(() => {}), 20000);
  let f = null;
  for await (const fr of eye) { f = fr; break; }
  clearTimeout(t); await eye.close().catch(() => {});
  if (!f || !f.jpeg) throw new Error('No picture of ' + who.name + '’s camera arrived (is it on?).');
  const out = path.resolve(dir, c.out || 'look.jpg');
  fs.writeFileSync(out, f.jpeg);
  return { file: out, width: f.width, height: f.height, blurred: f.blurred };
}
const DO = {
  chat: (c) => meet.chat(String(c.text || '')),
  say: (c) => meet.say(String(c.text || '')),
  hand: (c) => meet.hand(c.up !== false),
  stage: () => meet.stage.ask(),
  unstage: () => meet.stage.leave(),
  camera, look,
  people: async () => ({ people: await meet.people() }),
  leave: async () => { await meet.leave(); setTimeout(() => process.exit(0), 500); return {}; },
};

let done = 0;
async function pump() {
  const lines = fs.readFileSync(CMD, 'utf8').split('\n');
  for (; done < lines.length - 1; done++) {
    const raw = lines[done].trim(); const n = done + 1;
    if (!raw) continue;
    let c; try { c = JSON.parse(raw); } catch (e) { put(RES, { n, ok: false, error: 'Not JSON: ' + raw.slice(0, 80) }); continue; }
    const fn = DO[c.do];
    if (!fn) { put(RES, { n, ok: false, error: 'Unknown command "' + c.do + '". Known: ' + Object.keys(DO).join(', ') }); continue; }
    try { const r = await fn(c); put(RES, { n, do: c.do, ok: true, ...(r && typeof r === 'object' ? r : {}) }); }
    catch (e) { put(RES, { n, do: c.do, ok: false, error: e.message }); }
  }
}
// Start after the commands already in the file (a restart does not replay them).
done = Math.max(0, fs.readFileSync(CMD, 'utf8').split('\n').length - 1);
let busy = false;
setInterval(async () => { if (busy) return; busy = true; try { await pump(); } finally { busy = false; } }, 250);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, async () => { try { await meet.leave(); } catch (e) {} process.exit(0); });
