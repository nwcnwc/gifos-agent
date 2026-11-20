// The browser the SDK drives: the one already on this computer (GIFOS_CHROME, then Google Chrome, then Microsoft
// Edge, then a Chromium Playwright installed earlier). It never downloads one.
import fs from 'node:fs';

export const NO_BROWSER = 'No Chrome or Edge on this computer. Install Google Chrome, or run "npx playwright install chromium" once, '
  + 'or set GIFOS_CHROME to a Chrome or Chromium binary. The agent SDK never downloads a browser by itself.';

const CHANNEL_AT = {
  chrome: { linux: '/opt/google/chrome/chrome', darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  msedge: { linux: '/opt/microsoft/msedge/msedge', darwin: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
};

export function candidates(env = process.env, platform = process.platform, exists = fs.existsSync, bundled = '') {
  if (env.GIFOS_CHROME) return [{ name: 'GIFOS_CHROME', executablePath: env.GIFOS_CHROME }];
  const out = [];
  for (const ch of ['chrome', 'msedge']) {
    const at = (CHANNEL_AT[ch] || {})[platform];
    // Windows installs live under several roots: let Playwright find the channel there.
    if (platform === 'win32' || (at && exists(at))) out.push({ name: ch, channel: ch });
  }
  if (bundled) out.push({ name: 'Playwright Chromium', executablePath: bundled });
  return out;
}

export async function launch(chromium, profileDir, opts = {}) {
  let bundled = '';
  try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) bundled = p; } catch (e) {}
  const list = candidates(process.env, process.platform, fs.existsSync, bundled);
  let last = null;
  for (const c of list) {
    const o = {
      headless: opts.headless !== false,
      viewport: { width: 1280, height: 800 },
      args: [
        // The page asks for no camera or microphone in agent mode; these keep a prompt from ever blocking it.
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        // A meeting lives in a background tab: keep its timers running.
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ].concat(opts.args || []),
    };
    if (c.channel) o.channel = c.channel;
    if (c.executablePath) o.executablePath = c.executablePath;
    try { return { context: await chromium.launchPersistentContext(profileDir, o), used: c.name }; }
    catch (e) { last = e; if (c.name === 'GIFOS_CHROME') throw new Error('GIFOS_CHROME did not start (' + String(e.message || e).split('\n')[0] + ').'); }
  }
  const e = new Error(NO_BROWSER);
  e.cause = last;
  throw e;
}
