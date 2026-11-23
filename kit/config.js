// One JSON file per bot. loadConfig(path) reads it, fills defaults and refuses anything unsafe (inline secrets,
// a full name, no link). Secrets are named, never written: key_env (an environment variable) or key_file (a file
// path, e.g. a 0600 file outside the repo).
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
  owner: '',
  declaration: '',
  password_env: '',
  rank: 0,
  siblings: {},
  prompt: { system: 'You are a friendly meeting bot. Be brief.', knowledge: [], guardrails: [], refresh_min: 60, max_knowledge_chars: 12000 },
  limits: { replies_per_min: 6, per_person_s: 8, max_reply_chars: 400, max_say_chars: 300, greet_every_s: 12, reply_timeout_s: 25, bot_turns: 2 },
  brain: { provider: 'fixed' },
  voice: { provider: 'none' },
  avatar: { enabled: false, set: 'blob', fps: 6, width: 160, height: 120 },
  greet: { enabled: true, text: 'Hi {names}! I am {name}, a bot. Ask me anything about this meeting.' },
  answer: 'mention',
};

const SECRET_KEYS = /^(key|api_key|apikey|token|secret|password|authorization)$/i;

function scanSecrets(o, where) {
  if (!o || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    if (SECRET_KEYS.test(k) && v) throw new Error(`${where}.${k}: put secrets in an environment variable (key_env) or a file (key_file), never in the config.`);
    if (v && typeof v === 'object') scanSecrets(v, `${where}.${k}`);
  }
}

const merge = (a, b) => Object.assign({}, a, b || {});

export function normalizeConfig(raw, base = process.cwd()) {
  if (!raw || typeof raw !== 'object') throw new Error('A bot config is a JSON object.');
  scanSecrets(raw, 'config');
  const name = String(raw.name || '').trim();
  if (!/^[\p{L}][\p{L}'-]{0,19}$/u.test(name)) throw new Error('name: one first name only (letters, up to 20), such as "Mia".');
  if (!raw.link || !/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(String(raw.link))) throw new Error('link: the meeting link (https://...).');
  const c = {
    ...DEFAULTS, ...raw, name,
    prompt: merge(DEFAULTS.prompt, raw.prompt), limits: merge(DEFAULTS.limits, raw.limits),
    brain: merge(DEFAULTS.brain, raw.brain), voice: merge(DEFAULTS.voice, raw.voice),
    avatar: merge(DEFAULTS.avatar, raw.avatar), greet: merge(DEFAULTS.greet, raw.greet),
  };
  c.rank = Math.max(0, Math.trunc(Number(c.rank) || 0));
  // siblings: other copies of this bot in the same room, { "Leo": 1 } (name -> rank); the lowest rank present leads
  const sib = c.siblings && typeof c.siblings === 'object' && !Array.isArray(c.siblings) ? c.siblings : {};
  c.sibling_ranks = {};
  for (const [n, r] of Object.entries(sib)) if (n !== name) c.sibling_ranks[n] = Math.max(0, Math.trunc(Number(r) || 0));
  c.siblings = Object.keys(c.sibling_ranks);
  if (!['mention', 'questions'].includes(c.answer)) throw new Error('answer: "mention" (lines that name the bot) or "questions".');
  for (const k of ['replies_per_min', 'per_person_s', 'max_reply_chars', 'max_say_chars', 'greet_every_s', 'reply_timeout_s', 'bot_turns']) {
    const v = Number(c.limits[k]);
    if (!Number.isFinite(v) || v < 0) throw new Error(`limits.${k}: a number >= 0.`);
    c.limits[k] = v;
  }
  c.limits.max_reply_chars = Math.min(2000, Math.max(40, c.limits.max_reply_chars));
  c.avatar.fps = Math.min(15, Math.max(1, Number(c.avatar.fps) || 6));
  c.avatar.width = Math.min(640, Math.max(64, Number(c.avatar.width) || 160));
  c.avatar.height = Math.min(480, Math.max(48, Number(c.avatar.height) || 120));
  // a set is a built-in name or a module path next to the config
  if (c.avatar.set && /[/.]/.test(c.avatar.set)) c.avatar.set = path.resolve(base, c.avatar.set);
  if (c.brain.key_file) c.brain.key_file = path.resolve(base, c.brain.key_file);
  if (c.voice.key_file) c.voice.key_file = path.resolve(base, c.voice.key_file);
  if (c.prompt.system_file) c.prompt.system = fs.readFileSync(path.resolve(base, c.prompt.system_file), 'utf8');
  return c;
}

export function loadConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return normalizeConfig(raw, path.dirname(path.resolve(file)));
}

// The secret a provider names: key_env first, then key_file. '' when it names none (a local server needs none).
export function resolveKey(p, env = process.env) {
  if (p.key_env) {
    const v = env[p.key_env];
    if (!v) throw new Error(`${p.key_env} is not set (the ${p.provider} key).`);
    return v.trim();
  }
  if (p.key_file) return fs.readFileSync(p.key_file, 'utf8').trim();
  return '';
}

// The bot's name as the room sees it: the first name, plus the declaration when there is one ("Mia (GifOS bot)").
export function seatName(c) {
  return c.declaration ? `${c.name} (${String(c.declaration).replace(/[()]/g, '').trim()})` : c.name;
}
