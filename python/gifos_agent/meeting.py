"""A meeting seat held by a gifos-agent-stdio child process (see the Node package's src/stdio.js)."""
import asyncio
import base64
import inspect
import io
import json
import os
import shutil
import struct
import wave

__all__ = ["Meeting", "MeetingError", "join", "bridge_command", "to_wav"]


class MeetingError(Exception):
    """The meeting's own sentence for a call it refused, ready to show a person."""


def bridge_command():
    """The command that starts the seat: GIFOS_AGENT_BRIDGE (a path to src/stdio.js, run with node), else the
    gifos-agent-stdio program on PATH (npm install -g @gifos-app/agent), else npx."""
    path = os.environ.get("GIFOS_AGENT_BRIDGE")
    if path:
        return [os.environ.get("GIFOS_NODE", "node"), path]
    exe = shutil.which("gifos-agent-stdio")
    if exe:
        return [exe]
    return ["npx", "--yes", "-p", "@gifos-app/agent", "gifos-agent-stdio"]


def to_wav(pcm, rate=24000):
    """Mono 16-bit PCM (bytes, little-endian, or a sequence of ints) as a WAV file's bytes: what say() plays."""
    if not isinstance(pcm, (bytes, bytearray, memoryview)):
        pcm = struct.pack("<%dh" % len(pcm), *[max(-32768, min(32767, int(x))) for x in pcm])
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(rate))
        w.writeframes(bytes(pcm))
    return buf.getvalue()


def _line_matches(line, to_me=False, trusted=False, from_admin=False, kinds=None):
    """What a lines() filter keeps: the Node package's lineMatches, rule for rule. Captions are self-reported, so
    trusted keeps only the speaker's own engine or a line this page trusts."""
    if not isinstance(line, dict) or line.get("final") is False:
        return False
    kind = line.get("kind")
    if kinds and kind not in kinds:
        return False
    if not kinds and kind in ("spoken", "system"):
        return False  # never its own words back
    if line.get("mine"):
        return False
    if to_me and not line.get("toMe"):
        return False
    if from_admin and not line.get("fromAdmin"):
        return False
    if trusted and kind != "chat" and line.get("trust") not in ("own", "trusted"):
        return False
    return True


class _AudioIn:
    """The room's sound as this seat hears it: an async iterator of {"pcm": bytes (16-bit mono), "rate", "ts"}, 20 ms a
    frame. Ends when closed or when the meeting does."""

    def __init__(self, meet, port, info):
        self._m = meet
        self.id = port
        self.info = info
        self._q = asyncio.Queue()

    def _push(self, item):
        self._q.put_nowait(item)

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self._q.get()
        if item is None:
            raise StopAsyncIteration
        return item

    async def close(self):
        if self._m._ports.pop(self.id, None) is None:
            return
        self._q.put_nowait(None)
        if not self._m.closed:
            try:
                await self._m.call("audio.in.close", {"port": self.id})
            except MeetingError:
                pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self.close()


class _App:
    def __init__(self, meet):
        self._m = meet

    async def run(self, app_id):
        return await self._m.call("app.run", {"id": app_id})

    async def stop(self):
        return await self._m.call("app.stop")

    async def room(self, op, args=None):
        """The shared app's people and gifos.room session: room("state"), room("join"), room("move", {...})."""
        return (await self._m.call("app.room", {"op": op, "args": args or {}})).get("result")

    async def data(self, op, collection, key=None, value=None):
        """The shared app's data, as the app reads and writes it: get, getAll, put, delete."""
        return (await self._m.call("app.data", {"op": op, "collection": collection, "key": key, "value": value})).get("result")


class Meeting:
    """One agent seat. Every method is one call of the meeting page's gifosAgent contract."""

    def __init__(self, proc, tts=None):
        self._proc = proc
        self._tts = tts
        self._next = 0
        self._waiting = {}
        self._handlers = {}
        self._queues = []
        self._ports = {}
        self._unclaimed = {}  # frames of a port whose open answer is still on its way to audio_in()
        self.closed = False
        self.core = False
        self.app = _App(self)
        self._reader = asyncio.ensure_future(self._read())

    async def _read(self):
        try:
            while True:
                raw = await self._proc.stdout.readline()
                if not raw:
                    break
                try:
                    m = json.loads(raw)
                except ValueError:
                    continue
                if "event" in m:
                    self._event(m["event"] or {})
                    continue
                fut = self._waiting.pop(m.get("id"), None)
                if fut and not fut.done():
                    fut.set_result(m)
        finally:
            self._finish()

    def _event(self, ev):
        t, d = ev.get("type"), ev.get("data")
        port = self._ports.get(d.get("port")) if isinstance(d, dict) else None
        if t == "audio.in.frame" and isinstance(d, dict):
            f = {"pcm": base64.b64decode(d.get("pcm") or ""), "rate": d.get("rate"), "ts": d.get("ts")}
            if port:
                port._push(f)
            else:  # the first frames can come in right behind the open's answer, before audio_in() files the port
                self._unclaimed.setdefault(d.get("port"), []).append(f)
                del self._unclaimed[d.get("port")][:-250]
            return
        if port and t == "port.closed":
            self._ports.pop(port.id, None)
            port._push(None)
            return
        calls = [(fn, d) for fn in self._handlers.get(t, ())] + [(fn, ev) for fn in self._handlers.get("*", ())]
        for fn, arg in calls:
            try:
                fn(arg)
            except Exception:  # a handler's fault is its own
                pass
        if t == "line":
            for q, flt in list(self._queues):
                if _line_matches(d, **flt):
                    q.put_nowait(d)
        if t == "left":
            self._finish()

    def _finish(self):
        if self.closed:
            return
        self.closed = True
        for q, _ in self._queues:
            q.put_nowait(None)
        for p in list(self._ports.values()):
            p._push(None)
        self._ports.clear()
        for fut in self._waiting.values():
            if not fut.done():
                fut.set_exception(MeetingError("The meeting seat closed."))
        self._waiting.clear()

    async def _send(self, msg):
        if self.closed:
            raise MeetingError("This meeting is closed.")
        self._next += 1
        msg["id"] = self._next
        fut = asyncio.get_running_loop().create_future()
        self._waiting[self._next] = fut
        self._proc.stdin.write((json.dumps(msg) + "\n").encode())
        await self._proc.stdin.drain()
        r = await fut
        if not r.get("ok"):
            raise MeetingError(r.get("error") or "The meeting page did not answer.")
        return r

    async def call(self, name, args=None):
        """Any call of the contract by name, e.g. call("hand", {"up": True}). Returns the page's answer."""
        return (await self._send({"call": name, "args": args or {}})).get("answer") or {}

    def on(self, event_type, fn):
        """fn(data) for every event of that type ("*": fn({type, data}) for all). Returns a function that removes it."""
        self._handlers.setdefault(event_type, set()).add(fn)
        return lambda: self._handlers.get(event_type, set()).discard(fn)

    def lines(self, to_me=False, trusted=False, from_admin=False, kinds=None):
        """Lines said or typed from now on, filtered (to_me, trusted, from_admin, kinds such as ["chat"] or ["spoken"];
        without kinds, chat and others' captions but never spoken/system lines). An async iterator that listens from the
        moment it is made and ends when the meeting does."""
        q = asyncio.Queue()
        entry = (q, {"to_me": to_me, "trusted": trusted, "from_admin": from_admin, "kinds": kinds})
        self._queues.append(entry)
        return self._drain(q, entry)

    async def _drain(self, q, entry):
        try:
            while True:
                item = await q.get()
                if item is None:
                    return
                yield item
        finally:
            if entry in self._queues:
                self._queues.remove(entry)

    async def people(self):
        return (await self.call("people")).get("people")

    async def state(self):
        return (await self.call("state")).get("state")

    async def chat(self, text):
        return await self.call("chat", {"text": str(text)})

    async def hand(self, up=True):
        return await self.call("hand", {"up": bool(up)})

    async def stage_ask(self):
        return await self.call("stage.ask")

    async def stage_leave(self):
        return await self.call("stage.leave")

    async def transcript(self, since=0):
        """The room's lines this seat already holds (chat, captions, the agent's own spoken lines), newest last."""
        return (await self.call("lines", {"since": since})).get("lines") or []

    async def say(self, text, interrupt="stop", wait=True):
        """Say text aloud. The page plays the voice and writes the text as this agent's own spoken line (captioned from
        the text, not from speech). The voice: the tts given to join() (text -> WAV bytes, or (pcm, rate)), else the
        Node seat's own (kokoro-js installed beside it). Waits until it has played (or was stopped) unless wait=False;
        returns {"id", "ms", "stopped"?}. interrupt="never" keeps talking when someone talks over it."""
        text = str(text)
        args = {"text": text, "interrupt": interrupt}
        if self._tts is not None:
            v = self._tts(text)
            if inspect.isawaitable(v):
                v = await v
            wav = v if isinstance(v, (bytes, bytearray)) else to_wav(v[0], v[1])
            args["wav"] = base64.b64encode(bytes(wav)).decode("ascii")
        # listen before calling: a short clip can end before the answer to the call reaches us
        ended, waiters = {}, {}

        def done(d):
            if not isinstance(d, dict) or not d.get("id"):
                return
            fut = waiters.pop(d["id"], None)
            if fut and not fut.done():
                fut.set_result(d)
            else:
                ended[d["id"]] = d
        off = self.on("say.done", done)
        try:
            r = await self.call("say", args)
            if not wait:
                return r
            if r.get("id") in ended:
                return dict(r, **ended[r["id"]])
            fut = asyncio.get_running_loop().create_future()
            waiters[r.get("id")] = fut
            return dict(r, **(await fut))
        finally:
            off()

    async def stop_saying(self):
        return await self.call("say.stop")

    async def audio_in(self, who="room", rate=16000):
        """Open the room's sound (who="room") or one person's own voice where this seat holds it. Returns an async
        iterator of 20 ms frames; close() it (or use "async with") when done. Subscribing marks the agent as taking notes."""
        r = await self.call("audio.in.open", {"who": who, "rate": rate})
        port = _AudioIn(self, r.get("port"), r)
        self._ports[port.id] = port
        for f in self._unclaimed.pop(port.id, []):
            port._push(f)
        return port

    async def leave(self):
        """Leave the meeting (the goodbye goes out first), then end the seat process."""
        if not self.closed:
            try:
                await self._send({"call": "leave"})
            except MeetingError:
                pass
        self._finish()
        try:
            await asyncio.wait_for(self._proc.wait(), 10)
        except asyncio.TimeoutError:
            self._proc.terminate()
            await self._proc.wait()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self.leave()


async def join(url, name=None, owner=None, core=False, password=None, relay=None, profile=None, join_ms=None, command=None, core_keys=None, tts=None, voice=None):
    """Join a meeting and return its Meeting once the seat is in. The Node seat drives the meeting page in a Chrome or
    Edge already on this computer (or a Chromium installed for Playwright; GIFOS_CHROME names one). The name must say
    whose agent it is ("Ada (Sam's assistant)", or name="Ada", owner="Sam"). A room with a password raises
    MeetingError: ask your human for it and pass password=. tts: text -> WAV bytes or (pcm, rate), sync or async, the
    voice of say(); without it the Node seat's own voice (kokoro-js) is used; voice=False turns that off.
    core=True (joining with no browser) is not available yet: the seat refuses it with a sentence, raised as
    MeetingError. core_keys: public keys (base64) to trust for a core you signed yourself, once core mode ships."""
    proc = await asyncio.create_subprocess_exec(*(command or bridge_command()), stdin=asyncio.subprocess.PIPE,
                                                stdout=asyncio.subprocess.PIPE, limit=16 * 1024 * 1024)
    meet = Meeting(proc, tts=tts)
    opts = {"name": name, "owner": owner, "core": bool(core), "password": password, "relay": relay, "profile": profile, "joinMs": join_ms, "coreKeys": list(core_keys) if core_keys else None, "voice": voice}
    try:
        r = await meet._send({"join": url, "opts": {k: v for k, v in opts.items() if v is not None}})
    except MeetingError:
        meet._finish()
        if proc.returncode is None:
            proc.terminate()
        await proc.wait()
        raise
    meet.core = bool(r.get("core"))
    return meet
