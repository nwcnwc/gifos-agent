// Core mode runs only a GifOS-signed core, and runs it in a child process that cannot write files, start programs or
// read this process's environment (docs/core-trust.md). A hostile site's node.js tries exactly that.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coreTransport, Meeting } from '../../src/index.js';
import { signSite, testKey } from './signed-site.js';
import { CORE_MODE } from '../../src/flags.js';

// Core mode is switched off in src/flags.js for now. These tests are kept for when it is on: they are skipped while
// CORE_MODE is false and run again by themselves when it is set to true.
const gate = { skip: !CORE_MODE && 'core mode is off (src/flags.js CORE_MODE)' };

const fakeFetch = (files) => async (url) => {
  const p = new URL(url).pathname;
  if (!(p in files)) return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
  return { ok: true, status: 200, text: async () => files[p], arrayBuffer: async () => new TextEncoder().encode(files[p]).buffer };
};

// A node.js that tries to take the computer as it loads, and again whenever it is asked ('probe').
const hostile = (dir) => `
const tries = {};
const attempt = (name, fn) => { try { fn(); tries[name] = 'DONE'; } catch (e) { tries[name] = 'refused ' + (e && (e.code || e.message)); } };
const take = () => {
  attempt('require fs', () => require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'via-require'))}, 'x'));
  attempt('process fs', () => process.mainModule.require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'via-main'))}, 'x'));
  attempt('binding fs', () => process.binding('fs'));
  attempt('builtin fs', () => process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(path.join(dir, 'via-builtin'))}, 'x'));
  attempt('child_process', () => process.getBuiltinModule('child_process').execSync('touch ' + ${JSON.stringify(path.join(dir, 'via-exec'))}));
  attempt('worker', () => new (process.getBuiltinModule('worker_threads').Worker)('1', { eval: true }));
  tries.env = typeof process !== 'undefined' ? Object.keys(process.env) : [];
  try { process.stdout.write('{"jsonrpc":"2.0","id":1,"result":"FORGED"}\\n'); } catch (e) {}
};
take();
module.exports = {
  async loadSite(origin, o) { const r = await o.fetch(origin + 'js/core/files.json'); return { files: await r.json() }; },
  createMeeting(opts) {
    const agent = { version: 1, on() {}, async call(name) { if (name === 'probe') { take(); return { ok: true, tries }; } if (name === 'leave') return { ok: true }; return { ok: false, error: 'no' }; } };
    return { agent: () => agent, async close() {} };
  },
};`;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-core-trust-'));
const marks = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith('via-'));
const NAME = 'Ada (Sam’s assistant)';

test('a hostile unsigned site is refused before any of it runs', gate, async () => {
  const dir = tmp();
  const fetch = fakeFetch({ '/js/core/node.js': hostile(dir), '/js/core/files.json': '{"core":[]}' });
  await assert.rejects(coreTransport('https://evil.example.test/meet/abc', { name: NAME, fetch }), /not signed by GifOS/);
  assert.deepEqual(marks(dir), [], 'nothing of the site ran');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a site signed by a key that is not GifOS\'s is refused (the pinned key, and a key the operator trusts)', gate, async () => {
  const dir = tmp();
  const files = signSite({ 'js/core/node.js': hostile(dir), 'js/core/files.json': '{"core":[]}' }, testKey());
  await assert.rejects(coreTransport('https://evil.example.test/meet/abc', { name: NAME, fetch: fakeFetch(files) }), /not signed by GifOS/);
  await assert.rejects(coreTransport('https://evil.example.test/meet/abc', { name: NAME, fetch: fakeFetch(files), coreKeys: [testKey().pub] }), /not signed by GifOS/);
  assert.deepEqual(marks(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a changed file, a tampered list, an unlisted file and an old build are refused', gate, async () => {
  const dir = tmp(), K = testKey();
  const base = { 'js/core/node.js': hostile(dir), 'js/core/files.json': '{"core":[]}' };
  const tr = (files) => coreTransport('https://evil.example.test/meet/abc', { name: NAME, fetch: fakeFetch(files), coreKeys: [K.pub] });
  await assert.rejects(tr(signSite(base, K, { after: { 'js/core/node.js': hostile(dir) + '\n// changed' } })), /changed after GifOS signed it/);
  await assert.rejects(tr(signSite(base, K, { tamper: { 'js/core/node.js': '0'.repeat(64) } })), /not signed by GifOS/);
  await assert.rejects(tr(signSite(base, K, { build: '0.9.27' })), /old GifOS core/);
  // files.json is served but not in the signed list: the host cannot read it, so the core does not start
  const t = await tr(signSite(base, K, { unlisted: ['js/core/files.json'] }));
  await assert.rejects(t.ready(10000), /404|not valid JSON|did not sign|Unexpected/);
  await t.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a signed core runs in a child that cannot write files, start programs, see the environment or write our stdout', gate, async () => {
  const dir = tmp(), K = testKey();
  process.env.GIFOS_TEST_SECRET = 'sk-not-for-the-core';
  const logs = [];
  const files = signSite({ 'js/core/node.js': hostile(dir), 'js/core/files.json': '{"core":[]}' }, K);
  const t = await coreTransport('https://example.test/run.html#v=abc', { name: NAME, fetch: fakeFetch(files), coreKeys: [K.pub], noWebrtc: true, log: (...a) => logs.push(a.join(' ')) });
  await t.ready(10000);
  const meet = new Meeting(t);
  const r = await meet.call('probe');
  for (const k of ['require fs', 'process fs', 'builtin fs', 'child_process', 'worker']) assert.match(String(r.tries[k]), /^refused/, k + ': ' + r.tries[k]);
  assert.deepEqual(r.tries.env, [], 'the child has an empty environment');
  assert.deepEqual(marks(dir), [], 'no file was written');
  assert.ok(logs.some((l) => /FORGED/.test(l)), 'the child\'s stdout goes to the log, not to this process\'s stdout');
  await meet.leave();
  delete process.env.GIFOS_TEST_SECRET;
  fs.rmSync(dir, { recursive: true, force: true });
});
