# gifos-agent (Python)

Join a GifOS meeting as an AI agent from Python: read and write chat, follow the room's lines, see who is there,
raise a hand, speak aloud, and hear the room.

```sh
pip install gifos-agent
npm install -g @gifos-app/agent     # the Node seat this package drives (Node 22 or later)
```

## How it works

The seat is held by the Node package [`@gifos-app/agent`](https://www.npmjs.com/package/@gifos-app/agent) in a
child process (its `gifos-agent-stdio` program), driven over JSON lines. That seat opens the real GifOS meeting page
in agent mode in a browser already on this computer, so every room rule stays with the meeting: proof of work,
passwords, the host's orders, slow mode, blur and consent. This package has no dependencies beyond the Python
standard library.

What it needs:

- Python 3.9 or later.
- Node 22 or later, and the Node package. The seat is found in this order:
  1. `GIFOS_AGENT_BRIDGE`: a path to the Node package's `src/stdio.js` (run with `node`, or `GIFOS_NODE`);
  2. `gifos-agent-stdio` on `PATH` (`npm install -g @gifos-app/agent` puts it there);
  3. otherwise `npx --yes -p @gifos-app/agent gifos-agent-stdio` (downloads it on first use).
- A Chrome or Edge on the computer. With neither, run `npx playwright install chromium` once, or set
  `GIFOS_CHROME` to a Chrome or Chromium binary. Nothing downloads a browser by itself.

## Example

```python
import asyncio
from gifos_agent import join

async def main():
    async with await join("https://gifos.app/meet#room=abc", name="Ada", owner="Sam") as meet:
        await meet.chat("Hello, I'm Ada, Sam's assistant.")
        async for line in meet.lines(to_me=True):
            await meet.chat("You said: " + line["text"])

asyncio.run(main())
```

The room name rides in the part after #, which browsers never send to a server, so it never reaches GifOS's servers or logs. The simple public forms, gifos.app/meet/<room> and gifos.app/meet/<room>/<verifier> (hosted), work forever and are fine for links you write by hand, like gifos.app/meet/welcome; they put the room name in the address a server sees.

The name must say whose agent it is: `name="Ada (Sam's assistant)"`, or `name="Ada", owner="Sam"`. A room with a
password raises `MeetingError`: ask your human for it and pass `password=`; never guess it.

## What you get

- `await join(url, name=, owner=, password=, tts=, ...)` returns a `Meeting` once the seat is in.
- `meet.lines(to_me=, trusted=, from_admin=, kinds=)`: an async iterator of lines from now on (chat, others'
  captions), each with the speaker, `kind`, `toMe` and `trust` (`own`, `trusted`, `unchecked`, `distrusted`:
  captions are claims, not facts). Its own words never come back.
- `meet.transcript()`: the lines the seat already holds, its own spoken lines included.
- `meet.chat(text)`, `meet.hand(up)`, `meet.stage_ask()`, `meet.stage_leave()`, `meet.people()`, `meet.state()`,
  `meet.app.run(id)`, `meet.app.data(...)`, `meet.app.room(...)`.
- `meet.say(text)`: speaks aloud. The page plays the voice and writes the text as the agent's own spoken line.
  The voice comes from `tts=` given to `join()` (a function, plain or async, from text to WAV bytes or to
  `(pcm, rate)`; `to_wav(pcm, rate)` helps), else from the Node seat's own voice (`npm install -g kokoro-js` beside
  it). Without either, `say()` raises "No voice": answer in chat instead. It waits until the clip has played.
- `meet.audio_in()`: the room's sound as this seat hears it, as 20 ms frames of 16-bit mono PCM
  (`async for frame in ear: frame["pcm"]`); `close()` it when done. Hearing marks the agent as taking notes, and a
  host's "AI notes" setting is obeyed.
- `meet.on(event, fn)`: `joined`, `people`, `speaking`, `line`, `hand`, `stage`, `app`, `host`, `left`, ...
- `meet.call(name, args)`: any call of the meeting's agent contract. A refused call raises `MeetingError` with the
  meeting's own sentence, ready to show a person.
- `meet.leave()` (or leaving the `async with` block) says goodbye and ends the seat.

### Host a broadcast and play films to its Stage

- `join(link, host_password=...)`: the seat hosts the link's hosted room. It holds the room's host key the way the
  page keeps it after "Host a private meeting"; the password stays on this computer. A link with no `v=` gets this
  password's room, and `meet.link` is the room's full link either way.
- `listed=`: the room's gifos.tv listing address (from "Publish to GifOS.tv"). The page keeps the listing live while
  this seat hosts the room. `credentials=`: a pass or subscription file, used before the seat knocks.
- `film = await meet.stage_play(path, start_at=0, clear=False)`: plays a video file (WebM or MP4) to the Stage with the
  page's own Rebroadcast sheet, from a broadcast page (`https://gifos.app/cast#room=...`). It returns once the film
  moves; `await film["ended"]` gives `{"pos", "len", "early", "why"}` when it stops. `clear=True` picks "No blur"
  whenever the room offers it to a rebroadcast's host. `meet.stage_playing()` and `meet.stage_stop()` read and stop it.
- `examples/tv_channel.py`: a 24/7 channel (a playlist, played forever, following GifOS releases).

Joining with no browser (`core=True`) is opt-in for now: set `GIFOS_CORE_MODE=1` in the environment (the bridge
inherits it); without it the seat refuses with a sentence, raised as `MeetingError`. It runs through `gifos-agent-stdio`'s core transport (the meeting's
GifOS-signed core in a sandboxed child; Node 22+). Same contract as browser mode for chat, lines, voice, ears and
pictures; the seat has no camera of its own yet.

`say()` with no `tts=` and `audio_in()` need `@gifos-app/agent` 0.2.1 or later; `host_password=`, `listed=`,
`credentials=` and the `stage_*` calls need 0.4.0 or later.

## Tests

`python3 -m unittest discover -s python/tests` (from the repository root; no network, no meeting).

MIT licensed. The GifOS service, the gifos.app website and the meeting page are not part of this package.
