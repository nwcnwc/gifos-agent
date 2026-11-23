// normalizeConfig, resolveKey, seatName, loadConfig.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig, resolveKey, seatName, loadConfig } from '../../kit/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const link = 'https://example.com/meet/room';

function cfg(over = {}) {
  return normalizeConfig({ name: 'Mia', link, ...over });
}

test('normalizeConfig fills defaults', () => {
  const c = cfg();
  assert.equal(c.name, 'Mia');
  assert.equal(c.owner, '');
  assert.equal(c.rank, 0);
  assert.equal(c.answer, 'mention');
  assert.equal(c.brain.provider, 'fixed');
  assert.equal(c.voice.provider, 'none');
  assert.equal(c.avatar.enabled, false);
  assert.equal(c.avatar.set, 'blob');
  assert.equal(c.avatar.fps, 6);
  assert.equal(c.greet.enabled, true);
  assert.match(c.prompt.system, /friendly meeting bot/);
  assert.deepEqual(c.prompt.knowledge, []);
  assert.equal(c.limits.replies_per_min, 6);
  assert.equal(c.limits.max_reply_chars, 400);
  assert.equal(c.limits.bot_turns, 2);
  assert.deepEqual(c.siblings, []);
  assert.deepEqual(c.sibling_ranks, {});
});

test('name must be one first name', () => {
  assert.equal(cfg({ name: 'Mia' }).name, 'Mia');
  assert.throws(() => cfg({ name: 'Mia Smith' }), /name/);
  assert.throws(() => cfg({ name: '' }), /name/);
  assert.throws(() => normalizeConfig({ link }), /name/);
});

test('link must be https, or http on localhost', () => {
  assert.equal(cfg({ link: 'https://gifos.app/meet/your-room' }).link, 'https://gifos.app/meet/your-room');
  assert.equal(cfg({ link: 'http://127.0.0.1/meet' }).link, 'http://127.0.0.1/meet');
  assert.equal(cfg({ link: 'http://127.0.0.1:8080/meet' }).link, 'http://127.0.0.1:8080/meet');
  assert.equal(cfg({ link: 'http://localhost/meet' }).link, 'http://localhost/meet');
  assert.equal(cfg({ link: 'http://localhost:8080/meet' }).link, 'http://localhost:8080/meet');
  assert.throws(() => cfg({ link: 'http://example.com/meet' }), /link/);
  assert.throws(() => normalizeConfig({ name: 'Mia' }), /link/);
});

test('inline secrets are refused; key_env and key_file are allowed', () => {
  assert.throws(() => cfg({ brain: { key: 'x' } }), /brain\.key/);
  assert.throws(() => cfg({ voice: { api_key: 'x' } }), /voice\.api_key/);
  assert.throws(() => cfg({ meta: { inner: { token: 'x' } } }), /token/);
  const c = cfg({
    brain: { provider: 'openai', key_env: 'BOT_TEST_KEY', base_url: 'https://example.com/v1', model: 'm' },
    voice: { provider: 'openai', key_file: 'keys/voice.key', base_url: 'https://example.com/v1' },
  });
  assert.equal(c.brain.key_env, 'BOT_TEST_KEY');
  assert.equal(c.voice.key_file, path.resolve(process.cwd(), 'keys/voice.key'));
});

test('siblings become a name list and a rank map, without our own name', () => {
  const c = cfg({ siblings: { Leo: 1, Mia: 4 } });
  assert.deepEqual(c.siblings, ['Leo']);
  assert.deepEqual(c.sibling_ranks, { Leo: 1 });
});

test('limits must be numbers >= 0', () => {
  assert.throws(() => cfg({ limits: { replies_per_min: -1 } }), /replies_per_min/);
  assert.throws(() => cfg({ limits: { per_person_s: 'nope' } }), /per_person_s/);
  const c = cfg({ limits: { greet_every_s: 0, max_say_chars: 12 } });
  assert.equal(c.limits.greet_every_s, 0);
  assert.equal(c.limits.max_say_chars, 12);
  assert.equal(c.limits.replies_per_min, 6);
});

test('max_reply_chars is clamped to 40..2000 and avatar fps to 1..15', () => {
  assert.equal(cfg({ limits: { max_reply_chars: 10 } }).limits.max_reply_chars, 40);
  assert.equal(cfg({ limits: { max_reply_chars: 400 } }).limits.max_reply_chars, 400);
  assert.equal(cfg({ limits: { max_reply_chars: 9000 } }).limits.max_reply_chars, 2000);
  assert.equal(cfg({ avatar: { fps: 0.25 } }).avatar.fps, 1);
  assert.equal(cfg({ avatar: { fps: 15 } }).avatar.fps, 15);
  assert.equal(cfg({ avatar: { fps: 99 } }).avatar.fps, 15);
});

test('answer must be mention or questions', () => {
  assert.equal(cfg().answer, 'mention');
  assert.equal(cfg({ answer: 'questions' }).answer, 'questions');
  assert.throws(() => cfg({ answer: 'all' }), /answer/);
});

test('resolveKey reads key_env from the env object and throws when it is missing', () => {
  assert.equal(resolveKey({ key_env: 'BOT_TEST_KEY', provider: 'openai' }, { BOT_TEST_KEY: ' K ' }), 'K');
  assert.throws(() => resolveKey({ key_env: 'BOT_TEST_KEY', provider: 'openai' }, {}), /BOT_TEST_KEY/);
});

test('resolveKey reads key_file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botkit-key-'));
  const file = path.join(dir, 'key');
  fs.writeFileSync(file, '  test-key \n');
  try {
    assert.equal(resolveKey({ key_file: file, provider: 'openai' }, {}), 'test-key');
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});

test('seatName with and without a declaration', () => {
  assert.equal(seatName({ name: 'Mia' }), 'Mia');
  assert.equal(seatName({ name: 'Mia', declaration: '' }), 'Mia');
  assert.equal(seatName({ name: 'Mia', declaration: 'GifOS bot' }), 'Mia (GifOS bot)');
});

test('loadConfig reads examples/bot-kit/echo.bot.json', () => {
  const c = loadConfig(path.join(root, 'examples/bot-kit/echo.bot.json'));
  assert.equal(c.name, 'Echo');
  assert.equal(c.link, 'https://gifos.app/meet/your-room');
  assert.equal(c.brain.provider, 'fixed');
  assert.equal(c.voice.provider, 'none');
  assert.equal(c.answer, 'mention');
  assert.equal(c.limits.replies_per_min, 6);
});
