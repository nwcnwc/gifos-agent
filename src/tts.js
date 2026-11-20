// Text to speech. The meeting page has no voice of its own: the SDK makes the audio and the page plays it.
// Default: Kokoro (kokoro-js, optional; install it to use it). Pass your own { tts } to join() for any other engine:
//   tts(text) -> { wav: Buffer } | { pcm: Int16Array, rate }
let kokoro = null;
export async function kokoroTts(opts = {}) {
  let mod;
  try { mod = await import('kokoro-js'); } catch (e) { return null; }
  const voice = opts.voice || 'af_heart';
  return async (text) => {
    if (!kokoro) kokoro = await mod.KokoroTTS.from_pretrained(opts.model || 'onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: opts.dtype || 'q8' });
    const audio = await kokoro.generate(String(text), { voice });
    const { toPcm16 } = await import('./audio.js');
    return { pcm: toPcm16(audio.audio), rate: audio.sampling_rate };
  };
}
