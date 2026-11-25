// The Node media hand-over and the boxed VP8 thread (core-child.cjs nodeMedia(), sealThreads(); docs/core-trust.md
// "Threads"). Media rides only on WebRTC, so these tests never pass noWebrtc.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coreTransport, Meeting } from '../../src/index.js';
import { signSite, testKey } from './signed-site.js';
import { CORE_MODE } from '../../src/flags.js';

// Core mode is switched off in src/flags.js for now; these tests are skipped until it is on (see core.test.js).
const gate = { skip: !CORE_MODE && 'core mode is off (src/flags.js CORE_MODE)' };

const fakeFetch = (files) => async (url) => {
  const p = new URL(url).pathname;
  if (!(p in files)) return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
  return { ok: true, status: 200, text: async () => files[p], arrayBuffer: async () => new TextEncoder().encode(files[p]).buffer };
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-core-media-'));
const NAME = "A (B's assistant)";
const KEY = testKey();

// A boxed thread's own code: checks what it may and may not do, and tries to write fileInDir (must stay unwritten).
// module.register: Node's loader-hooks thread gets a fresh worker_threads; this hook starts an unconfined worker there
// (execArgv []) that writes fileInDir. Refused in the child and in a core thread, so the file never appears.
function registerTry(fileInDir) {
  const inner = 'require("fs").writeFileSync(' + JSON.stringify(fileInDir) + ', "x")';
  const hook = 'import wt from "node:worker_threads"; new wt.Worker(' + JSON.stringify(inner) + ', { eval: true, execArgv: [] }); export async function resolve(s, c, n) { return n(s); }';
  const url = 'data:text/javascript,' + encodeURIComponent(hook);
  return `try { process.getBuiltinModule('module').register(${JSON.stringify(url)}); out.registerRefused = false; } catch (e) { out.registerRefused = true; }`;
}

const threadCode = (fileInDir) => `
  const wt = require('worker_threads');
  const out = {};
  out.libavType = typeof require(wt.workerData.libav).LibAV;
  try { require('fs'); out.fsRefused = false; } catch (e) { out.fsRefused = true; }
  try { process.kill(process.pid, 0); out.killRefused = false; } catch (e) { out.killRefused = true; }
  try { new (require('worker_threads').Worker)('1', { eval: true }); out.nestedRefused = false; } catch (e) { out.nestedRefused = true; }
  try { process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(fileInDir)}, 'x'); out.writeCode = null; } catch (e) { out.writeCode = e.code; }
  ${registerTry(fileInDir + '-register')}
  wt.parentPort.postMessage(out);
`;

// A hostile main-thread worker: ignores its own execArgv request, writes execFile, then reports back.
const execArgvCode = (execFile) => `
  try { process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(execFile)}, 'x'); } catch (e) {}
  process.getBuiltinModule('worker_threads').parentPort.postMessage('done');
`;

// A fake js/core/node.js: createMeeting(opts) keeps opts.media; 'state' runs every attempt and returns the results
// (core-trust.test.js's attempt()/probe pattern, read back through agent.call('state')).
function HOST(dir) {
  const thread = threadCode(path.join(dir, 'thread-should-not-exist'));
  const execArgvFile = path.join(dir, 'execargv-should-not-exist');
  return `
let media;
module.exports = {
  async loadSite(origin, o) { const r = await o.fetch(origin + '/js/core/files.json'); return { files: JSON.parse(await r.text()) }; },
  createMeeting(opts) {
    media = opts.media;
    const agent = {
      version: 1, on() {},
      async call(name) {
        if (name === 'leave') return { ok: true };
        if (name !== 'state') return { ok: false, error: 'no such action: ' + name };
        const r = {};
        r.hasMedia = media !== undefined;
        if (media) {
          r.opusIsFn = typeof media.Opus === 'function';
          let n = null; try { n = media.opusNative && media.opusNative(); } catch (e) {}
          r.opusNativeOk = !!(n && typeof n.OpusScriptHandler === 'function');
          r.hasLibav = 'libav' in media;
          r.libavPathOk = typeof media.libav === 'string' && media.libav.endsWith('libav-vp8-opus.js');
          r.hasLibavModule = 'libavModule' in media;
          r.libavModuleOk = !!(media.libavModule && typeof media.libavModule.LibAV === 'function');
        }
        try { r.requireWorkerThreads = typeof require('worker_threads').Worker; } catch (e) { r.requireWorkerThreads = 'threw: ' + e.message; }
        const gbm = process.getBuiltinModule('worker_threads');

        // The VP8 encoder's own thread: starts only when the SDK armed it (media.libav set).
        if (media && media.libav) {
          r.thread = await new Promise((resolve) => {
            try {
              const w = new gbm.Worker(${JSON.stringify(thread)}, { eval: true, workerData: { libav: media.libav } });
              w.on('message', resolve);
              w.on('error', (e) => resolve({ error: String((e && e.message) || e) }));
            } catch (e) { resolve({ error: String((e && e.message) || e) }); }
          });
        } else {
          try { new gbm.Worker('1', { eval: true }); r.ctorRefused = false; }
          catch (e) { r.ctorRefused = true; r.ctorError = String((e && e.message) || e); r.ctorCode = e.code; }
        }

        // A hostile main thread: its own execArgv is ignored (the boxed worker never forwards it); wait for the
        // worker's own exit/error/message before checking the file.
        r.execArgvAttempt = await new Promise((resolve) => {
          try {
            const w = new gbm.Worker(${JSON.stringify(execArgvCode(execArgvFile))}, { eval: true, execArgv: [] });
            const done = (tag) => (x) => resolve({ tag, x: String((x && x.message) || x || '') });
            w.on('message', done('message')); w.on('error', done('error')); w.on('exit', done('exit'));
          } catch (e) { resolve({ tag: 'sync-throw', x: String((e && e.message) || e) }); }
        });

        // A non-eval Worker (a file path): refused regardless of armed state.
        try { new gbm.Worker('/tmp/not-eval-worker.js'); r.fileWorkerRefused = false; }
        catch (e) { r.fileWorkerRefused = true; r.fileWorkerError = String((e && e.message) || e); }

        // import('node:worker_threads') from inside the host: the host loads no code at run time (docs/core-trust.md),
        // so dynamic import is refused outright, not just for worker_threads.
        try {
          const ns = await (new Function('return import("node:worker_threads")'))();
          r.importNs = { ok: true, sameAsGbm: ns.Worker === gbm.Worker, defaultSame: ns.default.Worker === gbm.Worker };
        } catch (e) { r.importNs = { ok: false, error: String((e && e.message) || e) }; }

        { const out = {}; ${registerTry(path.join(dir, 'main-register-should-not-exist'))}; r.registerRefused = out.registerRefused; }
        await new Promise((res) => setTimeout(res, 300));   // an escaped hook would have written by now
        return { ok: true, state: r };
      },
    };
    return { agent: () => agent, async close() {} };
  },
};`;
}

// Starts the core over a site whose files.json is `nm` (a JSON-serializable object), returns the 'state' results.
async function run(nm, dir) {
  const filesJson = JSON.stringify(Object.assign({ core: [] }, nm ? { nodeMedia: nm } : {}));
  const files = signSite({ 'js/core/node.js': HOST(dir), 'js/core/files.json': filesJson }, KEY);
  const t = await coreTransport('https://example.test/run.html#v=abc', { name: NAME, fetch: fakeFetch(files), coreKeys: [KEY.pub] });
  await t.ready(15000);
  const meet = new Meeting(t);
  const r = await meet.state();
  await meet.leave();
  await t.close();
  return r;
}

test('a core with a Node video port gets Opus, opusNative, libav and libavModule, and the VP8 thread is boxed', gate, async () => {
  const dir = tmp();
  const r = await run({ host: 'x.js', plane: 'y.js', video: 'z.js' }, dir);
  assert.equal(r.opusIsFn, true);
  assert.equal(r.opusNativeOk, true, 'opusNative() has OpusScriptHandler');
  assert.equal(r.libavPathOk, true, "media.libav ends with 'libav-vp8-opus.js'");
  assert.equal(r.libavModuleOk, true, 'media.libavModule.LibAV is a function');
  assert.equal(r.requireWorkerThreads, 'function', "require('worker_threads').Worker is a function");
  assert.equal(r.thread.libavType, 'function', 'the thread itself can load LibAV');
  assert.equal(r.thread.fsRefused, true, "a thread's require('fs') is refused");
  assert.equal(r.thread.killRefused, true, "a thread's process.kill is refused");
  assert.equal(r.thread.nestedRefused, true, 'a thread may not start a nested thread');
  assert.equal(r.thread.registerRefused, true, 'a thread may not register module hooks');
  assert.equal(r.thread.writeCode, 'ERR_ACCESS_DENIED', 'a thread may not write files');
  assert.equal(fs.existsSync(path.join(dir, 'thread-should-not-exist')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a hostile main thread cannot write a file through the boxed Worker, eval or not', gate, async () => {
  const dir = tmp();
  const r = await run({ host: 'x.js', plane: 'y.js', video: 'z.js' }, dir);
  // (a) execArgv: [] is ignored (the boxed Worker never forwards it to the real one); permission still holds
  assert.notEqual(r.execArgvAttempt.tag, 'sync-throw', 'the boxed Worker took the eval code: ' + r.execArgvAttempt.x);
  assert.equal(fs.existsSync(path.join(dir, 'execargv-should-not-exist')), false, 'execArgv could not reopen file access');
  // (b) a non-eval Worker (a file path) is refused
  assert.equal(r.fileWorkerRefused, true);
  // (c) the host loads no code at run time: dynamic import() is refused outright (a stronger property than reaching
  // the boxed Worker by another path, so there is nothing to compare Worker identity against)
  assert.equal(r.importNs.ok, false, 'import() is refused in the host context');
  assert.match(r.importNs.error, /dynamic import/i);
  // (d) module.register (the loader-hooks thread has an unsealed worker_threads) is refused
  assert.equal(r.registerRefused, true, 'module.register is refused in the host context');
  assert.equal(fs.existsSync(path.join(dir, 'main-register-should-not-exist')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a core with no Node video port gets Opus but no libav, and starting any thread is refused', gate, async () => {
  const dir = tmp();
  const r = await run({ host: 'x.js', plane: 'y.js' }, dir);
  assert.equal(r.opusIsFn, true);
  assert.equal(r.opusNativeOk, true);
  assert.equal(r.hasLibav, false);
  assert.equal(r.hasLibavModule, false);
  assert.match(r.requireWorkerThreads, /may not load/, "require('worker_threads') throws");
  assert.equal(r.ctorRefused, true, 'constructing the boxed Worker is refused (not armed for a thread)');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a core with no nodeMedia gets no media at all', gate, async () => {
  const dir = tmp();
  const r = await run(null, dir);
  assert.equal(r.hasMedia, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
