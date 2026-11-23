// The voice: tts(text) -> Promise<{ pcm: Int16Array, rate }>, the SDK's own tts shape, so say() plays it and stops
// it when someone talks. Providers:
//   none     chat only (say is never called)
//   openai   any OpenAI-compatible /audio/speech: OpenAI (gpt-4o-mini-tts, tts-1), Ollama 0.40.11+ (model phonon,
//            macOS only for now), a local Kokoro-FastAPI. Asks for raw PCM (16-bit, 24 kHz mono).
//   kokoro   on-device Kokoro (npm i kokoro-js; about 400 MB of memory more per bot)
//   espeak   espeak-ng on this computer (free, tiny, robotic)
// Every voice also gives the level envelope of the exact audio it returns (envelope()), for the avatar's mouth.
import { spawn } from 'node:child_process';
import { resolveKey } from './config.js';

export function wavToPcm(buf) {
  const b = Buffer.from(buf);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a WAV');
  let off = 12, rate = 24000, ch = 1, bits = 16;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), len = b.readUInt32LE(off + 4);
    if (id === 'fmt ') { ch = b.readUInt16LE(off + 10); rate = b.readUInt32LE(off + 12); bits = b.readUInt16LE(off + 22); }
    if (id === 'data') {
      if (bits !== 16) throw new Error('WAV must be 16-bit');
      const end = Math.min(b.length, off + 8 + (len || b.length));
      const n = Math.floor((end - off - 8) / 2 / ch), pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) pcm[i] = b.readInt16LE(off + 8 + i * 2 * ch);
      return { pcm, rate };
    }
    off += 8 + len + (len & 1);
  }
  throw new Error('WAV has no data');
}

// RMS level per frame (1/fps s), 0..1, scaled so loud speech reaches about 1.
export function envelope({ pcm, rate }, fps = 6) {
  const win = Math.max(1, Math.round(rate / fps)), out = [];
  for (let i = 0; i < pcm.length; i += win) {
    let e = 0; const end = Math.min(pcm.length, i + win);
    for (let j = i; j < end; j++) e += pcm[j] * pcm[j];
    out.push(Math.min(1, Math.sqrt(e / (end - i)) / 6000));
  }
  return out;
}

export function openaiVoice(p, { fetchFn = globalThis.fetch, env = process.env } = {}) {
  if (!p.base_url) throw new Error('voice.base_url: such as https://api.openai.com/v1 or http://127.0.0.1:11434/v1.');
  const key = resolveKey(p, env);
  const url = p.base_url.replace(/\/+$/, '') + '/audio/speech';
  const rate = p.rate || 24000;
  return async (text) => {
    const r = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
      body: JSON.stringify({ model: p.model || 'gpt-4o-mini-tts', voice: p.voice || 'alloy', input: String(text), response_format: 'pcm', ...(p.instructions ? { instructions: p.instructions } : {}) }),
    });
    if (!r.ok) throw new Error(`voice HTTP ${r.status}`);
    const b = Buffer.from(await r.arrayBuffer());
    if (b.toString('ascii', 0, 4) === 'RIFF') return wavToPcm(b);   // a server that sends WAV anyway
    return { pcm: new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2)).slice(), rate };
  };
}

export function espeakVoice(p) {
  return (text) => new Promise((resolve, reject) => {
    const ch = spawn(p.bin || 'espeak-ng', ['--stdout', '-v', p.voice || 'en-us', '-s', String(p.speed || 165), String(text)]);
    const parts = [];
    ch.stdout.on('data', (d) => parts.push(d));
    ch.on('error', (e) => reject(new Error('espeak-ng is not installed (' + e.code + ')')));
    ch.on('close', (code) => { try { if (code) throw new Error('espeak-ng exit ' + code); resolve(wavToPcm(Buffer.concat(parts))); } catch (e) { reject(e); } });
  });
}

async function kokoroVoice(p) {
  const { kokoroTts } = await import('../src/tts.js');
  const t = await kokoroTts({ voice: p.voice || 'af_heart' });
  if (!t) throw new Error('voice kokoro: npm i kokoro-js first.');
  return t;
}

// makeVoice(cfg) -> null (chat only) or { tts, lastEnvelope() }: tts is passed to join({ tts }).
export async function makeVoice(c, opts = {}) {
  const p = c.voice;
  let raw;
  if (!p || p.provider === 'none') return null;
  if (p.provider === 'openai') raw = openaiVoice(p, opts);
  else if (p.provider === 'espeak') raw = espeakVoice(p);
  else if (p.provider === 'kokoro') raw = await kokoroVoice(p);
  else throw new Error(`voice.provider "${p.provider}": use none, openai, kokoro or espeak.`);
  let env = [];
  const v = {
    provider: p.provider,
    onAudio: null,   // called when the audio is ready (playback starts right after)
    async tts(text) {
      let a = await raw(String(text).slice(0, c.limits.max_say_chars));
      if (a.wav) a = wavToPcm(a.wav);
      env = envelope(a, c.avatar.fps);
      if (v.onAudio) v.onAudio(a);
      return a;
    },
    lastEnvelope: () => env,
  };
  return v;
}
