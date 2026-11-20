// The SDK over a fake transport: it only carries the page's contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Meeting, agentName, lineMatches, agentUrl, roomOf, toWav } from '../../src/index.js';
import { candidates } from '../../src/browser.js';

function fakeTransport(answers = {}) {
  const calls = [];
  let push = null;
  return {
    calls,
    emit: (type, data) => push({ type, data }),
    onEvent(fn) { push = fn; },
    async call(name, args) { calls.push([name, args]); const a = answers[name]; return typeof a === 'function' ? a(args) : (a || { ok: true }); },
    async close() { calls.push(['close']); },
  };
}
const tick = () => new Promise((r) => setImmediate(r));

test('a name must say whose agent it is', () => {
  assert.equal(agentName("Ada (Sam's assistant)"), "Ada (Sam's assistant)");
  assert.equal(agentName('Ada', 'Sam'), 'Ada (Sam’s assistant)');
  assert.throws(() => agentName('Sam'), /whose agent/);
  assert.throws(() => agentName(''), /name/);
});

test('lines(): toMe and trusted filters; never the agent’s own words', async () => {
  const t = fakeTransport();
  const meet = new Meeting(t);
  const it = meet.lines({ toMe: true, trusted: true });
  t.emit('line', { kind: 'speech', text: 'not to me', toMe: false, trust: 'own', final: true });
  t.emit('line', { kind: 'speech', text: 'Ada, a claim', toMe: true, trust: 'unchecked', final: true });
  t.emit('line', { kind: 'spoken', text: 'my own words', toMe: true, trust: 'own', final: true, mine: true });
  t.emit('line', { kind: 'speech', text: 'Ada, hello', toMe: true, trust: 'own', final: true });
  t.emit('line', { kind: 'chat', text: 'Ada, in chat', toMe: true, trust: 'own', final: true });
  const a = await it.next(); const b = await it.next();
  assert.equal(a.value.text, 'Ada, hello');
  assert.equal(b.value.text, 'Ada, in chat');
  t.emit('left', { reason: 'ended' });
  assert.equal((await it.next()).done, true, 'the iterator ends with the meeting');
  assert.ok(lineMatches({ kind: 'speech', trust: 'trusted', final: true }, { trusted: true }));
  assert.ok(!lineMatches({ kind: 'speech', trust: 'distrusted', final: true }, { trusted: true }));
  assert.ok(!lineMatches({ kind: 'speech', trust: 'own', final: true }, { fromAdmin: true }));
});

test('actions: ok answers resolve, a sentence from the page rejects with that sentence', async () => {
  const t = fakeTransport({ chat: (a) => (a.text === 'x' ? { ok: false, error: 'Slow mode: wait a few seconds before posting again.' } : { ok: true, id: 'm1' }) });
  const meet = new Meeting(t);
  assert.deepEqual(await meet.chat('hi'), { ok: true, id: 'm1' });
  await assert.rejects(meet.chat('x'), /Slow mode/);
  await meet.hand(true);
  await meet.stage.ask();
  await meet.app.run('chess');
  await meet.agenda.next();
  assert.deepEqual(t.calls.map((c) => c[0]), ['chat', 'chat', 'hand', 'stage.ask', 'app.run', 'agenda.next']);
});

test('say(): the SDK makes the voice, the page plays it and writes the words; resolves on say.done', async () => {
  const t = fakeTransport({ say: () => ({ ok: true, id: 'say1', ms: 100 }) });
  const meet = new Meeting(t, { tts: async () => ({ pcm: new Int16Array(240), rate: 24000 }) });
  const p = meet.say('Hello there');
  await tick(); await tick();
  const [name, args] = t.calls[0];
  assert.equal(name, 'say');
  assert.equal(args.text, 'Hello there');
  assert.equal(args.interrupt, 'stop', 'barge-in is the default');
  assert.equal(Buffer.from(args.wav, 'base64').toString('latin1', 0, 4), 'RIFF');
  t.emit('say.done', { id: 'say1', stopped: false });
  assert.equal((await p).id, 'say1');
  await assert.rejects(new Meeting(fakeTransport()).say('x'), /No voice/);
});

test('video.in: frames come only from the port that was opened; close stops it', async () => {
  const t = fakeTransport({ 'video.in.open': () => ({ ok: true, port: 'video.in:1', source: 'direct', blurred: true }) });
  const meet = new Meeting(t);
  const eye = await meet.video.in.open({ who: 'p2', fps: 2 });
  assert.equal(t.calls[0][1].as, 'jpeg', 'out of the page, frames are sampled');
  t.emit('video.in.frame', { port: 'video.in:1', w: 4, h: 2, blurred: true, ts: 1, jpeg: Buffer.from('abc').toString('base64') });
  const f = await eye.next();
  assert.equal(f.value.jpeg.toString(), 'abc');
  assert.equal(f.value.blurred, true);
  await eye.close();
  assert.deepEqual(t.calls[t.calls.length - 1], ['video.in.close', { port: 'video.in:1' }]);
  assert.equal((await eye.next()).done, true);
});

test('audio.out and video.out ports write through the contract', async () => {
  const t = fakeTransport({ 'audio.out.open': () => ({ ok: true, port: 'audio.out:1' }), 'video.out.open': () => ({ ok: true, port: 'video.out:2' }) });
  const meet = new Meeting(t);
  const mouth = await meet.audio.out.open({ rate: 24000 });
  await mouth.write(new Int16Array([1, 2, 3]));
  const cam = await meet.video.out.open({ width: 64, height: 36 });
  await cam.write(Buffer.from([0xff, 0xd8]));
  const names = t.calls.map((c) => c[0]);
  assert.deepEqual(names, ['audio.out.open', 'audio.out.write', 'video.out.open', 'video.out.write']);
  assert.equal(Buffer.from(t.calls[1][1].pcm, 'base64').length, 6);
});

test('tools(): JSON-schema tools that act in the meeting', async () => {
  const t = fakeTransport();
  const tools = new Meeting(t).tools();
  const chat = tools.find((x) => x.name === 'send_chat');
  assert.equal(chat.input_schema.required[0], 'text');
  await chat.run({ text: 'hi' });
  assert.deepEqual(t.calls[0], ['chat', { text: 'hi' }]);
});

test('helpers: agent address, room, WAV, browser order', () => {
  assert.match(agentUrl('https://gifos.app/meet/abc'), /\?agent=1$/);
  assert.match(agentUrl('http://127.0.0.1:8099/run.html#v=room1'), /#v=room1&agent=1$/);
  assert.equal(roomOf('https://gifos.app/meet/abc'), 'abc');
  assert.equal(roomOf('http://127.0.0.1:8099/run.html#v=r1'), 'r1');
  const w = toWav(new Int16Array([0, 1]), 16000);
  assert.equal(w.readUInt32LE(24), 16000);
  assert.equal(w.length, 48);
  assert.deepEqual(candidates({ GIFOS_CHROME: '/x' }).map((c) => c.name), ['GIFOS_CHROME']);
  assert.deepEqual(candidates({}, 'linux', () => false, '/pw').map((c) => c.name), ['Playwright Chromium']);
});
