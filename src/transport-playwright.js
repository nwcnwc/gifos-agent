// The Playwright (CDP) transport: it only carries the page's gifosAgent contract.
//   events: an init script subscribes to every gifosAgent event and hands it to a binding
//   actions: page.evaluate(gifosAgent.call(name, args))

// Runs in the page before its own scripts, in every frame (it acts in the top frame only).
function pageStart(cfg) {
  if (window.top !== window) return;
  window.__gifosAgentQ = true;   // agent mode, whatever the address router does with ?agent=1
  try {
    if (cfg.name) localStorage.setItem('gifos_name', cfg.name);
    if (cfg.name) localStorage.setItem('gifos_meet_bar', '0');
    if (cfg.relay) localStorage.setItem('gifos_relay', cfg.relay);
    if (cfg.room && cfg.password) localStorage.setItem('gifos_vpw_' + cfg.room, cfg.password);
    if (cfg.debug) { sessionStorage.setItem('gifos_debug', '1'); localStorage.setItem('gifos_debug_log', 'on'); }   // DEBUG MODE: the page reads the tab flag from sessionStorage and the log switch from localStorage
    if (cfg.name) sessionStorage.setItem('gifos_appear_ok', '1');   // the name is given: no name card
  } catch (e) {}
  const hook = () => {
    const a = window.gifosAgent;
    if (!a) return false;
    if (a.__sdkHooked) return true;
    a.__sdkHooked = true;
    a.on('*', (ev) => {
      try {
        let d = ev.data;
        if (d && typeof d === 'object' && (d.samples || d.track || d.onFrame)) { d = Object.assign({}, d); delete d.samples; delete d.track; delete d.onFrame; }
        window.__gifosAgentPush(JSON.stringify({ type: ev.type, data: d }));
      } catch (e) {}
    });
    return true;
  };
  if (!hook()) { const t = setInterval(() => { if (hook()) clearInterval(t); }, 100); }
}

export async function playwrightTransport(page, cfg = {}) {
  let onEv = () => {};
  const early = [];
  await page.exposeBinding('__gifosAgentPush', (_src, json) => {
    let ev; try { ev = JSON.parse(json); } catch (e) { return; }
    if (onEv) onEv(ev); else early.push(ev);
  });
  await page.addInitScript(pageStart, { name: cfg.name || '', relay: cfg.relay || '', room: cfg.room || '', password: cfg.password || '', debug: !!cfg.debug });
  page.on('crash', () => onEv({ type: 'left', data: { reason: 'network', why: 'the page crashed' } }));
  page.on('close', () => onEv({ type: 'left', data: { reason: 'manual', why: 'the page closed' } }));
  let closed = false;
  return {
    onEvent(fn) { onEv = fn; for (const ev of early.splice(0)) fn(ev); },
    // A page that is already open (connect): hook its events now, as the start script does on a load.
    async hookNow() { await page.evaluate(pageStart, { name: '', relay: '', room: '', password: '', debug: !!cfg.debug }); },
    async ready(ms) {
      await page.waitForFunction(() => !!(window.gifosAgent && window.gifosAgent.version >= 1), null, { timeout: ms });
    },
    async call(name, args) {
      if (closed) return { ok: false, error: 'This meeting is closed.' };
      return page.evaluate(async ([n, a]) => {
        if (!window.gifosAgent) return { ok: false, error: 'This page has no agent API yet.' };
        const r = await window.gifosAgent.call(n, a);
        if (r && typeof r === 'object') { delete r.track; delete r.onFrame; }
        return r;
      }, [name, args]);
    },
    async close() { if (closed) return; closed = true; try { await cfg.onClose?.(); } catch (e) {} },
  };
}
