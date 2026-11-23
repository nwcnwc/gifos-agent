// fixedBrain, openaiBrain, guarded, filterReply, systemPrompt, makeBrain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixedBrain, openaiBrain, guarded, filterReply, systemPrompt, makeBrain } from '../../kit/brain.js';
import { Knowledge } from '../../kit/knowledge.js';

const md = '# Hours\nThe hall opens at nine.\n\n# Parking\nThe parking lot is behind the hall.\n';

async function miaBrain() {
  const knowledge = new Knowledge(['https://example.com/guide.md'], {
    fetchFn: async () => ({ ok: true, text: async () => md }),
  });
  await knowledge.refresh();
  return fixedBrain({ knowledge, name: 'Mia' });
}

function limits(over = {}) {
  return { replies_per_min: 10, per_person_s: 0, max_reply_chars: 400, reply_timeout_s: 5, ...over };
}

function wrap(reply, extra = {}, now) {
  return guarded(
    { name: 'fake', reply },
    { limits: limits(extra.limits), brain: extra.brain || {}, prompt: extra.prompt || {} },
    now ? { now } : {},
  );
}

test('fixedBrain hello reply mentions the name', async () => {
  const b = await miaBrain();
  assert.match(await b.reply({ text: 'hello' }), /Mia/);
  assert.match(await b.reply({ text: 'Hi Mia' }), /Mia/);
});

test('fixedBrain answers a question from the best section, with the title as a prefix', async () => {
  const b = await miaBrain();
  assert.equal(await b.reply({ text: 'Where is the parking lot?' }), 'Parking: The parking lot is behind the hall.');
});

test('fixedBrain falls back when nothing matches', async () => {
  const b = await miaBrain();
  assert.equal(await b.reply({ text: 'zigzag widgets' }), "I don't know that one. Try asking another way.");
});

test('openaiBrain posts to /chat/completions with the key, model, system, history and user text', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, headers: { ...opts.headers }, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ choices: [{ message: { content: '  hello  ' } }] }) };
  };
  const history = [
    { role: 'user', content: 'earlier' },
    { role: 'assistant', content: 'answer' },
  ];
  for (const base of ['https://example.com/v1', 'https://example.com/v1/']) {
    calls.length = 0;
    const b = openaiBrain(
      { base_url: base, model: 'demo-model', key_env: 'BOT_TEST_KEY' },
      { fetchFn, env: { BOT_TEST_KEY: 'K' } },
    );
    assert.equal(await b.reply({ system: 'sys', history, text: 'now' }), 'hello');
    assert.equal(calls[0].url, 'https://example.com/v1/chat/completions');
    assert.equal(calls[0].headers.authorization || calls[0].headers.Authorization, 'Bearer K');
    assert.equal(calls[0].body.model, 'demo-model');
    assert.deepEqual(calls[0].body.messages, [
      { role: 'system', content: 'sys' },
      ...history,
      { role: 'user', content: 'now' },
    ]);
  }
});

test('openaiBrain sends no Authorization header when no key is configured', async () => {
  let headers;
  const fetchFn = async (url, opts) => {
    headers = { ...opts.headers };
    assert.equal(url, 'https://example.com/v1/chat/completions');
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  const b = openaiBrain({ base_url: 'https://example.com/v1', model: 'demo-model' }, { fetchFn, env: {} });
  await b.reply({ system: 'sys', text: 'now' });
  assert.equal(headers.authorization, undefined);
  assert.equal(headers.Authorization, undefined);
});

test('openaiBrain throws when base_url or model is missing', () => {
  assert.throws(() => openaiBrain({ model: 'demo-model' }), /base_url/);
  assert.throws(() => openaiBrain({ base_url: 'https://example.com/v1' }), /model/);
});

test('guarded enforces replies_per_min with the injected clock', async () => {
  let t = 1_000_000;
  const g = wrap(async () => 'ok', { limits: { replies_per_min: 2 } }, () => t);
  assert.equal(await g.reply({ text: 'a', fromId: 'p' }), 'ok');
  assert.equal(await g.reply({ text: 'b', fromId: 'p' }), 'ok');
  assert.equal(await g.reply({ text: 'c', fromId: 'p' }), null);
  t += 60_001;
  assert.equal(await g.reply({ text: 'd', fromId: 'p' }), 'ok');
});

test('guarded enforces the per-person cooldown', async () => {
  let t = 50_000;
  const g = wrap(async () => 'ok', { limits: { per_person_s: 8 } }, () => t);
  assert.equal(await g.reply({ text: '1', fromId: 'ann' }), 'ok');
  t += 7999;
  assert.equal(await g.reply({ text: '2', fromId: 'ann' }), null);
  assert.equal(await g.reply({ text: '3', fromId: 'ben' }), 'ok');
  t += 1;
  assert.equal(await g.reply({ text: '4', fromId: 'ann' }), 'ok');
});

test('guarded clips to max_reply_chars at a sentence end', async () => {
  const sentence = 'This answer stays whole and clear.';
  const raw = sentence + ' ' + 'word '.repeat(30);
  const max = 80;
  assert.ok(raw.length > max);
  assert.ok(sentence.length > max * 0.4);
  const g = wrap(async () => raw, { limits: { max_reply_chars: max } });
  assert.equal(await g.reply({ text: 'hi', fromId: 'p' }), sentence);
});

test('filterReply drops links that are not allowed and keeps allowed hosts, including subdomains', () => {
  assert.equal(
    filterReply('See https://evil.com/x and https://docs.example.com/a and https://example.com/b', { allowedHosts: ['example.com'] }),
    'See and https://docs.example.com/a and https://example.com/b',
  );
});

test('filterReply keeps a sentence-final allowed link', () => {
  const out = filterReply('Read https://example.com.', { allowedHosts: ['example.com'] });
  assert.match(out, /https:\/\/example\.com/);
});

test('filterReply refuses a reply that asks for an email or a phone', () => {
  const line = "I can't help with personal details. I never collect them.";
  assert.equal(filterReply('What is your email?'), line);
  assert.equal(filterReply('Can you send your phone number?'), line);
});

test('guarded applies the link filter and the personal-data refusal', async () => {
  const links = wrap(async () => 'See https://evil.com/x and https://docs.example.com/a', {
    prompt: { allowed_hosts: ['example.com'] },
  });
  const out = await links.reply({ text: 'hi', fromId: 'p' });
  assert.equal(out, 'See and https://docs.example.com/a');
  const personal = wrap(async () => 'What is your email?');
  assert.equal(await personal.reply({ text: 'hi', fromId: 'p' }), "I can't help with personal details. I never collect them.");
});

test('guarded turns a brain throw into the fallback line', async () => {
  const g = wrap(async () => { throw new Error('boom'); }, { brain: { fallback: 'Later.' } });
  assert.equal(await g.reply({ text: 'hi', fromId: 'p' }), 'Later.');
});

test('guarded aborts a slow brain at reply_timeout_s', async () => {
  let aborted = false;
  const g = wrap(({ signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('late'), 1500);
    signal.addEventListener('abort', () => {
      aborted = true;
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  }), { limits: { reply_timeout_s: 0.05 }, brain: { fallback: 'Slow.' } });
  assert.equal(await g.reply({ text: 'hi', fromId: 'p' }), 'Slow.');
  assert.equal(aborted, true);
});

test('systemPrompt contains the guardrails, the character limit and the knowledge', () => {
  const text = systemPrompt({
    name: 'Mia',
    prompt: { system: 'You are {name}.', guardrails: ['Never ask for personal data', 'Stay on topic'] },
    limits: { max_reply_chars: 400 },
  }, 'The room opens at nine.');
  assert.match(text, /Never ask for personal data/);
  assert.match(text, /Stay on topic/);
  assert.match(text, /400/);
  assert.match(text, /The room opens at nine/);
});

test('makeBrain throws for an unknown provider', () => {
  assert.throws(() => makeBrain({ name: 'Mia', brain: { provider: 'wizard' } }), /wizard/);
});
