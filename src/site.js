// The site moves on under a long-running agent. A GifOS deploy names a new live release in the site's /version.json
// ("latest") and may raise the meet floor ("latestMeetFloor": the oldest release that can still meet the live one) or
// change how links name a room. An open page stays on the release it loaded, so an agent that keeps a seat for hours
// must load the page again when the site moves, or it ends up in a room that fresh pages never reach.
//
//   siteVersion(site)                 -> { latest, floor } or null (offline, no version.json)
//   watchSite(site, onUpdate, opts)   -> { stop(), latest(), check() }; onUpdate({ from, to, floor }) once per new latest
//
// version.json is a small revalidated fetch (ETag, 304), so one read a minute costs the site next to nothing.

const VER = /^\d+(\.\d+){1,3}$/;
const ok = (v) => (typeof v === 'string' && VER.test(v) ? v : '');

// a vs b on dotted numbers: -1, 0 or 1 (0.9.28.38 > 0.9.28.9 > 0.9.28).
export function compareVersions(a, b) {
  const x = String(a || '').split('.').map(Number), y = String(b || '').split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export async function siteVersion(site, { fetchImpl } = {}) {
  const f = fetchImpl || globalThis.fetch;
  try {
    const r = await f(String(site).replace(/\/+$/, '') + '/version.json?ts=' + Date.now(), { cache: 'no-store' });
    if (!r || !r.ok) return null;
    const j = await r.json();
    const latest = ok(j && j.latest);
    if (!latest) return null;
    return { latest, floor: ok(j.latestMeetFloor) || ok(j.meetFloor) };
  } catch (e) { return null; }
}

// opts: everyMs (default 60000), from (the release the agent's page runs; default: the first latest read),
// fetchImpl (tests). A failed read changes nothing; the next one tries again.
export function watchSite(site, onUpdate, opts = {}) {
  const everyMs = Number(opts.everyMs) > 0 ? Number(opts.everyMs) : 60000;
  let known = ok(opts.from);
  let stopped = false;
  let busy = null;
  const check = () => {
    if (busy) return busy;
    busy = (async () => {
      const v = await siteVersion(site, { fetchImpl: opts.fetchImpl });
      if (stopped || !v) return v;
      if (!known) { known = v.latest; return v; }
      if (v.latest !== known) {
        const from = known;
        known = v.latest;
        try { await onUpdate({ from, to: v.latest, floor: v.floor }); } catch (e) { /* the caller's own failure; the watch goes on */ }
      }
      return v;
    })().finally(() => { busy = null; });
    return busy;
  };
  const t = setInterval(() => { check(); }, everyMs);
  if (t.unref) t.unref();
  check();
  return { stop() { stopped = true; clearInterval(t); }, latest: () => known, check };
}
