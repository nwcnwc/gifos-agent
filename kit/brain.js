// The brain: reply({ system, history, text, from }) -> Promise<string>. Providers:
//   fixed   no LLM: a greeting for hellos, else the best-matching knowledge section, else a fallback line.
//   openai  any OpenAI-compatible /chat/completions: OpenAI, OpenRouter, Groq, llama.cpp, Ollama (local
//           http://127.0.0.1:11434/v1, or Ollama cloud https://ollama.com/v1 with a key).
// guarded() wraps any brain with the limits: rate, per-person cooldown, length, timeout, output filter.
import { resolveKey } from './config.js';

const HELLO = /^(hi|hello|hey|yo|hiya|good (morning|afternoon|evening))\b/i;

export function fixedBrain({ knowledge, name = 'the bot', fallback } = {}) {
  return {
    name: 'fixed',
    async reply({ text }) {
      const t = String(text || '').replace(new RegExp('\\b' + name + '\\b[,:]?', 'ig'), '').trim();
      if (!t || HELLO.test(t)) return `Hi! I'm ${name}, a bot. Ask me a question and I'll answer from what I know.`;
      const hits = knowledge ? knowledge.search(t, 1) : [];
      if (hits.length) {
        const s = hits[0];
        const para = s.text.split(/\n\s*\n/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
        return (s.title ? s.title + ': ' : '') + (para[0] || '');
      }
      return fallback || "I don't know that one. Try asking another way.";
    },
  };
}

export function openaiBrain(p, { fetchFn = globalThis.fetch, env = process.env } = {}) {
  if (!p.base_url) throw new Error('brain.base_url: the server, such as https://api.openai.com/v1 or http://127.0.0.1:11434/v1.');
  if (!p.model) throw new Error('brain.model: the model name.');
  const key = resolveKey(p, env);
  const url = p.base_url.replace(/\/+$/, '') + '/chat/completions';
  return {
    name: 'openai',
    async reply({ system, history = [], text, signal }) {
      const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: text }];
      const r = await fetchFn(url, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
        body: JSON.stringify({ model: p.model, messages, max_tokens: p.max_tokens || 200, temperature: p.temperature ?? 0.4 }),
      });
      if (!r.ok) throw new Error(`brain HTTP ${r.status}`);
      const d = await r.json();
      return String(d?.choices?.[0]?.message?.content || '').trim();
    },
  };
}

export function makeBrain(c, opts = {}) {
  if (c.brain.provider === 'fixed') return fixedBrain({ ...opts, name: c.name, fallback: c.brain.fallback });
  if (c.brain.provider === 'openai') return openaiBrain(c.brain, opts);
  throw new Error(`brain.provider "${c.brain.provider}": use fixed or openai (Ollama, OpenRouter, Groq and llama.cpp speak openai).`);
}

// Cut at the last sentence end inside max (or a word end), so a long answer still reads whole.
export function clip(s, max) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (end > max * 0.4) return cut.slice(0, end + 1);
  return cut.replace(/\s+\S*$/, '') + '…';
}

const ASKS_PERSONAL = /\b(e-?mail|phone( number)?|home address|street address|date of birth|password|credit card|social security|passport)\b/i;
const LINK = /\bhttps?:\/\/([^\s/)]+)[^\s)]*/gi;

// The output filter: never asks for personal data, and keeps only links on allowed hosts.
export function filterReply(s, { allowedHosts = [] } = {}) {
  let out = String(s || '');
  out = out.replace(LINK, (m, host) => { host = host.replace(/[.,;:!?]+$/, '').toLowerCase(); return allowedHosts.some((h) => host === h || host.endsWith('.' + h)) ? m : ''; });
  if (ASKS_PERSONAL.test(out) && /\?/.test(out) && /\b(your|share|send|tell me|give me)\b/i.test(out)) return "I can't help with personal details. I never collect them.";
  return out.replace(/\s{2,}/g, ' ').trim();
}

export function guarded(brain, c, { now = Date.now } = {}) {
  const L = c.limits;
  const stamps = []; const lastBy = new Map();
  return {
    name: brain.name,
    // null: the limits say no reply now (the caller stays quiet)
    async reply(req) {
      const t = now();
      while (stamps.length && t - stamps[0] > 60000) stamps.shift();
      if (L.replies_per_min && stamps.length >= L.replies_per_min) return null;
      const who = String(req.fromId || req.from || '');
      if (L.per_person_s && who && t - (lastBy.get(who) || -1e12) < L.per_person_s * 1000) return null;
      stamps.push(t); if (who) lastBy.set(who, t);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), (L.reply_timeout_s || 25) * 1000);
      try {
        const raw = await brain.reply({ ...req, text: String(req.text || '').slice(0, 1000), signal: ctl.signal });
        const out = clip(filterReply(raw, { allowedHosts: c.prompt.allowed_hosts || [] }), L.max_reply_chars);
        return out || null;
      } catch (e) {
        return c.brain.fallback || "Sorry, I can't answer right now.";
      } finally { clearTimeout(timer); }
    },
  };
}

// The system prompt: the config's prompt, its guardrails, and the knowledge text.
export function systemPrompt(c, knowledgeText = '') {
  const g = (c.prompt.guardrails || []).map((x) => '- ' + x).join('\n');
  return [c.prompt.system.replace(/\{name\}/g, c.name), g && 'Rules:\n' + g,
    `Answer in at most ${c.limits.max_reply_chars} characters, plain text, no Markdown.`,
    knowledgeText && 'What you know (answer only from this; if it is not here, say you do not know):\n' + knowledgeText].filter(Boolean).join('\n\n');
}
