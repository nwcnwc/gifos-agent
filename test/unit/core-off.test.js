// Core mode is switched off (src/flags.js): join(url, { core: true }), coreTransport and the stdio bridge's core option
// refuse with one sentence, and browser mode is unaffected. These tests skip themselves when CORE_MODE is turned on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, coreTransport } from '../../src/index.js';
import { CORE_MODE, CORE_MODE_OFF } from '../../src/flags.js';

const gate = { skip: CORE_MODE && 'core mode is on (src/flags.js CORE_MODE)' };
const SENTENCE = "Core mode (joining without a browser) isn't available yet; join without { core: true }.";
const NAME = "Ada (Sam's assistant)";

test('the refusal is one plain sentence', gate, () => {
  assert.equal(CORE_MODE_OFF, SENTENCE);
});

test('join(url, { core: true }) is refused with that sentence, before any browser or network', gate, async () => {
  const chromium = { executablePath: () => process.execPath, async launchPersistentContext() { throw new Error('a browser was launched'); } };
  await assert.rejects(join('https://gifos.app/meet/abc', { name: NAME, core: true, chromium, profile: '/nonexistent/agent-profile' }), (e) => e.message === SENTENCE);
  await assert.rejects(coreTransport('https://gifos.app/meet#room=abc', { name: NAME, fetch: async () => { throw new Error('fetched'); } }), (e) => e.message === SENTENCE);
});

test('browser mode is unaffected: core: false still drives the browser', gate, async () => {
  const seen = [];
  const chromium = { executablePath: () => process.execPath, async launchPersistentContext(dir) { seen.push(dir); throw new Error('no browser in this test'); } };
  await assert.rejects(join('https://gifos.app/meet/abc', { name: NAME, core: false, chromium, profile: '/nonexistent/agent-profile' }), (e) => e.message !== SENTENCE);
  assert.equal(seen[0], '/nonexistent/agent-profile');
});

test('the stdio bridge refuses a core join with the same sentence', gate, async () => {
  const bin = fileURLToPath(new URL('../../src/stdio.js', import.meta.url));
  const p = spawn(process.execPath, [bin], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  const answer = new Promise((resolve) => p.stdout.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) resolve(JSON.parse(buf.slice(0, i))); }));
  p.stdin.write(JSON.stringify({ id: 1, join: 'https://gifos.app/meet#room=abc', opts: { name: NAME, core: true } }) + '\n');
  const a = await answer;
  p.stdin.end();
  await new Promise((r) => p.on('exit', r));
  assert.deepEqual(a, { id: 1, ok: false, error: SENTENCE });
});
