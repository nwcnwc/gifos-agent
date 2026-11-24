// The core transport over a fake site: the host comes from <origin>/js/core/node.js and carries the contract.
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

// A stand-in for the site's Node host: one participant whose agent answers state/chat and emits events.
const HOST = `
let made = null;
module.exports = {
  async loadSite(origin, o) { const r = await o.fetch(origin + '/js/core/files.json'); return { id: 'fake', files: await r.json() }; },
  createMeeting(opts) {
    const handlers = new Set();
    opts.storage.gifos_room_seed = opts.storage.gifos_room_seed || 'seed-1';
    const agent = {
      version: 1,
      on(t, f) { handlers.add(f); },
      async call(name, args) {
        if (name === 'state') return { ok: true, state: { joined: true, me: { name: opts.storage.gifos_name } } };
        if (name === 'chat') { for (const f of handlers) f({ type: 'line', data: { kind: 'chat', text: args.text, final: true, toMe: true, trust: 'own' } }); return { ok: true, id: 'm1' }; }
        if (name === 'leave') return { ok: true };
        return { ok: false, error: 'No such action: ' + name + '.' };
      },
    };
    made = { url: opts.url, session: opts.session, closed: false };
    module.exports.made = made;
    return { agent: () => agent, async close() { made.closed = true; } };
  },
};`;

function fakeFetch(files) {
  return async (url) => {
    const p = new URL(url).pathname;
    if (!(p in files)) return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, text: async () => files[p], arrayBuffer: async () => new TextEncoder().encode(files[p]).buffer };
  };
}
const KEY = testKey();

test('core transport: host from the site, contract carried, profile kept', gate, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-agent-core-'));
  const fetch = fakeFetch(signSite({ 'js/core/node.js': HOST, 'js/core/files.json': '{"core":[]}' }, KEY));
  const t = await coreTransport('https://example.test/run.html#v=abc&agent=1', { name: 'Ada (Sam’s assistant)', profile: dir, fetch, coreKeys: [KEY.pub], noWebrtc: true });
  const meet = new Meeting(t);
  await t.ready(1000);
  assert.equal((await meet.state()).me.name, 'Ada (Sam’s assistant)');
  const it = meet.lines({ toMe: true });
  await meet.chat('hello');
  assert.equal((await it.next()).value.text, 'hello');
  await assert.rejects(meet.call('nope'), /No such action/);
  await meet.leave();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'core-storage.json'), 'utf8'));
  assert.equal(saved.gifos_room_seed, 'seed-1', 'the person key is kept in the profile');
  assert.equal(saved.gifos_name, 'Ada (Sam’s assistant)');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('core transport: a site without the core says so', gate, async () => {
  const fetch = fakeFetch({});
  await assert.rejects(coreTransport('https://old.example.test/meet#room=abc', { name: 'A (B’s assistant)', fetch, coreKeys: [KEY.pub] }), /no GifOS core for agents/);
});
