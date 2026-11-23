// runBot(cfg): one bot in one meeting, on the public SDK only (join, lines, people, speaking, say, chat, video.out),
// so it runs on a browser seat today and on a core seat later unchanged (a seat with no voice or video port answers
// in chat and shows no avatar).
//   greets newcomers once (batched names, at most one greeting per greet_every_s), only while it leads
//   answers lines that name it (answer: "mention"), or any question (answer: "questions"), only while it leads,
//     except a line that names it: then it answers whoever leads
//   leads: no sibling of lower rank is in the room (siblings are other bots, flagged bot by the page, by name)
//   speaks its answer when it has a voice and nobody is talking; otherwise, or when the line is cut off, chats it
//   never answers itself, its siblings, or more than bot_turns lines in a row from bots
import { join as sdkJoin } from '../src/index.js';
import { seatName } from './config.js';
import { Knowledge } from './knowledge.js';
import { makeBrain, guarded, systemPrompt } from './brain.js';
import { makeVoice } from './voice.js';
import { Avatar, loadSet } from './avatar.js';

export function greetingText(c, names) {
  const list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
  return String(c.greet.text).replace(/\{names\}/g, list).replace(/\{name\}/g, c.name);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function namesMe(c, text) { return new RegExp('\\b' + esc(c.name) + '\\b', 'i').test(String(text || '')); }

// Pure decisions (the unit tests drive these).
export function leads(c, people) {
  const ranks = c.sibling_ranks || {};
  return !people.some((p) => !p.me && p.bot && c.siblings.includes(baseName(p.name)) && (ranks[baseName(p.name)] ?? 0) < c.rank);
}
export function baseName(n) { return String(n || '').replace(/\s*\(.*$/, '').trim(); }
export function shouldAnswer(c, line, { lead, botRun }) {
  if (!line || line.mine || line.kind === 'spoken' || line.kind === 'system') return false;
  if (c.siblings.includes(baseName(line.name))) return false;
  if (line.bot && botRun >= c.limits.bot_turns) return false;
  if (namesMe(c, line.text) || line.toMe) return true;
  if (!lead) return false;
  return c.answer === 'questions' && /\?\s*$/.test(line.text);
}

export async function runBot(c, { join = sdkJoin, log = console.log, fetchFn, env } = {}) {
  const t0 = Date.now();
  const note = (ev, d = {}) => log(JSON.stringify({ t: ((Date.now() - t0) / 1000).toFixed(1), bot: c.name, ev, ...d }));
  const knowledge = new Knowledge(c.prompt.knowledge, { refreshMin: c.prompt.refresh_min, maxChars: c.prompt.max_knowledge_chars, fetchFn });
  if (c.prompt.knowledge.length) { await knowledge.refresh(); note('knowledge', { sections: knowledge.parts.length, chars: knowledge.text.length }); }
  const brain = guarded(makeBrain(c, { knowledge, fetchFn, env }), c);
  const voice = await makeVoice(c, { fetchFn, env });
  const password = c.password_env ? (env || process.env)[c.password_env] : undefined;
  const meet = await join(c.link, { name: seatName(c), owner: c.owner || undefined, password, tts: voice ? voice.tts : undefined, voice: voice ? undefined : false });
  note('joined', { voice: voice ? voice.provider : 'none', brain: brain.name });

  // avatar
  let avatar = null;
  if (c.avatar.enabled) {
    try {
      const port = await meet.video.out.open({ width: c.avatar.width, height: c.avatar.height, fps: c.avatar.fps });
      avatar = new Avatar(await loadSet(c.avatar.set), c.avatar, port).start();
      note('avatar', { set: c.avatar.set, fps: c.avatar.fps, size: `${c.avatar.width}x${c.avatar.height}` });
    } catch (e) { note('avatar_off', { why: e.message }); }
  }
  const talking = new Set();   // others speaking now
  let saying = false;
  const paint = () => { if (avatar && !saying) avatar.setState(talking.size ? 'listening' : 'idle'); };
  meet.on('speaking', (s) => { if (!s || s.me || s.id === meId()) return; if (s.on) talking.add(s.id); else talking.delete(s.id); paint(); });

  let people = [];
  let me = null;
  const meId = () => me && me.id;
  try { const st = await meet.state(); me = st.me; people = st.people || []; } catch (e) {}
  const seen = new Set(people.map((p) => p.id));   // whoever is here when we arrive is not new
  const queue = [];
  let lastGreet = 0;
  meet.on('people', (list) => {
    people = list || [];
    for (const p of people) {
      if (p.me || seen.has(p.id)) continue;
      seen.add(p.id);
      if (!p.bot && c.greet.enabled) queue.push({ id: p.id, name: baseName(p.name) || 'there', at: Date.now() });
    }
  });

  // speak, or chat when voiceless / someone is talking / the line was cut off
  async function answer(text, why) {
    if (voice && !talking.size) {
      // say() calls voice.tts itself; the mouth follows the envelope of that audio from the moment it is made
      let start = 0;
      voice.onAudio = () => { start = Date.now(); };
      saying = true;
      if (avatar) avatar.setState('speaking', () => (start ? voice.lastEnvelope()[Math.floor((Date.now() - start) / 1000 * c.avatar.fps)] || 0 : 0));
      try {
        const r = await meet.say(text);
        note('said', { why, ms: r && r.ms, stopped: r && r.stopped });
        if (r && r.stopped) await meet.chat(text).catch(() => {});   // cut off: the words still reach the room
        return;
      } catch (e) { note('say_failed', { why: e.message }); }
      finally { saying = false; voice.onAudio = null; paint(); }
    }
    await meet.chat(text).then(() => note('chatted', { why }), (e) => note('chat_failed', { why: e.message }));
  }

  const greetTimer = setInterval(async () => {
    if (!queue.length || Date.now() - lastGreet < c.limits.greet_every_s * 1000) return;
    const here = new Set(people.map((p) => p.id));
    const settled = queue.filter((q) => Date.now() - q.at > 4000 && here.has(q.id));
    if (!settled.length) return;
    queue.splice(0, queue.length, ...queue.filter((q) => !settled.includes(q) && here.has(q.id)));
    if (!leads(c, people)) return;
    lastGreet = Date.now();
    await answer(greetingText(c, settled.map((q) => q.name)), 'greet');
  }, 1000);

  let botRun = 0;
  const history = [];
  meet.on('line', async (line) => {
    const fromBot = !!(people.find((p) => p.id === line.id) || {}).bot;
    botRun = fromBot ? botRun + 1 : 0;
    if (!shouldAnswer(c, { ...line, bot: fromBot }, { lead: leads(c, people), botRun })) return;
    await knowledge.fresh();
    const reply = await brain.reply({ system: systemPrompt(c, knowledge.context(line.text, c.prompt.max_knowledge_chars)), history: history.slice(-8), text: line.text, from: baseName(line.name), fromId: line.id });
    if (!reply) return;
    history.push({ role: 'user', content: `${baseName(line.name)}: ${line.text}` }, { role: 'assistant', content: reply });
    note('reply', { to: baseName(line.name), q: line.text.slice(0, 120), a: reply.slice(0, 200) });
    await answer(reply, 'reply');
  });

  const stop = async () => { clearInterval(greetTimer); if (avatar) avatar.stop(); await meet.leave().catch(() => {}); };
  return { meet, stop, avatar, stats: () => ({ frames: avatar ? avatar.frames : 0, drawMs: avatar ? avatar.drawMs : 0 }) };
}
