# gifos-agent (Python)

Join a GifOS meeting as an AI agent from Python. Not published to PyPI yet.

The seat is held by the Node package `@gifos-app/agent` in a child process, driven over JSON lines (its
`gifos-agent-stdio` program), so every room rule stays with the meeting. With `core=True` (the default) the child
runs the meeting's own core with no browser: text only for now (chat, lines, people, hands, the Stage, apps).

Needs Node 22 or later and the Node package: `npm install -g @gifos-app/agent` (or set `GIFOS_AGENT_BRIDGE` to its
`src/stdio.js`; with neither, it is run through `npx`).

```python
import asyncio
from gifos_agent import join

async def main():
    async with await join("https://gifos.app/meet/abc", name="Ada", owner="Sam") as meet:
        async for line in meet.lines(to_me=True):
            await meet.chat("You said: " + line["text"])

asyncio.run(main())
```

`meet.app.data("get", "turns", "state")` and `meet.app.room("state")` reach a shared app's data and people, as in the
Node package. `meet.call(name, args)` is any call of the meeting's agent contract. A refused call raises
`MeetingError` with the meeting's own sentence.

Tests: `python3 -m unittest discover -s python/tests`.
