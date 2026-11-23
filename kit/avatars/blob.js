// The default avatar set. Each state differs in SHAPE, COLOUR and MOTION, so it still reads through blur:
//   idle       a grey-blue disc that breathes slowly, two eyes
//   listening  a big teal ear (a C-shaped ring) with sound rings rippling into it from the left
//   speaking   a big orange disc that swells with the voice level; a dark mouth opens with each syllable
// frame(state, tMs, level, w, h, rgba) paints one RGBA frame. Replace this file to swap the whole look.
export const name = 'blob';
export const colors = { idle: [88, 104, 140], listening: [20, 170, 160], speaking: [245, 130, 30] };

export function frame(state, t, level, w, h, px) {
  const bgs = { idle: [24, 26, 34], listening: [10, 40, 44], speaking: [52, 28, 12] };
  const bg = bgs[state] || bgs.idle, fg = colors[state] || colors.idle;
  const cx = w / 2, cy = h / 2, R0 = Math.min(w, h) * 0.33, s = t / 1000;
  const r = state === 'speaking' ? R0 * (0.92 + 0.3 * level) : state === 'idle' ? R0 * (1 + 0.04 * Math.sin(s * 1.6)) : R0;
  const mouthH = state === 'speaking' ? R0 * (0.08 + 0.45 * level) : 0;
  const ring = (s * 0.9) % 1;                       // 0..1, the ripple's phase
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      let c = bg;
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
      if (state === 'listening') {
        const ex = dx / 0.75, de = Math.hypot(ex, dy);              // the ear: an upright oval ring, open on the left
        const inEar = de < R0 * 1.15 && de > R0 * 0.62 && !(dx < -R0 * 0.25 && Math.abs(dy) < R0 * 0.35);
        const lobe = Math.hypot(dx / 0.6, dy - R0 * 0.25) < R0 * 0.28;
        for (const ph of [ring, (ring + 0.5) % 1]) {                // two sound rings travelling right, into the ear
          const rr = R0 * (1.9 - 1.2 * ph), dd = Math.hypot(x - (cx - R0 * 1.4), dy);
          if (dx < -R0 * 0.4 && Math.abs(dd - rr) < 2.2) c = [fg[0] * (1 - ph * 0.6), fg[1] * (1 - ph * 0.6), fg[2] * (1 - ph * 0.6)];
        }
        if (inEar || lobe) c = fg;
      } else if (d < r) {
        c = fg;
        const eye = (ex) => Math.hypot(x - (cx + ex), y - (cy - r * 0.28)) < r * 0.1;
        if (eye(-r * 0.32) || eye(r * 0.32)) c = [20, 20, 24];
        if (mouthH > 0 && Math.hypot((x - cx) / (r * 0.38), (y - (cy + r * 0.32)) / mouthH) < 1) c = [40, 10, 10];
        if (state === 'idle' && Math.abs(y - (cy + r * 0.34)) < 1.2 && Math.abs(x - cx) < r * 0.25) c = [20, 20, 24];
      }
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
  }
}
