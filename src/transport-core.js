// The core transport: the meeting with no browser. It carries the same gifosAgent contract as the Playwright
// transport, from a meeting participant running in this Node process.
//
// The GifOS core (the meeting's logic: relay protocol, proof of work, keys, mesh, room rules, the agent contract) is
// not part of this package. It is loaded from the meeting's own site, the way a browser loads the meeting page:
// <origin>/js/core/node.js (the Node host) and the core scripts it lists. So the agent always runs the build the
// meeting runs, and the page keeps every room rule. Peer links use real WebRTC data channels (werift).
//
// Data only for now: chat, lines, people, hands, stage, apps and the rest of the contract; say() and the audio and
// video ports answer that this seat has no media.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire, builtinModules } from 'node:module';

const require = createRequire(import.meta.url);
const hosts = new Map();

// The site's Node host as a module. It may load Node's built-in modules only.
async function loadHost(origin, fetchFn) {
  if (hosts.has(origin)) return hosts.get(origin);
  const at = new URL('/js/core/node.js', origin).href;
  const r = await fetchFn(at, { cache: 'no-store' });
  if (!r.ok) throw new Error('This site has no GifOS core for agents (' + at + ' answered ' + r.status + '). Join without { core: true }.');
  const text = await r.text();
  const mod = { exports: {} };
  const builtinOnly = (id) => {
    const m = String(id).replace(/^node:/, '');
    if (builtinModules.includes(m)) return require(m);
    throw new Error('The GifOS core host may load Node built-in modules only, not ' + id + '.');
  };
  vm.runInThisContext('(function (exports, require, module, __filename, __dirname) {' + text + '\n})', { filename: at })(mod.exports, builtinOnly, mod, at, undefined);
  const host = mod.exports;
  const site = await host.loadSite(origin, { fetch: fetchFn });
  const h = { host, site };
  hosts.set(origin, h);
  return h;
}

// The agent's localStorage, kept in its profile folder: its person key lives there, so it is the same person across joins.
function profileStore(dir) {
  const file = dir ? path.join(dir, 'core-storage.json') : null;
  let data = {};
  if (file) { try { data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { data = {}; } }
  let timer = null;
  const save = () => { timer = null; if (!file) return; try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(data)); fs.renameSync(file + '.tmp', file); } catch (e) {} };
  const soon = () => { if (!timer && file) { timer = setTimeout(save, 200); if (timer.unref) timer.unref(); } };
  const backing = new Proxy(data, {
    set(t, k, v) { t[k] = v; soon(); return true; },
    deleteProperty(t, k) { delete t[k]; soon(); return true; },
  });
  return { backing, flush: () => { if (timer) { clearTimeout(timer); save(); } } };
}

// coreTransport(url, cfg): cfg = { name, relay?, room?, password?, profile?, webrtc?, fetch?, log? }
export async function coreTransport(url, cfg = {}) {
  const fetchFn = cfg.fetch || globalThis.fetch;
  const origin = new URL(url).origin;
  const { host, site } = await loadHost(origin, fetchFn);
  const webrtc = cfg.webrtc || require('werift');
  const store = profileStore(cfg.profile);
  // what the Playwright transport's start script sets in the page's storage
  if (cfg.name) { store.backing.gifos_name = cfg.name; store.backing.gifos_meet_bar = '0'; }
  if (cfg.relay) store.backing.gifos_relay = cfg.relay;
  if (cfg.room && cfg.password) store.backing['gifos_vpw_' + cfg.room] = cfg.password;
  const session = cfg.name ? { gifos_appear_ok: '1' } : {};

  let onEv = null;
  const early = [];
  const push = (ev) => { if (onEv) onEv(ev); else early.push(ev); };
  const m = host.createMeeting({
    url, site, webrtc, storage: store.backing, session,
    log: (lvl, ...a) => { if (cfg.log) cfg.log(lvl, ...a); },
  });
  let closed = false, hooked = false;
  const hook = () => {
    const a = m.agent();
    if (!a || hooked) return !!a;
    hooked = true;
    a.on('*', (ev) => {
      let d = ev.data;
      if (d && typeof d === 'object' && (d.samples || d.track || d.onFrame)) { d = Object.assign({}, d); delete d.samples; delete d.track; delete d.onFrame; }
      let copy; try { copy = d === undefined ? undefined : JSON.parse(JSON.stringify(d)); } catch (e) { copy = undefined; }
      push({ type: ev.type, data: copy });
    });
    return true;
  };
  hook();

  return {
    kind: 'core',
    meeting: m,
    onEvent(fn) { onEv = fn; for (const ev of early.splice(0)) fn(ev); },
    async hookNow() { hook(); },
    async ready(ms) {
      const end = Date.now() + (ms || 60000);
      for (;;) {
        if (hook() && m.agent().version >= 1) return;
        if (Date.now() > end) throw new Error('The meeting core did not start its agent API in ' + Math.round((ms || 60000) / 1000) + ' s.');
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    async call(name, args) {
      if (closed) return { ok: false, error: 'This meeting is closed.' };
      const a = m.agent();
      if (!a) return { ok: false, error: 'The meeting has no agent API yet.' };
      const r = await a.call(name, args);
      if (r && typeof r === 'object') { delete r.track; delete r.onFrame; }
      try { return JSON.parse(JSON.stringify(r)); } catch (e) { return { ok: false, error: 'The meeting answered something that cannot be carried.' }; }
    },
    async close() {
      if (closed) return;
      closed = true;
      await m.close();
      store.flush();
      push({ type: 'left', data: { reason: 'manual', why: 'closed' } });
    },
  };
}
