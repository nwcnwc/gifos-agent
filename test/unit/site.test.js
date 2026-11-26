// watchSite / siteVersion (src/site.js): a long-running agent learns that the site moved to a new release.
import test from 'node:test';
import assert from 'node:assert/strict';
import { siteVersion, watchSite, compareVersions } from '../../src/index.js';

const answer = (box) => async (url) => {
  assert.match(url, /^http:\/\/site\.test\/version\.json\?ts=\d+$/);
  if (box.fail) throw new Error('offline');
  return { ok: true, json: async () => box.v };
};

test('siteVersion reads latest and the meet floor; null when offline or malformed', async () => {
  const box = { v: { latest: '0.9.28.38', latestMeetFloor: '0.9.28.38', current: '0.9.28' } };
  assert.deepEqual(await siteVersion('http://site.test/', { fetchImpl: answer(box) }), { latest: '0.9.28.38', floor: '0.9.28.38' });
  box.v = { latest: '0.9.28.39', meetFloor: '0.9.28.37' };
  assert.deepEqual(await siteVersion('http://site.test', { fetchImpl: answer(box) }), { latest: '0.9.28.39', floor: '0.9.28.37' });
  box.v = { latest: '<script>' };
  assert.equal(await siteVersion('http://site.test', { fetchImpl: answer(box) }), null);
  box.fail = true;
  assert.equal(await siteVersion('http://site.test', { fetchImpl: answer(box) }), null);
});

test('watchSite: one onUpdate per new latest, none for the first read or a failed read', async () => {
  const box = { v: { latest: '0.9.28.38' } };
  const seen = [];
  const w = watchSite('http://site.test', (u) => { seen.push(u); }, { everyMs: 3600000, fetchImpl: answer(box) });
  await w.check();
  assert.equal(w.latest(), '0.9.28.38');
  assert.deepEqual(seen, []);
  box.fail = true; await w.check(); assert.deepEqual(seen, []);
  box.fail = false; box.v = { latest: '0.9.28.39', latestMeetFloor: '0.9.28.39' };
  await w.check(); await w.check();
  assert.deepEqual(seen, [{ from: '0.9.28.38', to: '0.9.28.39', floor: '0.9.28.39' }]);
  w.stop();
});

test('watchSite: from names the page the agent runs, so a site already ahead is an update at once', async () => {
  const seen = [];
  const w = watchSite('http://site.test', (u) => { seen.push(u.to); }, { everyMs: 3600000, from: '0.9.28.35', fetchImpl: answer({ v: { latest: '0.9.28.38' } }) });
  await w.check();
  assert.deepEqual(seen, ['0.9.28.38']);
  w.stop();
});

test('compareVersions orders dotted releases numerically', () => {
  assert.equal(compareVersions('0.9.28.38', '0.9.28.9'), 1);
  assert.equal(compareVersions('0.9.28', '0.9.28.1'), -1);
  assert.equal(compareVersions('0.9.28.38', '0.9.28.38'), 0);
});
