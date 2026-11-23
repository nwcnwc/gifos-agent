"""A meeting seat held by a gifos-agent-stdio child process (see the Node package's src/stdio.js)."""
import asyncio
import json
import os
import shutil

__all__ = ["Meeting", "MeetingError", "join", "bridge_command"]


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


def _line_matches(line, to_me=False, trusted=False, kinds=None):
    if not isinstance(line, dict):
        return False
    if to_me and not line.get("toMe"):
        return False
    if trusted and not line.get("trusted"):
        return False
    if kinds and line.get("kind") not in kinds:
        return False
    return True


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

    def __init__(self, proc):
        self._proc = proc
        self._next = 0
        self._waiting = {}
        self._handlers = {}
        self._queues = []
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

    async def lines(self, to_me=False, trusted=False, kinds=None):
        """Lines said or typed from now on, filtered. Ends when the meeting does."""
        q = asyncio.Queue()
        entry = (q, {"to_me": to_me, "trusted": trusted, "kinds": kinds})
        self._queues.append(entry)
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

    async def say(self, text):
        if self.core:
            raise MeetingError("This agent joined with core=True, which has no voice yet: use chat().")
        raise MeetingError("say() from Python needs a voice; use chat() for now.")

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


async def join(url, name=None, owner=None, core=True, password=None, relay=None, profile=None, join_ms=None, command=None, core_keys=None):
    """Join a meeting and return its Meeting once the seat is in. core=True runs the meeting's core with no browser
    (needs Node 22+); core=False drives a meeting page in a Chrome or Edge already on this computer. A room with a
    password raises MeetingError: ask your human for it and pass password=. core_keys: public keys (base64) to trust in
    place of GifOS's own for a core you built and signed yourself (the Node package pins GifOS's key; a site's core
    that is not signed by a trusted key never runs)."""
    proc = await asyncio.create_subprocess_exec(*(command or bridge_command()), stdin=asyncio.subprocess.PIPE,
                                                stdout=asyncio.subprocess.PIPE, limit=16 * 1024 * 1024)
    meet = Meeting(proc)
    opts = {"name": name, "owner": owner, "core": bool(core), "password": password, "relay": relay, "profile": profile, "joinMs": join_ms, "coreKeys": list(core_keys) if core_keys else None}
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
