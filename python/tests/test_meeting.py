"""The Python seat against a stand-in bridge that speaks gifos-agent-stdio's JSON lines (no meeting, no network).
Run: python3 -m unittest discover -s python/tests"""
import asyncio
import base64
import io
import json
import os
import struct
import sys
import textwrap
import unittest
import wave

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from gifos_agent import join, to_wav, MeetingError, __version__  # noqa: E402
from gifos_agent.meeting import _line_matches  # noqa: E402

FAKE = textwrap.dedent(r'''
    import base64, json, struct, sys
    def out(o): sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
    log = []
    for raw in sys.stdin:
        m = json.loads(raw)
        log.append(m)
        if "join" in m:
            if m["opts"].get("name") == "NoOwner":
                out({"id": m["id"], "ok": False, "error": "The name must say whose agent it is."}); continue
            out({"id": m["id"], "ok": True, "core": bool(m["opts"].get("core")), "state": {"joined": True}})
            continue
        c, a = m.get("call"), m.get("args") or {}
        if c == "chat":
            out({"id": m["id"], "ok": True, "answer": {"ok": True, "id": "m_1", "held": False}})
            out({"event": {"type": "line", "data": {"kind": "chat", "name": "Ada", "text": "hello", "toMe": False}}})
            out({"event": {"type": "line", "data": {"kind": "spoken", "name": "Pyra", "text": "my own words", "mine": True, "toMe": True}}})
            out({"event": {"type": "line", "data": {"kind": "chat", "name": "Ada", "text": "for you", "toMe": True}}})
        elif c == "people":
            out({"id": m["id"], "ok": True, "answer": {"ok": True, "people": [{"name": "Ada"}, {"name": "Pyra"}]}})
        elif c == "say":
            # the page's own rule: no WAV, no voice (here the stand-in seat has no text-to-speech of its own)
            if not a.get("wav"):
                out({"id": m["id"], "ok": False, "error": "No voice: pass { tts } to join(), or install kokoro-js."}); continue
            w = base64.b64decode(a["wav"])
            ok = w[:4] == b"RIFF" and w[8:12] == b"WAVE"
            # say.done may come before the call's answer (a short clip on a busy page)
            out({"event": {"type": "say.done", "data": {"id": "say7", "stopped": False}}})
            out({"id": m["id"], "ok": True, "answer": {"ok": True, "id": "say7", "ms": 1000, "wavOk": ok, "text": a.get("text"), "interrupt": a.get("interrupt")}})
        elif c == "audio.in.open":
            out({"id": m["id"], "ok": True, "answer": {"ok": True, "port": "audio.in:3", "rate": a.get("rate"), "who": a.get("who")}})
            for i in range(3):
                pcm = struct.pack("<4h", i, i, i, i)
                out({"event": {"type": "audio.in.frame", "data": {"port": "audio.in:3", "rate": 16000, "ts": i, "pcm": base64.b64encode(pcm).decode()}}})
        elif c == "audio.in.close":
            out({"id": m["id"], "ok": True, "answer": {"ok": True}})
            out({"event": {"type": "port.closed", "data": {"port": a.get("port"), "why": "closed"}}})
        elif c == "lines":
            out({"id": m["id"], "ok": True, "answer": {"ok": True, "lines": [{"kind": "spoken", "text": "Hello", "mine": True}]}})
        elif c == "rights":
            out({"id": m["id"], "ok": True, "answer": {"ok": True, "rights": {"signed": True, "meetings": 3, "agentHost": 0, "label": "room20"}}})
        elif c == "credentials":
            raw = base64.b64decode(a.get("gif_b64") or "")
            out({"id": m["id"], "ok": True, "answer": {"ok": True, "rights": {"signed": True, "meetings": 1, "bytes": raw.decode("ascii")}}})
        elif c == "echo":
            out({"id": m["id"], "ok": True, "answer": {"ok": True, "log": log[:-1]}})
        elif c == "leave":
            out({"id": m["id"], "ok": True}); out({"event": {"type": "left", "data": {"reason": "leave"}}}); break
        else:
            out({"id": m["id"], "ok": False, "error": "No such call: " + str(c)})
''')
CMD = [sys.executable, "-c", FAKE]


def tone(n=480):
    return [int(8000 * ((i % 20) - 10) / 10) for i in range(n)]


class MeetingTest(unittest.TestCase):
    def run_async(self, coro):
        return asyncio.run(coro)

    def test_join_defaults_to_browser_mode(self):
        async def go():
            meet = await join("https://example.invalid/meet#room=x", name="Pyra", owner="Sam", command=CMD)
            self.assertFalse(meet.core)
            log = (await meet.call("echo"))["log"]
            self.assertIs(log[0]["opts"]["core"], False)      # core=False is what goes to the seat
            self.assertEqual(log[0]["opts"]["owner"], "Sam")
            await meet.leave()
        self.run_async(go())

    def test_core_true_joins_through_the_bridge(self):
        async def go():
            meet = await join("https://example.invalid/meet/x", name="Pyra", owner="Sam", core=True, command=CMD)
            self.assertTrue(meet.core)
            log = (await meet.call("echo"))["log"]
            self.assertIs(log[0]["opts"]["core"], True)
            await meet.leave()
        self.run_async(go())

    def test_join_calls_lines_leave(self):
        async def go():
            meet = await join("https://example.invalid/meet#room=x", name="Pyra", owner="Sam", command=CMD)
            async def first(it):
                async for line in it:
                    return line["text"]
            to_me = asyncio.ensure_future(first(meet.lines(to_me=True)))
            spoken = asyncio.ensure_future(first(meet.lines(kinds=["spoken"])))
            r = await meet.chat("hi")
            self.assertEqual(r["id"], "m_1")            # the page's own id survives (the call id is the envelope's)
            self.assertEqual(await asyncio.wait_for(to_me, 5), "for you")   # not to me, and its own spoken line, are skipped
            self.assertFalse(spoken.done())             # its own words never come back, even asked by kind
            spoken.cancel()
            self.assertEqual([p["name"] for p in await meet.people()], ["Ada", "Pyra"])
            self.assertEqual((await meet.transcript())[0]["text"], "Hello")
            with self.assertRaises(MeetingError) as e:
                await meet.call("nope")
            self.assertIn("No such call", str(e.exception))
            await meet.leave()
            self.assertTrue(meet.closed)
            with self.assertRaises(MeetingError):
                await meet.chat("after leaving")
        self.run_async(go())

    def test_join_refused_raises_the_sentence(self):
        async def go():
            with self.assertRaises(MeetingError) as e:
                await join("https://example.invalid/meet/x", name="NoOwner", command=CMD)
            self.assertIn("whose agent", str(e.exception))
        self.run_async(go())

    def test_no_seat_program_says_what_is_needed(self):
        async def go():
            with self.assertRaises(MeetingError) as e:
                await join("https://example.invalid/meet/x", name="Pyra", owner="Sam", command=["/nonexistent/gifos-agent-stdio"])
            self.assertIn("Node 22", str(e.exception))
            self.assertIn("npm install -g @gifos-app/agent", str(e.exception))
        self.run_async(go())

    def test_seat_that_dies_before_joining_says_what_is_needed(self):
        async def go():
            with self.assertRaises(MeetingError) as e:
                await join("https://example.invalid/meet/x", name="Pyra", owner="Sam", command=[sys.executable, "-c", "import sys; sys.exit(3)"])
            self.assertIn("stopped before joining", str(e.exception))
            self.assertIn("@gifos-app/agent", str(e.exception))
        self.run_async(go())

    def test_say_with_python_tts_waits_for_say_done(self):
        async def go():
            async def tts(text):                       # async tts returning (pcm, rate)
                return tone(), 24000
            meet = await join("https://example.invalid/meet/x", name="Pyra", owner="Sam", command=CMD, tts=tts)
            r = await asyncio.wait_for(meet.say("Hello there", interrupt="never"), 5)
            self.assertEqual(r["id"], "say7")
            self.assertIs(r["stopped"], False)         # say.done reached it though it came before the answer
            self.assertTrue(r["wavOk"])
            self.assertEqual((r["text"], r["interrupt"]), ("Hello there", "never"))
            await meet.leave()
        self.run_async(go())

    def test_say_without_a_voice_raises_the_sentence(self):
        async def go():
            meet = await join("https://example.invalid/meet#room=x", name="Pyra", owner="Sam", command=CMD)
            with self.assertRaises(MeetingError) as e:
                await meet.say("hi")
            self.assertIn("No voice", str(e.exception))
            await meet.leave()
        self.run_async(go())

    def test_audio_in_frames_then_close(self):
        async def go():
            meet = await join("https://example.invalid/meet/x", name="Pyra", owner="Sam", command=CMD)
            ear = await meet.audio_in(rate=16000)
            self.assertEqual(ear.info["who"], "room")
            got = []
            async for f in ear:
                got.append(struct.unpack("<4h", f["pcm"])[0])
                if len(got) == 3:
                    break
            self.assertEqual(got, [0, 1, 2])
            await ear.close()
            self.assertEqual(meet._ports, {})
            await meet.leave()
        self.run_async(go())

    def test_to_wav(self):
        w = to_wav(tone(), 16000)
        with wave.open(io.BytesIO(w)) as r:
            self.assertEqual((r.getnchannels(), r.getsampwidth(), r.getframerate(), r.getnframes()), (1, 2, 16000, 480))
        self.assertEqual(to_wav(struct.pack("<2h", 1, -1), 8000)[-4:], struct.pack("<2h", 1, -1))

    def test_line_filter_matches_the_node_rules(self):
        chat = {"kind": "chat", "text": "x"}
        self.assertTrue(_line_matches(chat))
        self.assertFalse(_line_matches(dict(chat, final=False)))
        self.assertFalse(_line_matches({"kind": "spoken"}))
        self.assertTrue(_line_matches({"kind": "spoken"}, kinds=["spoken"]))
        self.assertFalse(_line_matches(dict(chat, mine=True)))
        self.assertFalse(_line_matches(chat, to_me=True))
        self.assertFalse(_line_matches(chat, from_admin=True))
        self.assertTrue(_line_matches(chat, trusted=True))                 # chat needs no caption trust
        self.assertFalse(_line_matches({"kind": "caption", "trust": "unchecked"}, trusted=True))
        self.assertTrue(_line_matches({"kind": "caption", "trust": "own"}, trusted=True))

    def test_rights_and_use_credentials(self):
        async def go():
            meet = await join("https://example.invalid/meet#room=x", name="Pyra", owner="Sam", command=CMD)
            held = await meet.rights()
            self.assertEqual(held["signed"], True)
            self.assertEqual(held["meetings"], 3)
            self.assertEqual(held["agentHost"], 0)
            blob = b"GIF89a-bytes"
            got = await meet.use_credentials(blob)
            self.assertEqual(got["bytes"], "GIF89a-bytes")
            cred_path = "/tmp/planrights28-py-cred.gif"
            with open(cred_path, "wb") as f:
                f.write(b"from-path")
            try:
                got2 = await meet.use_credentials(cred_path)
                self.assertEqual(got2["bytes"], "from-path")
            finally:
                os.remove(cred_path)
            log = (await meet.call("echo"))["log"]
            calls = [m for m in log if m.get("call") in ("rights", "credentials")]
            self.assertEqual([m["call"] for m in calls], ["rights", "credentials", "credentials"])
            self.assertEqual(calls[1]["args"]["gif_b64"], base64.b64encode(blob).decode("ascii"))
            self.assertEqual(calls[2]["args"]["gif_b64"], base64.b64encode(b"from-path").decode("ascii"))
            await meet.leave()
        self.run_async(go())

    def test_version_matches_pyproject(self):
        here = os.path.join(os.path.dirname(__file__), "..", "pyproject.toml")
        with open(here) as f:
            self.assertIn('version = "%s"' % __version__, f.read())


if __name__ == "__main__":
    unittest.main()
