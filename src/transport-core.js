// The core transport: the meeting with no browser. It carries the same gifosAgent contract as the Playwright
// transport, from a meeting participant running in a process of its own (docs/core-trust.md).
//
// The GifOS core (the meeting's logic: relay protocol, proof of work, keys, mesh, room rules, the agent contract) is
// not part of this package. It is loaded from the meeting's own site, the way a browser loads the meeting page, so the
// agent runs the build the meeting runs. A meeting link is untrusted, so:
//   1. only a core SIGNED by GifOS runs: the signed file list (js/core/core.sig.json) is checked against the key
//      pinned in core-trust.js, and every file against its hash, before anything runs;
//   2. it runs in a child process under Node's permission model (no file writes, no child processes, no workers, no
//      addons, file reads of this package's dependency folder only), with an empty environment and no access to this
//      process's stdin or stdout. The agent's profile is written here, from the child's storage changes.
// Peer links use real WebRTC (werift, loaded in the child): data channels for chat, lines, people, hands, stage, apps
// and the rest of the contract, and media through the core's Node media plane (the site's js/core/media/plane-node.js):
// say() and audio.out speak on the seat's voice track, audio.in hears the room, encoded with Opus by the opusscript
// package (WebAssembly, so the child still loads no native addon).
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fetchSignedCore } from './core-trust.js';
import { CORE_MODE, CORE_MODE_OFF } from './flags.js';

const require = createRequire(import.meta.url);
const CHILD = fileURLToPath(new URL('./core-child.cjs', import.meta.url));

// The folder the child may read: the node_modules root werift resolves from (its dependencies sit beside it).
function werift() {
  let main; try { main = fs.realpathSync(require.resolve('werift')); } catch (e) { throw new Error('Core mode needs the werift package (npm install werift).'); }
  let d = path.dirname(main);
  while (path.basename(d) !== 'node_modules' && path.dirname(d) !== d) d = path.dirname(d);
  if (path.basename(d) !== 'node_modules') throw new Error('Core mode needs the werift package in a node_modules folder.');
  return { main, root: d };
}

// The Opus codec the child's media plane encodes and decodes with (WebAssembly): its file and its own package folder
// (opusscript has no dependencies, so the child may read that folder and nothing beside it).
function opus() {
  let pkg; try { pkg = fs.realpathSync(require.resolve('opusscript/package.json')); } catch (e) { throw new Error('Core mode needs the opusscript package (npm install opusscript).'); }
  const root = path.dirname(pkg);
  return { main: fs.realpathSync(require.resolve('opusscript')), root };
}

// The agent's localStorage, kept in its profile folder: its person key lives there, so it is the same person across joins.
const MAX_KEYS = 512, MAX_VALUE = 256 * 1024;
function profileStore(dir) {
  const file = dir ? path.join(dir, 'core-storage.json') : null;
  let data = {};
  if (file) { try { data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { data = {}; } }
  let timer = null;
  const save = () => { timer = null; if (!file) return; try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(data)); fs.renameSync(file + '.tmp', file); } catch (e) {} };
  const soon = () => { if (!timer && file) { timer = setTimeout(save, 200); if (timer.unref) timer.unref(); } };
  return {
    data,
    // a change the child reports: a bounded string key and value, written only to this agent's own profile file
    apply(k, v) {
      if (typeof k !== 'string' || k.length > 200) return;
      if (v === null) { delete data[k]; soon(); return; }
      if (typeof v !== 'string' || v.length > MAX_VALUE) return;
      if (!(k in data) && Object.keys(data).length >= MAX_KEYS) return;
      data[k] = v; soon();
    },
    set(k, v) { data[k] = v; soon(); },
    flush: () => { if (timer) { clearTimeout(timer); save(); } },
  };
}

// coreTransport(url, cfg): cfg = { name, relay?, room?, password?, profile?, coreKeys?, fetch?, log? }
// coreKeys: public keys (base64) to trust in place of GifOS's pinned key, for a core you built and signed yourself.
// It is the operator's choice, never something a meeting link can set.
export async function coreTransport(url, cfg = {}) {
  if (!CORE_MODE) throw new Error(CORE_MODE_OFF);   // src/flags.js
  if (+process.versions.node.split('.')[0] < 22) throw new Error('Joining with { core: true } needs Node 22 or later (this is Node ' + process.versions.node + ').');
  const origin = new URL(url).origin;
  const core = await fetchSignedCore(origin, { fetch: cfg.fetch, keys: cfg.coreKeys });
  const store = profileStore(cfg.profile);
  // what the Playwright transport's start script sets in the page's storage
  if (cfg.name) { store.set('gifos_name', cfg.name); store.set('gifos_meet_bar', '0'); }
  if (cfg.relay) store.set('gifos_relay', cfg.relay);
  if (cfg.room && cfg.password) store.set('gifos_vpw_' + cfg.room, cfg.password);
  const session = cfg.name ? { gifos_appear_ok: '1' } : {};

  const wr = cfg.noWebrtc ? null : werift();
  const op = wr ? opus() : null;   // media rides the peer links: no WebRTC, no media
  const child = fork(CHILD, [], {
    execArgv: ['--permission', '--allow-fs-read=' + CHILD].concat(wr ? ['--allow-fs-read=' + wr.root] : [], op && !(wr && op.root.startsWith(wr.root + path.sep)) ? ['--allow-fs-read=' + op.root] : [], ['--max-old-space-size=1024']),
    env: {}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json',
  });
  const childLog = (d) => { if (cfg.log) cfg.log('child', String(d).slice(0, 4000)); };
  child.stdout.on('data', childLog);
  child.stderr.on('data', childLog);

  let onEv = null, readyAt = 0, failed = '', closed = false, exited = false;
  const early = [], waiting = new Map(), readyWait = new Set();
  let nextId = 0;
  const push = (ev) => { if (onEv) onEv(ev); else early.push(ev); };
  const settleAll = (why) => { for (const res of waiting.values()) res({ ok: false, error: why }); waiting.clear(); for (const f of readyWait) f(); readyWait.clear(); };
  child.on('message', (msg) => {
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    if (msg.t === 'ev' && typeof msg.type === 'string') push({ type: msg.type, data: msg.data });
    else if (msg.t === 'reply') { const res = waiting.get(msg.id); if (res) { waiting.delete(msg.id); res(msg.r && typeof msg.r === 'object' ? msg.r : { ok: false, error: 'The meeting answered something that cannot be carried.' }); } }
    else if (msg.t === 'store') store.apply(msg.k, msg.v);
    else if (msg.t === 'ready') { readyAt = Date.now(); for (const f of readyWait) f(); readyWait.clear(); }
    else if (msg.t === 'fail') { failed = String(msg.error || 'The meeting core stopped.').slice(0, 500); settleAll(failed); }
    else if (msg.t === 'log' && Array.isArray(msg.a) && cfg.log) cfg.log(...msg.a.map((x) => String(x)));
  });
  child.on('exit', () => {
    exited = true;
    store.flush();
    settleAll('The meeting core stopped.');
    if (!closed) { closed = true; push({ type: 'left', data: { reason: 'manual', why: failed ? 'core-failed' : 'core-exited' } }); }
  });
  child.send({ t: 'start', url, origin: core.origin, files: core.texts, storage: store.data, cfg: { session, log: !!cfg.log, noWebrtc: !wr, werift: wr ? wr.main : null, opus: op ? op.main : null } });

  return {
    kind: 'core',
    build: core.build,
    pid: child.pid,
    onEvent(fn) { onEv = fn; for (const ev of early.splice(0)) fn(ev); },
    async hookNow() {},
    async ready(ms) {
      const lim = ms || 60000;
      if (!readyAt && !failed && !exited) await new Promise((res) => { const t = setTimeout(res, lim); readyWait.add(() => { clearTimeout(t); res(); }); });
      if (readyAt) return;
      throw new Error(failed || 'The meeting core did not start its agent API in ' + Math.round(lim / 1000) + ' s.');
    },
    call(name, args) {
      if (closed || exited) return Promise.resolve({ ok: false, error: 'This meeting is closed.' });
      const id = ++nextId;
      return new Promise((res) => { waiting.set(id, res); child.send({ t: 'call', id, name: String(name), args: args || {} }); });
    },
    async close() {
      if (closed) return;
      closed = true;
      if (!exited) {
        await new Promise((res) => {
          child.once('exit', res);
          // the goodbye first; then the channel closes, which ends the child once its farewell has left
          try { child.send({ t: 'close' }, () => { try { child.disconnect(); } catch (e) {} }); } catch (e) { res(); }
        });
      }
      store.flush();
      push({ type: 'left', data: { reason: 'manual', why: 'closed' } });
    },
  };
}
