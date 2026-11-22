// A bot with no browser, no model and no keys: the meeting's own core runs in this process (join(..., { core: true })).
// Run: node examples/core-bot.mjs https://gifos.app/meet/<room>        (Node 22 or later)
// In chat, say to it: "hi", "who is here", "raise your hand", "lower your hand", "next turn" (in a meeting running
// Take Turns), "leave". It answers in chat: a core agent has no voice yet.
import { join } from '../src/index.js';   // in your own project: from '@gifos-app/agent'

const link = process.argv[2];
if (!link) { console.error('usage: node core-bot.mjs <meeting link>'); process.exit(2); }

const meet = await join(link, { name: 'Echo (demo bot)', core: true });
const log = (...a) => console.log(new Date().toISOString(), ...a);
log('joined with no browser');
let leaving = false;
async function leave() { if (leaving) return; leaving = true; await meet.leave().catch(() => {}); log('left'); process.exit(0); }
process.on('SIGINT', leave);
process.on('SIGTERM', leave);

// Take Turns keeps its turn in the app's shared data (collection "turns", record "state"): the next person in the
// order takes the turn and the step counts up, as the app's own Next button does.
async function nextTurn() {
  const ppl = (await meet.app.room('state')).result;
  const people = (ppl && ppl.people) || [];
  if (!people.length) return 'No app here that I can take part in.';
  const rec = (await meet.app.data('get', 'turns', 'state')).result || {};
  const ids = people.map((p) => p.id);
  const order = (rec.order || []).filter((id) => ids.includes(id)).concat(ids.filter((id) => !(rec.order || []).includes(id)));
  const cur = order.includes(rec.cur) ? rec.cur : order[0];
  const next = order[(order.indexOf(cur) + 1) % order.length];
  const hist = (rec.hist || []).slice(-49).concat([[cur, rec.step | 0]]);
  await meet.app.data('put', 'turns', null, { id: 'state', order, cur: next, step: (rec.step | 0) + 1, hist, timer: rec.timer | 0, turnAt: Date.now(), v: (rec.v | 0) + 1 });
  return 'Next: ' + ((people.find((p) => p.id === next) || {}).name || 'the next person') + '.';
}

for await (const line of meet.lines({ kinds: ['chat'] })) {
  const t = String(line.text || '').toLowerCase();
  log(`${line.name}: ${line.text}`);
  try {
    if (/\bleave\b/.test(t)) { await meet.chat('Bye!'); await leave(); }
    else if (/\bhi\b|\bhello\b/.test(t)) await meet.chat(`Hello ${line.name}. I am a bot with no browser.`);
    else if (/who is here/.test(t)) await meet.chat((await meet.people()).map((p) => p.name).join(', '));
    else if (/raise your hand/.test(t)) await meet.hand(true);
    else if (/lower your hand/.test(t)) await meet.hand(false);
    else if (/next turn/.test(t)) await meet.chat(await nextTurn());
  } catch (e) { await meet.chat(String(e.message || e)).catch(() => {}); }
}
