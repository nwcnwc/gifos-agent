// wavToPcm, envelope, openaiVoice, makeVoice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wavToPcm, envelope, openaiVoice, makeVoice } from '../../kit/voice.js';

// 16-bit PCM WAV. samples is one interleaved Int16 channel list.
function buildWav(samples, { rate = 24000, channels = 1 } = {}) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  samples.forEach((s, i) => buf.writeInt16LE(s, 44 + i * 2));
  return buf;
}

function arrayBufferOf(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

test('wavToPcm round-trips 16-bit mono 24 kHz and keeps the first channel of stereo', () => {
  const mono = [1, -2, 30000, -400];
  const a = wavToPcm(buildWav(mono, { rate: 24000, channels: 1 }));
  assert.equal(a.rate, 24000);
  assert.deepEqual(a.pcm, Int16Array.from(mono));

  const stereo = wavToPcm(buildWav([1000, 2000, -3000, 4000], { rate: 24000, channels: 2 }));
  assert.equal(stereo.rate, 24000);
  assert.deepEqual(stereo.pcm, Int16Array.from([1000, -3000]));
});

test('envelope length is ceil(samples / (rate / fps)); silence is 0 and loud is near 1', () => {
  const rate = 24000;
  const fps = 6;
  const n = 9000;
  const silent = envelope({ pcm: new Int16Array(n), rate }, fps);
  assert.equal(silent.length, Math.ceil(n / (rate / fps)));
  assert.ok(silent.every((x) => x === 0));

  const loud = envelope({ pcm: new Int16Array(4000).fill(16000), rate }, fps);
  assert.equal(loud.length, 1);
  assert.ok(loud[0] > 0.9 && loud[0] <= 1);
});

test('openaiVoice asks for pcm at /audio/speech and returns Int16 samples at 24000', async () => {
  const samples = [100, -200, 300, -400];
  let seen;
  const fetchFn = async (url, opts) => {
    seen = { url, headers: { ...opts.headers }, body: JSON.parse(opts.body) };
    const b = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
    return { ok: true, arrayBuffer: async () => arrayBufferOf(b) };
  };
  const tts = openaiVoice(
    { base_url: 'https://example.com/v1/', key_env: 'BOT_TEST_KEY' },
    { fetchFn, env: { BOT_TEST_KEY: 'K' } },
  );
  const out = await tts('hello');
  assert.equal(seen.url, 'https://example.com/v1/audio/speech');
  assert.equal(seen.headers.authorization || seen.headers.Authorization, 'Bearer K');
  assert.equal(seen.body.response_format, 'pcm');
  assert.equal(seen.body.model, 'gpt-4o-mini-tts');
  assert.equal(seen.body.voice, 'alloy');
  assert.ok(out.pcm instanceof Int16Array);
  assert.equal(out.rate, 24000);
  assert.deepEqual(out.pcm, Int16Array.from(samples));
});

test('openaiVoice omits Authorization when no key is set, and parses a WAV body', async () => {
  let headers;
  const wav = buildWav([9, -8, 7], { rate: 16000, channels: 1 });
  const fetchFn = async (url, opts) => {
    headers = { ...opts.headers };
    assert.equal(url, 'https://example.com/v1/audio/speech');
    return { ok: true, arrayBuffer: async () => arrayBufferOf(wav) };
  };
  const tts = openaiVoice({ base_url: 'https://example.com/v1' }, { fetchFn, env: {} });
  const out = await tts('hello');
  assert.equal(headers.authorization, undefined);
  assert.equal(headers.Authorization, undefined);
  assert.equal(out.rate, 16000);
  assert.deepEqual(out.pcm, Int16Array.from([9, -8, 7]));
});

test('makeVoice returns null for provider none', async () => {
  assert.equal(await makeVoice({ voice: { provider: 'none' } }), null);
});

test('makeVoice openai clips to max_say_chars, sets lastEnvelope and calls onAudio', async () => {
  const samples = [1000, -1000, 1000, -1000];
  let body;
  const fetchFn = async (url, opts) => {
    body = JSON.parse(opts.body);
    const b = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
    return { ok: true, arrayBuffer: async () => arrayBufferOf(b) };
  };
  const voice = await makeVoice({
    voice: { provider: 'openai', base_url: 'https://example.com/v1' },
    limits: { max_say_chars: 5 },
    avatar: { fps: 6 },
  }, { fetchFn, env: {} });
  const heard = [];
  voice.onAudio = (a) => heard.push(a);
  const audio = await voice.tts('hello world');
  assert.equal(body.input, 'hello');
  assert.equal(body.response_format, 'pcm');
  assert.equal(heard.length, 1);
  assert.equal(heard[0], audio);
  assert.deepEqual(voice.lastEnvelope(), envelope(audio, 6));
});

test('makeVoice throws for an unknown provider', async () => {
  await assert.rejects(
    makeVoice({ voice: { provider: 'megaphone' }, limits: {}, avatar: {} }),
    /megaphone/,
  );
});
