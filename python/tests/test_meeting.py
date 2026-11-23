"""The Python seat against a stand-in bridge that speaks gifos-agent-stdio's JSON lines (no meeting, no network).
Run: python3 -m unittest discover -s python/tests"""
import asyncio
import os
import sys
import textwrap
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from gifos_agent import join, MeetingError  # noqa: E402

FAKE = textwrap.dedent(r'''
    import json, sys
    def out(o): sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
    for raw in sys.stdin:
        m = json.loads(raw)
        if "join" in m:
            if m["opts"].get("name") == "NoOwner":
                out({"id": m["id"], "ok": False, "error": "The name must say whose agent it is."}); continue
            out({"id": m["id"], "ok": True, "core": m["opts"].get("core"), "state": {"joined": True}})
        elif m.get("call") == "chat":
            out({"id": m["id"], "ok": True, "answer": {"ok": True, "id": "m_1", "held": False}})
            out({"event": {"type": "line", "data": {"name": "Ada", "text": "hello", "toMe": False}}})
            out({"event": {"type": "line", "data": {"name": "Ada", "text": "for you", "toMe": True}}})
        elif m.get("call") == "people":
            out({"id": m["id"], "ok": True, "answer": {"ok": True, "people": [{"name": "Ada"}, {"name": "Pyra"}]}})
        elif m.get("call") == "leave":
            out({"id": m["id"], "ok": True}); out({"event": {"type": "left", "data": {"reason": "leave"}}}); break
        else:
            out({"id": m["id"], "ok": False, "error": "No such call: " + str(m.get("call"))})
''')


class MeetingTest(unittest.TestCase):
    def run_async(self, coro):
        return asyncio.run(coro)

    def test_join_calls_lines_leave(self):
        async def go():
            meet = await join("https://example.invalid/meet/x", name="Pyra", owner="Sam", command=[sys.executable, "-c", FAKE])
            self.assertTrue(meet.core)
            async def first_to_me():
                async for line in meet.lines(to_me=True):
                    return line["text"]
            waiter = asyncio.ensure_future(first_to_me())
            await asyncio.sleep(0)                      # lines() listens from now on
            r = await meet.chat("hi")
            self.assertEqual(r["id"], "m_1")            # the page's own id survives (the call id is the envelope's)
            self.assertEqual(await asyncio.wait_for(waiter, 5), "for you")   # the line not to me was filtered out
            self.assertEqual([p["name"] for p in await meet.people()], ["Ada", "Pyra"])
            with self.assertRaises(MeetingError) as e:
                await meet.call("nope")
            self.assertIn("No such call", str(e.exception))
            with self.assertRaises(MeetingError):
                await meet.say("hi")                   # core mode has no voice yet
            await meet.leave()
            self.assertTrue(meet.closed)
        self.run_async(go())

    def test_join_refused_raises_the_sentence(self):
        async def go():
            with self.assertRaises(MeetingError) as e:
                await join("https://example.invalid/meet/x", name="NoOwner", command=[sys.executable, "-c", FAKE])
            self.assertIn("whose agent", str(e.exception))
        self.run_async(go())


if __name__ == "__main__":
    unittest.main()
