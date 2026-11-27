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
    if (cfg.name) sessionStorage.setItem('gifos_appear_ok', '1');   // the name is given: no name card
    // Entries the page keeps on a device for a room: the host key (hostPassword) and "this device listed the room on
    // gifos.tv" (listed). Set on every load, as the page itself would have them after "Host" and "Publish".
    for (const k of Object.keys(cfg.store || {})) localStorage.setItem(k, cfg.store[k]);
  } catch (e) {}
  // stage.play: the page's Rebroadcast sheet makes one <video> per file with createElement. The first one made after
  // a play call is marked as the SDK's, so its state can be read, a start offset applied, and a false "ended" in the
  // middle of a film kept from stopping it. No other element is touched.
  try {
    const make = document.createElement.bind(document);
    document.createElement = function (tag) {
      const el = make.apply(null, arguments);
      const want = window.__gifosSdkPlayNext;
      if (!want || String(tag).toLowerCase() !== 'video') return el;
      window.__gifosSdkPlayNext = null;
      const me = window.__gifosSdkPlay = { el, skips: 0, ev: [] };
      const note = (k, x) => {
        me.ev.push(Object.assign({ at: Date.now(), k, pos: Math.round(el.currentTime * 10) / 10, dur: Math.round(el.duration || 0), rs: el.readyState, err: el.error ? el.error.code : null }, x || {}));
        if (me.ev.length > 40) me.ev.shift();
      };
      el.addEventListener('loadedmetadata', () => {
        const s = +want.startAt || 0;
        if (s > 0 && isFinite(el.duration)) { try { el.currentTime = Math.min(s, Math.max(0, el.duration - 2)); } catch (e) {} }
        note('loadedmetadata');
      }, { once: true });
      for (const k of ['error', 'stalled', 'emptied', 'abort']) el.addEventListener(k, () => note(k));
      // Added before the page's own listener, so it runs first. A film that "ends" more than 8 s before its length hit
      // a spot the decoder gave up on: jump past it (2, 5, 15, 30 s on repeats within a minute) and play on.
      let bumps = 0, lastBump = 0;
      el.addEventListener('ended', (ev) => {
        const d = el.duration, p = el.currentTime;
        note('ended');
        if (want.guard === false || !(isFinite(d) && d > 0 && p < d - 8)) return;
        ev.stopImmediatePropagation();
        const now = Date.now();
        bumps = now - lastBump < 60000 ? bumps + 1 : 0; lastBump = now;
        const step = [2, 5, 15, 30][Math.min(bumps, 3)];
        me.skips++;
        note('skip', { step });
        try { el.currentTime = Math.min(p + step, d - 3); const pr = el.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (e) {}
      });
      return el;
    };
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
  await page.addInitScript(pageStart, { name: cfg.name || '', relay: cfg.relay || '', room: cfg.room || '', password: cfg.password || '', store: cfg.store || {} });
  page.on('crash', () => onEv({ type: 'left', data: { reason: 'network', why: 'the page crashed' } }));
  page.on('close', () => onEv({ type: 'left', data: { reason: 'manual', why: 'the page closed' } }));
  let closed = false;
  return {
    onEvent(fn) { onEv = fn; for (const ev of early.splice(0)) fn(ev); },
    // A page that is already open (connect): hook its events now, as the start script does on a load.
    async hookNow() { await page.evaluate(pageStart, { name: '', relay: '', room: '', password: '' }); },
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
    playFile: (file, o) => playFile(page, file, o),
    playing: () => page.evaluate(playState),
    async stopPlaying() {
      const r = await page.evaluate(() => { const b = document.getElementById('rb-stop'); if (!b || !b.getClientRects().length) return false; b.click(); return true; });
      return r ? { ok: true } : { ok: false, error: 'Nothing is playing on the Stage.' };
    },
    // The host's "No blur" pick on the Rebroadcast bar, where the room lets viewers see a rebroadcast clear. The page
    // offers it again whenever that right changes, so it is picked whenever offered. A real click, as a person makes it.
    async pickClear() {
      const offered = await page.evaluate(() => { const b = document.getElementById('rb-blur'); return !!(b && b.getAttribute('aria-pressed') === 'false' && b.getClientRects().length); });
      if (!offered) return false;
      await page.locator('#rb-blur').click({ timeout: 3000 });
      return true;
    },
  };
}

// What the SDK's rebroadcast element is doing (runs in the page). playing: it still has its file (the page takes the
// file away when the rebroadcast stops, ends or cannot play).
function playState() {
  const me = window.__gifosSdkPlay;
  if (!me) return null;
  const el = me.el;
  return { playing: !!el.getAttribute('src') && !el.ended, pos: el.currentTime, len: isFinite(el.duration) ? el.duration : 0, paused: el.paused, skips: me.skips, trace: me.ev.slice(-12) };
}

// Play a file to the Stage with the page's own Rebroadcast sheet ("Choose a video"), as the host of a broadcast does.
// Resolves when the film is moving, or answers the reason it is not.
async function playFile(page, file, o = {}) {
  const ready = await page.evaluate(() => {
    const me = window.__gifosSdkPlay;
    if (me && me.el.getAttribute('src') && !me.el.ended) return 'busy';
    for (const id of ['rec-notice-ok', 'blurwhy-ok']) { const b = document.getElementById(id); if (b && b.offsetParent !== null) b.click(); }
    const b = document.getElementById('rbbtn');
    if (!b) return 'nobutton';
    if (!document.getElementById('rb-file')) b.click();   // the sheet ("Choose a video") holds the file input
    return document.getElementById('rb-file') ? 'ok' : 'nobutton';
  });
  if (ready === 'busy') return { ok: false, error: 'A file is already playing on the Stage: stop it first.' };
  if (ready === 'nobutton') return { ok: false, error: 'This page has no Rebroadcast button. Play files from a broadcast page (gifos.app/cast#room=...) that this seat hosts.' };
  await page.evaluate((w) => { window.__gifosSdkPlay = null; window.__gifosSdkPlayNext = w; }, { startAt: Math.max(0, +o.startAt || 0), guard: o.guard !== false });
  await page.setInputFiles('#rb-file', file);
  try {
    await page.waitForFunction(() => {
      const me = window.__gifosSdkPlay;
      return !!(me && me.el.getAttribute('src') && !me.el.paused && me.el.currentTime > 0);
    }, null, { timeout: o.startMs || 30000, polling: 100 });
  } catch (e) {
    const why = await page.evaluate(() => { const s = document.querySelector('#status, .status-line'); return s ? String(s.textContent || '').trim().slice(0, 200) : ''; }).catch(() => '');
    await page.evaluate(() => { window.__gifosSdkPlayNext = null; }).catch(() => {});
    return { ok: false, error: 'The file did not start playing on the Stage' + (why ? ' (the page says: ' + why + ')' : '') + '. Is this seat the host of a broadcast, and is the file a video the browser plays (WebM or MP4)?' };
  }
  const st = await page.evaluate(playState);
  return { ok: true, pos: st ? st.pos : 0, len: st ? st.len : 0 };
}
