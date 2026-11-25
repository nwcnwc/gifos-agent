// A meeting the agent is in. Every method is one call of the page's gifosAgent contract over a transport:
//   transport.call(name, args) -> Promise<{ok, ...}>
//   transport.onEvent(fn)      -> fn({type, data}) for every page event
//   transport.close()
// Errors come back as the page's own sentence (Error.message), ready to show a person.
import { lineMatches } from './protocol.js';
import { toWav } from './audio.js';

class Queue {
  constructor() { this.items = []; this.waiters = []; this.done = false; }
  push(x) { if (this.done) return; const w = this.waiters.shift(); if (w) w({ value: x, done: false }); else this.items.push(x); }
  end() { this.done = true; for (const w of this.waiters.splice(0)) w({ value: undefined, done: true }); }
  next() {
    if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
    if (this.done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((r) => this.waiters.push(r));
  }
}

const b64 = (buf) => Buffer.from(buf.buffer ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf).toString('base64');

export class Meeting {
  constructor(transport, opts = {}) {
    this.t = transport;
    this.opts = opts;
    this.handlers = new Map();
    this.queues = new Set();
    this.ports = new Map();
    this.closed = false;
    this.t.onEvent((ev) => this._event(ev));
    const self = this;
    this.audio = {
      out: { open: (o) => self._audioOut(o) },
      in: { open: (o) => self._portIn('audio.in', o, (d) => ({ pcm: new Int16Array(new Uint8Array(Buffer.from(d.pcm, 'base64')).buffer), rate: d.rate, ts: d.ts })) },
    };
    this.video = {
      in: { open: (o) => self._portIn('video.in', o, (d) => ({ jpeg: d.jpeg ? Buffer.from(d.jpeg, 'base64') : null, rgb: d.rgb ? Buffer.from(d.rgb, 'base64') : null, width: d.w, height: d.h, blurred: !!d.blurred, ts: d.ts })) },
      out: { open: (o) => self._videoOut(o) },
    };
    this.stage = { ask: () => this.call('stage.ask'), leave: () => this.call('stage.leave') };
    this.app = {
      run: (id) => this.call('app.run', { id }),
      stop: () => this.call('app.stop'),
      room: (op, args) => this.call('app.room', { op, args }),
      // the shared app's data, as the app itself reads and writes it: get, getAll, put, delete
      data: (op, collection, key, value) => this.call('app.data', { op, collection, key, value }),
    };
    this.agenda = { next: () => this.call('agenda.next'), set: (items) => this.call('agenda.set', { items }) };
  }

  async call(name, args) {
    if (this.closed) throw new Error('This meeting is closed.');
    const r = await this.t.call(name, args || {});
    if (!r || r.ok === false) throw new Error((r && r.error) || 'The meeting page did not answer.');
    return r;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type).delete(fn);
  }

  _event(ev) {
    if (!ev || !ev.type) return;
    const port = ev.data && ev.data.port && this.ports.get(ev.data.port);
    if (port && (ev.type === 'audio.in.frame' || ev.type === 'video.in.frame')) { port.q.push(port.map(ev.data)); return; }
    if (port && ev.type === 'port.closed') { port.q.end(); this.ports.delete(ev.data.port); return; }
    for (const fn of this.handlers.get(ev.type) || []) { try { fn(ev.data); } catch (e) { /* a handler's fault is its own */ } }
    for (const fn of this.handlers.get('*') || []) { try { fn(ev); } catch (e) {} }
    if (ev.type === 'line') for (const q of this.queues) if (lineMatches(ev.data, q.filter)) q.push(ev.data);
    if (ev.type === 'left') this._end();
  }

  // Lines from now on, filtered: {toMe, trusted, fromAdmin, kinds}. An async iterator that ends when the meeting does.
  lines(filter = {}) {
    const q = new Queue();
    q.filter = filter;
    this.queues.add(q);
    const self = this;
    return {
      [Symbol.asyncIterator]() { return this; },
      next: () => q.next(),
      return: () => { self.queues.delete(q); q.end(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }

  async people() { return (await this.call('people')).people; }
  async state() { return (await this.call('state')).state; }

  // Say text aloud. The page plays the voice and writes the text as the agent's own spoken line (captioned from
  // the text, not from speech). A tts function {(text) -> {wav}|{pcm, rate}} or Kokoro makes the voice.
  async say(text, opts = {}) {
    const tts = this.opts.tts;
    if (!tts) throw new Error('No voice: pass { tts } to join(), or install kokoro-js.');
    const v = await tts(String(text), opts);
    const wav = v.wav ? v.wav : toWav(v.pcm, v.rate);
    // Listen before calling: a busy page can finish a short clip before its answer to the call reaches us.
    const ended = new Map();
    const waiters = new Map();
    const off = this.on('say.done', (d) => {
      if (!d || !d.id) return;
      const w = waiters.get(d.id);
      if (w) w(d); else ended.set(d.id, d);
    });
    let r;
    try { r = await this.call('say', { text: String(text), wav: b64(wav), interrupt: opts.interrupt || 'stop' }); }
    catch (e) { off(); throw e; }
    if (opts.wait === false) { off(); return r; }
    return new Promise((resolve) => {
      const finish = (d) => { off(); resolve({ ...r, ...d }); };
      if (ended.has(r.id)) finish(ended.get(r.id)); else waiters.set(r.id, finish);
    });
  }
  stopSaying() { return this.call('say.stop'); }
  // What this seat may do: the signed line items it holds now ({signed, label, roomLimit, admitAtFullDoor, captureOpenRoom,
  // turnVideoLinks, storage, meetings, agentHost, overflow, until, sources}). label is the plan's name, for display only:
  // decide on the line items. No plan held: the defaults, signed false.
  async rights() { return (await this.call('rights')).rights || null; }
  // Use a credentials GIF (a subscription file from Settings > Subscription, or a pass) in this seat: a path or the bytes.
  // Its bytes go only to this seat's page. -> the rights it now holds.
  async useCredentials(file) {
    const bytes = typeof file === 'string' ? (await import('node:fs/promises')).readFile(file) : file;
    return (await this.call('credentials', { gif_b64: b64(await bytes) })).rights || null;
  }
  chat(text) { return this.call('chat', { text }); }
  hand(up = true) { return this.call('hand', { up: !!up }); }
  mic(on) { return this.call('mic', { on: !!on }); }
  profile(p) { return this.call('profile', p); }
  // resolves once the goodbye has left (a process may exit right after it)
  async leave() { try { await this.call('leave'); } finally { await this._end(); } }

  async _audioOut(o = {}) {
    const r = await this.call('audio.out.open', { rate: o.rate || 24000 });
    const self = this;
    return {
      id: r.port,
      write: (pcm) => self.call('audio.out.write', { port: r.port, pcm: b64(pcm) }),
      clear: () => self.call('audio.out.clear', { port: r.port }),
      close: () => self.call('audio.out.close', { port: r.port }),
    };
  }

  async _videoOut(o = {}) {
    const r = await this.call('video.out.open', { width: o.width || 640, height: o.height || 360, fps: o.fps || 15 });
    const self = this;
    return {
      id: r.port,
      // f: a JPEG Buffer, or {rgba, width, height}
      write: (f) => self.call('video.out.write', Buffer.isBuffer(f) || f instanceof Uint8Array
        ? { port: r.port, jpeg: b64(f) }
        : { port: r.port, rgba: b64(f.rgba), w: f.width, h: f.height }),
      close: () => self.call('video.out.close', { port: r.port }),
    };
  }

  async _portIn(kind, o = {}, map) {
    const args = { ...o };
    if (kind === 'video.in' && (!args.as || args.as === 'track' || args.as === 'frames')) args.as = 'jpeg';   // out of the page: sampled frames
    const r = await this.call(kind + '.open', args);
    const q = new Queue();
    this.ports.set(r.port, { q, map });
    const self = this;
    return {
      id: r.port,
      info: r,
      [Symbol.asyncIterator]() { return this; },
      next: () => q.next(),
      close: () => { self.ports.delete(r.port); q.end(); return self.call(kind + '.close', { port: r.port }); },
      return() { this.close().catch(() => {}); return Promise.resolve({ value: undefined, done: true }); },
    };
  }

  // The actions as JSON-schema tools for any LLM loop. run(name, input) performs one.
  tools() { return toolsFor(this); }

  _end() {
    if (this.closed) return this._closing || Promise.resolve();
    this.closed = true;
    for (const q of this.queues) q.end();
    for (const p of this.ports.values()) p.q.end();
    this.queues.clear(); this.ports.clear();
    this._closing = Promise.resolve().then(() => this.t.close()).catch(() => {});
    return this._closing;
  }
  close() { return this._end(); }
}

function toolsFor(meet) {
  const T = (name, description, properties, required, run) => ({ name, description, input_schema: { type: 'object', properties, required: required || [] }, run });
  return [
    T('send_chat', 'Post one line to the meeting chat. Slow mode may hold it a few seconds.', { text: { type: 'string' } }, ['text'], (i) => meet.chat(i.text)),
    T('say_aloud', 'Say a sentence aloud in the meeting.', { text: { type: 'string' } }, ['text'], (i) => meet.say(i.text)),
    T('raise_hand', 'Raise or lower the agent’s hand.', { up: { type: 'boolean' } }, ['up'], (i) => meet.hand(i.up)),
    T('ask_for_stage', 'Ask to step onto the Stage.', {}, [], () => meet.stage.ask()),
    T('leave_stage', 'Step off the Stage.', {}, [], () => meet.stage.leave()),
    T('run_app', 'Run a meeting app by its id (only where the room lets this seat).', { id: { type: 'string' } }, ['id'], (i) => meet.app.run(i.id)),
    T('stop_app', 'Stop the running meeting app.', {}, [], () => meet.app.stop()),
    T('next_agenda_item', 'Move the agenda to its next item (only where the room lets this seat).', {}, [], () => meet.agenda.next()),
    T('list_people', 'List who is in the meeting.', {}, [], () => meet.people()),
  ];
}
