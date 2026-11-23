// blob frames and the Avatar pump.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { frame, colors } from '../../kit/avatars/blob.js';
import { Avatar, loadSet } from '../../kit/avatar.js';

const W = 160;
const H = 120;

function at(px, x, y) {
  const i = (y * W + x) * 4;
  return [px[i], px[i + 1], px[i + 2], px[i + 3]];
}

function paint(state, t, level) {
  const px = new Uint8ClampedArray(W * H * 4);
  frame(state, t, level, W, H, px);
  return px;
}

test('blob.frame paints speaking, listening and idle differently', () => {
  const speaking = paint('speaking', 0, 0);
  const centre = at(speaking, W / 2, H / 2);
  assert.ok(centre[0] > centre[1] && centre[1] > centre[2], 'speaking centre is orange-ish');

  const listening = paint('listening', 0, 0);
  let teal = false;
  for (let i = 0; i < listening.length; i += 4) {
    const r = listening[i];
    const g = listening[i + 1];
    const b = listening[i + 2];
    if (g > 100 && b > 100 && r < 80) { teal = true; break; }
  }
  assert.ok(teal, 'listening frame has teal pixels');

  const idle = paint('idle', 0, 0);
  const idleCentre = at(idle, W / 2, H / 2);
  assert.deepEqual(idleCentre.slice(0, 3), colors.idle);

  const filled = (level) => {
    const px = paint('speaking', 0, level);
    const bg = [px[0], px[1], px[2]];
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] !== bg[0] || px[i + 1] !== bg[1] || px[i + 2] !== bg[2]) n += 1;
    }
    return n;
  };
  assert.ok(filled(1) > filled(0));
});

test('Avatar draws idle at most once per 1000 ms and speaking on every tick', () => {
  const writes = [];
  const port = { write(f) { writes.push(f); return Promise.resolve(); } };
  let now = 1_000_000;
  const av = new Avatar(
    { frame(state, t, level, w, h, px) { px.fill(state === 'speaking' ? 2 : 1); } },
    { fps: 6 },
    port,
    { now: () => now },
  );
  av.setState('idle');
  assert.equal(av.tick(), true);
  now += 999;
  assert.equal(av.tick(), false);
  assert.equal(writes.length, 1);

  av.setState('speaking', () => 1);
  now += 1;
  assert.equal(av.tick(), true);
  now += 1;
  assert.equal(av.tick(), true);
  assert.equal(writes.length, 3);

  const f = writes[0];
  assert.ok(Buffer.isBuffer(f.rgba));
  assert.equal(f.rgba.length, 160 * 120 * 4);
  assert.equal(f.width, 160);
  assert.equal(f.height, 120);
});

test('loadSet loads blob and a module file, and rejects a module with no frame()', async () => {
  const built = await loadSet('blob');
  assert.equal(typeof built.frame, 'function');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botkit-avatar-'));
  const good = path.join(dir, 'good.mjs');
  const bad = path.join(dir, 'bad.mjs');
  fs.writeFileSync(good, 'export function frame() { return 7; }\n');
  fs.writeFileSync(bad, 'export const name = "nope";\n');
  try {
    const mod = await loadSet(good);
    assert.equal(mod.frame(), 7);
    await assert.rejects(loadSet(bad), /frame/);
  } finally {
    fs.unlinkSync(good);
    fs.unlinkSync(bad);
    fs.rmdirSync(dir);
  }
});
