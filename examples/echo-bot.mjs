// A bot with no model and no keys: fixed rules over the SDK.
// Run: node examples/echo-bot.mjs https://gifos.app/meet/<room>   (needs espeak-ng for its voice)
// Say to it in chat: "hi", "raise your hand", "lower your hand", "what do you see", "leave".
import { join } from '../src/index.js';   // in your own project: from '@gifos-app/agent'
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const link = process.argv[2];
if (!link) { console.error('usage: node echo-bot.mjs <meeting link>'); process.exit(2); }

// A voice without downloads: espeak-ng writes a WAV.
const tts = async (text) => {
  const f = path.join(os.tmpdir(), `echo-bot-${process.pid}.wav`);
  execFileSync('espeak-ng', ['-s', '160', '-w', f, String(text)]);
  const wav = fs.readFileSync(f); fs.unlinkSync(f);
  return { wav };
};

const meet = await join(link, { name: 'Echo (demo bot)', tts });
const log = (...a) => console.log(new Date().toISOString(), ...a);
log('joined');
let leaving = false;
async function leave() { if (leaving) return; leaving = true; await meet.leave().catch(() => {}); log('left'); process.exit(0); }
process.on('SIGINT', leave);
process.on('SIGTERM', leave);

// Frame stats only: this bot has no vision, it reports what arrived.
async function describe() {
  const others = (await meet.people()).filter((p) => !p.me);
  if (!others.length) return 'I am alone here.';
  const eye = await meet.video.in.open({ who: others[0].id, fps: 1, width: 320 });
  const timer = setTimeout(() => eye.close().catch(() => {}), 15000);
  let frame = null;
  for await (const fr of eye) { frame = fr; break; }
  clearTimeout(timer);
  await eye.close().catch(() => {});
  return frame ? `A ${frame.width} by ${frame.height} frame from ${others[0].name || 'someone'}${frame.blurred ? ', blurred' : ''}.`
               : 'No frame reached me.';
}

for await (const line of meet.lines({ toMe: true })) {
  const t = String(line.text || '');
  log('line', line.kind, line.trust, JSON.stringify(t));
  try {
    if (/\b(leave|goodbye)\b/i.test(t)) { await meet.chat('Bye!'); await leave(); }
    else if (/lower your hand/i.test(t)) await meet.hand(false);
    else if (/raise your hand/i.test(t)) await meet.hand(true);
    else if (/what do you see|look at/i.test(t)) await meet.chat(await describe());
    else { await meet.chat(`You said: ${t}`); await meet.say(`You said: ${t}`, { wait: false }); }
  } catch (e) { log('action failed:', e.message); await meet.chat(`I could not do that: ${e.message}`).catch(() => {}); }
}
