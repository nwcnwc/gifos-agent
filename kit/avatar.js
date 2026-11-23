// The avatar: the bot's camera, drawn frame by frame and sent through video.out, so the room blurs it like anyone's.
// A set is a module with frame(state, tMs, level, w, h, rgba). Cost control: frames are drawn only when they change:
// idle at 1 fps, listening and speaking at cfg fps (default 6) at 160x120.
import { pathToFileURL } from 'node:url';

export async function loadSet(set) {
  const mod = /[/\\]/.test(set) ? await import(pathToFileURL(set).href) : await import(`./avatars/${set}.js`);
  if (typeof mod.frame !== 'function') throw new Error(`avatar set ${set}: exports no frame().`);
  return mod;
}

export class Avatar {
  // port: { write({rgba,width,height}) } (the SDK's video.out port); levelAt(): 0..1 now
  constructor(set, { width = 160, height = 120, fps = 6 } = {}, port, { now = Date.now } = {}) {
    this.set = set; this.w = width; this.h = height; this.fps = fps; this.port = port; this.now = now;
    this.state = 'idle'; this.levelAt = () => 0; this.px = new Uint8ClampedArray(width * height * 4);
    this.frames = 0; this.drawMs = 0; this.lastIdle = 0; this.timer = null;
  }
  setState(s, levelAt) { this.state = s; this.levelAt = levelAt || (() => 0); }
  tick() {
    const t = this.now();
    if (this.state === 'idle' && t - this.lastIdle < 1000) return false;
    if (this.state === 'idle') this.lastIdle = t;
    const a = process.hrtime.bigint();
    this.set.frame(this.state, t, this.state === 'speaking' ? this.levelAt() : 0, this.w, this.h, this.px);
    this.drawMs += Number(process.hrtime.bigint() - a) / 1e6; this.frames++;
    Promise.resolve(this.port.write({ rgba: Buffer.from(this.px.buffer), width: this.w, height: this.h })).catch(() => {});
    return true;
  }
  start() { this.timer = setInterval(() => this.tick(), Math.round(1000 / this.fps)); return this; }
  stop() { clearInterval(this.timer); this.timer = null; }
}
