// The core's own process (docs/core-trust.md). The SDK starts it under Node's permission model (no file writes, no
// child processes, no workers, no addons; file reads only of this package's dependency folder), with an empty
// environment and no stdin/stdout of the parent. It is handed the core's files AFTER the SDK checked GifOS's signature
// and every file's hash, runs the site's Node host from them (nothing is fetched for running here), and carries the
// gifosAgent contract over the IPC channel as plain JSON:
//   parent -> child  { t: 'start', url, files: { path: text }, cfg, storage }   { t: 'call', id, name, args }   { t: 'close' }
//   child -> parent  { t: 'ready' }  { t: 'ev', type, data }  { t: 'reply', id, r }  { t: 'store', k, v }  { t: 'log', a }
//                    { t: 'fail', error }  { t: 'closed' }
'use strict';
const vm = require('vm');

const send = (m) => { try { if (process.connected) process.send(m); } catch (e) {} };
const plain = (x) => { try { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); } catch (e) { return undefined; } };

// The host may load these modules only: vm (the participant's own context), crypto (WebCrypto: the core's keys and
// signatures) and os (the CPU count a page reports as navigator.hardwareConcurrency). It reads no files for a site on
// the web, and a module it is not given throws by name.
const ALLOWED = { vm: 1, crypto: 1, os: 1 };
function hostRequire(id) {
  const m = String(id).replace(/^node:/, '');
  if (ALLOWED[m]) return require(m);
  throw new Error('The GifOS core host may not load ' + id + '.');
}

// Signals: Node's permission model does not cover them, so the core gets no way to signal another process.
process.kill = () => { throw new Error('The GifOS core may not signal processes.'); };
try { process._kill = undefined; } catch (e) {}

let m = null, closed = false;

async function start(msg) {
  const files = msg.files || {};
  const cfg = msg.cfg || {};
  const text = (rel) => { if (!Object.prototype.hasOwnProperty.call(files, rel)) throw new Error('The GifOS core asked for ' + rel + ', which GifOS did not sign.'); return files[rel]; };
  const mod = { exports: {} };
  vm.runInThisContext('(function (exports, require, module, __filename, __dirname) {' + text('js/core/node.js') + '\n})', { filename: 'js/core/node.js' })(mod.exports, hostRequire, mod, 'js/core/node.js', undefined);
  const host = mod.exports;
  // the host's site loader reads the signed files only: a path GifOS did not sign answers 404
  const fetchSigned = async (url) => {
    const rel = new URL(url).pathname.replace(/^\/+/, '');
    if (!Object.prototype.hasOwnProperty.call(files, rel)) return new Response('not signed', { status: 404 });
    return new Response(files[rel], { status: 200 });
  };
  const site = await host.loadSite(msg.origin, { fetch: fetchSigned });
  const storage = Object.assign({}, msg.storage || {});
  const backing = new Proxy(storage, {
    set(t, k, v) { t[k] = v; send({ t: 'store', k: String(k), v: String(v) }); return true; },
    deleteProperty(t, k) { delete t[k]; send({ t: 'store', k: String(k), v: null }); return true; },
  });
  const webrtc = cfg.noWebrtc ? undefined : require(String(cfg.werift));   // the resolved file (the only folder this process may read)
  m = host.createMeeting({
    url: msg.url, site, webrtc, storage: backing, session: cfg.session || {},
    media: webrtc && cfg.opus && site.files && site.files.nodeMedia ? { Opus: require(String(cfg.opus)) } : undefined,   // the Node media plane (a core that has one): voice and ears
    log: cfg.log ? (lvl, ...a) => send({ t: 'log', a: [String(lvl)].concat(a.map((x) => String((x && x.stack) || x).slice(0, 2000))) }) : undefined,
  });
  let hooked = false;
  const hook = () => {
    const a = m.agent();
    if (!a || hooked) return !!a;
    hooked = true;
    a.on('*', (ev) => {
      let d = ev.data;
      if (d && typeof d === 'object' && (d.samples || d.track || d.onFrame)) { d = Object.assign({}, d); delete d.samples; delete d.track; delete d.onFrame; }
      send({ t: 'ev', type: String(ev.type), data: plain(d) });
    });
    return true;
  };
  const tick = setInterval(() => { if (hook() && m.agent().version >= 1) { clearInterval(tick); send({ t: 'ready' }); } }, 100);
}

async function call(msg) {
  if (closed || !m) return send({ t: 'reply', id: msg.id, r: { ok: false, error: 'This meeting is closed.' } });
  const a = m.agent();
  if (!a) return send({ t: 'reply', id: msg.id, r: { ok: false, error: 'The meeting has no agent API yet.' } });
  let r;
  try { r = await a.call(String(msg.name), msg.args || {}); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  if (r && typeof r === 'object') { delete r.track; delete r.onFrame; }
  const p = plain(r);
  send({ t: 'reply', id: msg.id, r: p === undefined ? { ok: false, error: 'The meeting answered something that cannot be carried.' } : p });
}

async function close() {
  if (closed) return;
  closed = true;
  try { if (m) await m.close(); } catch (e) {}
  send({ t: 'closed' });
  setTimeout(() => process.exit(0), 50);
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'start') start(msg).catch((e) => { send({ t: 'log', a: ['error', 'start', String((e && e.stack) || e).slice(0, 2000)] }); send({ t: 'fail', error: String((e && e.message) || e) }); setTimeout(() => process.exit(1), 50); });
  else if (msg.t === 'call') call(msg);
  else if (msg.t === 'close') close();
});
process.on('disconnect', () => { close(); });
process.on('uncaughtException', (e) => { send({ t: 'log', a: ['error', 'uncaught', String((e && e.stack) || e).slice(0, 2000)] }); });
process.on('unhandledRejection', (e) => { send({ t: 'log', a: ['error', 'unhandled', String((e && e.stack) || e).slice(0, 2000)] }); });
