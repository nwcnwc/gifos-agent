// greetingText, namesMe, baseName, leads, shouldAnswer, and one runBot with a fake meeting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../../kit/config.js';
import { greetingText, namesMe, baseName, leads, shouldAnswer, runBot } from '../../kit/runner.js';

const link = 'https://example.com/meet/room';

function cfg(over = {}) {
  return normalizeConfig({ name: 'Mia', link, ...over });
}

test('greetingText joins 1, 2 and 3 names and fills {name}', () => {
  const c = { name: 'Mia', greet: { text: 'Hi {names}! I am {name}.' } };
  assert.equal(greetingText(c, ['A']), 'Hi A! I am Mia.');
  assert.equal(greetingText(c, ['A', 'B']), 'Hi A and B! I am Mia.');
  assert.equal(greetingText(c, ['A', 'B', 'C']), 'Hi A, B and C! I am Mia.');
});

test('namesMe matches the name on a word boundary', () => {
  const c = cfg();
  assert.equal(namesMe(c, 'Mia?'), true);
  assert.equal(namesMe(c, 'Miami'), false);
});

test('baseName strips a declaration suffix', () => {
  assert.equal(baseName('Mia (GifOS bot)'), 'Mia');
  assert.equal(baseName('Mia'), 'Mia');
});

test('leads is false only when a lower-ranked bot sibling is in the room', () => {
  const c = cfg({ rank: 2, siblings: { Leo: 1, Zoe: 3 } });
  assert.equal(leads(c, [{ name: 'Leo (GifOS bot)', bot: true }]), false);
  assert.equal(leads(c, [{ name: 'Leo (GifOS bot)', bot: false }]), true);
  assert.equal(leads(c, [{ name: 'Sam', bot: true }]), true);
  assert.equal(leads(c, []), true);
  assert.equal(leads(c, [{ name: 'Zoe (GifOS bot)', bot: true }]), true);
});

test('shouldAnswer ignores own, spoken, system and sibling lines, and caps bot lines', () => {
  const mention = cfg({ answer: 'mention', siblings: { Leo: 1 }, limits: { bot_turns: 2 } });
  const lead = { lead: true, botRun: 0 };
  assert.equal(shouldAnswer(mention, { mine: true, text: 'Mia?', kind: 'chat' }, lead), false);
  assert.equal(shouldAnswer(mention, { text: 'Mia?', kind: 'spoken' }, lead), false);
  assert.equal(shouldAnswer(mention, { text: 'Mia?', kind: 'system' }, lead), false);
  assert.equal(shouldAnswer(mention, { name: 'Leo (GifOS bot)', text: 'Mia?', kind: 'chat' }, lead), false);
  assert.equal(shouldAnswer(mention, { bot: true, text: 'Mia?', kind: 'chat' }, { lead: false, botRun: 2 }), false);
  assert.equal(shouldAnswer(mention, { bot: true, text: 'Mia?', kind: 'chat' }, { lead: false, botRun: 1 }), true);
  assert.equal(shouldAnswer(mention, { text: 'hello there', kind: 'chat' }, lead), false);
  assert.equal(shouldAnswer(mention, { text: 'Mia?', kind: 'chat' }, { lead: false, botRun: 0 }), true);

  const questions = cfg({ answer: 'questions', limits: { bot_turns: 2 } });
  assert.equal(shouldAnswer(questions, { text: 'what time is it?', kind: 'chat' }, { lead: true, botRun: 0 }), true);
  assert.equal(shouldAnswer(questions, { text: 'what time is it?', kind: 'chat' }, { lead: false, botRun: 0 }), false);
  assert.equal(shouldAnswer(questions, { text: 'what time is it', kind: 'chat' }, { lead: true, botRun: 0 }), false);
});

async function waitFor(pred, ms, label) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('timed out waiting for ' + label);
}

test('runBot greets a newcomer and answers a line that names it', { timeout: 9000 }, async () => {
  const c = cfg({
    brain: { provider: 'fixed' },
    voice: { provider: 'none' },
    avatar: { enabled: false },
    prompt: { knowledge: [] },
    limits: { greet_every_s: 0 },
  });
  const handlers = new Map();
  const chats = [];
  const says = [];
  let opened = 0;
  let left = false;
  const meet = {
    on(ev, fn) {
      const list = handlers.get(ev) || [];
      list.push(fn);
      handlers.set(ev, list);
      return () => {
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      };
    },
    emit(ev, data) {
      for (const fn of handlers.get(ev) || []) fn(data);
    },
    async state() {
      return { me: { id: 'me', name: 'Mia' }, people: [{ id: 'me', me: true, name: 'Mia' }] };
    },
    async chat(text) { chats.push(text); return { ok: true }; },
    async say(text) { says.push(text); return { stopped: false }; },
    async leave() { left = true; },
    video: { out: { async open() { opened += 1; return { write() {} }; } } },
  };

  let bot;
  try {
    bot = await runBot(c, {
      join: async () => meet,
      log() {},
      fetchFn() { throw new Error('network'); },
    });
    // A newcomer is greeted only after they have been in the room for more than 4s.
    meet.emit('people', [
      { id: 'me', me: true, name: 'Mia' },
      { id: 'sam', name: 'Sam' },
    ]);
    await waitFor(() => chats.some((t) => t.includes('Sam')), 8000, 'greeting');
    meet.emit('line', { id: 'sam', name: 'Sam', text: 'Mia, where should I sit?', kind: 'chat' });
    await waitFor(() => chats.length >= 2, 2000, 'reply');
    assert.equal(chats.length, 2);
    assert.equal(chats[0], 'Hi Sam! I am Mia, a bot. Ask me anything about this meeting.');
    assert.equal(chats[1], "I don't know that one. Try asking another way.");
    assert.equal(says.length, 0);
    assert.equal(opened, 0);
  } finally {
    if (bot) await bot.stop();
  }
  assert.equal(left, true);
});
