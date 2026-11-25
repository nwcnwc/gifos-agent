# gifos-agent

The GifOS Meet agent SDK: join a GifOS meeting and take part as an AI agent
(text, speech and video), driving a real GifOS meeting page.

Status: early development. The Node package is on npm as `@gifos-app/agent`; the Python package is
PyPI `gifos-agent` (in `python/`, see its README). Python drives a Node seat over JSON lines (`gifos-agent-stdio`).

This SDK is MIT licensed (see LICENSE). The GifOS service, the gifos.app website and the meeting page it
drives are not part of it and remain Crowd Concepts, Inc.'s.

## Node: `@gifos-app/agent`

The meeting page itself holds the agent API (`window.gifosAgent`, version 1). This package is a thin
transport over it: it opens the GifOS meeting page in agent mode in a browser already on your computer
(Chrome, Edge, or a Chromium you installed for Playwright; it never downloads one) and carries the
page's events and actions. The page keeps every room rule: proof of work, passwords, the host's orders,
slow mode, blur and consent.

### Install

```sh
npm install @gifos-app/agent             # Node 20+
npm install kokoro-js                    # optional: the default voice for say() (downloads its model on first use)
```

It needs a Chrome or Edge on the computer. With neither, run `npx playwright install chromium` once, or set
`GIFOS_CHROME` to a Chrome or Chromium binary. It never downloads a browser by itself.

```js
import { join } from '@gifos-app/agent';
import { ask } from './my-llm.js';

const meet = await join('https://gifos.app/meet#room=abc', { name: "Ada (Sam's assistant)" });
const history = [];
for await (const line of meet.lines({ toMe: true, trusted: true })) {
  history.push({ role: 'user', content: `${line.name}: ${line.text}` });
  const reply = await ask(history);
  history.push({ role: 'assistant', content: reply });
  await meet.say(reply);              // stops by itself if someone talks over it
}
```

The room name rides in the part after #, which browsers never send to a server, so it never reaches GifOS's servers or logs. The simple public forms, gifos.app/meet/<room> and gifos.app/meet/<room>/<verifier> (hosted), work forever and are fine for links you write by hand, like gifos.app/meet/welcome; they put the room name in the address a server sees.

### Core mode

Opt-in for now: set `GIFOS_CORE_MODE=1` in the environment of the process that joins (without it, `core: true` is
refused with a sentence). It stays opt-in while one known media gap is open: in a room whose chain of Node seats runs
deep, a deep seat's mix can miss one Section-1 row's voice. Browser seats are not affected.

`join(url, { core: true, ... })` runs the meeting's GifOS-signed core in a sandboxed child process (no browser). Needs
Node 22 or later. Only a core signed by GifOS runs; see [docs/core-trust.md](docs/core-trust.md). Voice, ears and
pictures go through the core's Node media plane. The seat takes its row's duties like any seat. It has no camera of
its own yet: `video.out` answers that it cannot make a camera with no browser.

More in `examples/`:
- `echo-bot.mjs <link>`: runnable, no model or keys; answers chat, speaks, raises its hand, reports frame stats, leaves on "leave". Needs `espeak-ng`.
- `core-bot.mjs <link>`: same idea with `{ core: true }` (Node 22+; no browser).
- `claude-assistant.mjs <link>`: runnable; answers with Claude. Needs `npm i @anthropic-ai/sdk`, `ANTHROPIC_API_KEY`, and a voice (see below).
- `join-and-talk.mjs`, `watch-and-react.mjs`: sketches; bring your own `ask()` / vision.
- `shell-bridge.mjs` (`gifos-agent-bridge`): for agents with a shell, see below.

### If you are an AI agent with a shell (Claude Code, Codex and the like)

You are the language model, so there is no `ask()` to write: keep ONE Node process in the meeting and talk to it
through files. `gifos-agent-bridge` (examples/shell-bridge.mjs, installed with the package) is that process:

```sh
npx gifos-agent-bridge https://gifos.app/meet#room=abc --name "Ada (Sam's assistant)" --dir ./meeting > bridge.log 2>&1 &
npx gifos-agent-bridge next --dir ./meeting                       # waits for the next line said TO YOU, prints it
echo '{"do":"chat","text":"391"}' >> ./meeting/commands.jsonl     # results come back in ./meeting/results.jsonl
```

Loop on `next`: wait for the next request, do it, run `next` again. That keeps you in the meeting for as long as
the person needs you (a `next` with nothing new exits after `--wait` seconds, default 100, under a shell tool's usual 2-minute limit: just run it again).
Everything else that happens (people, hand, stage, video, left) is in `./meeting/events.jsonl`.

Commands: `chat`, `say` (needs a voice), `hand`, `stage`, `unstage`, `camera` (a JPEG file as your video),
`look` (save one frame of someone's camera as a JPEG you can open), `people`, `leave`. Do not end
your turn while the person still needs you: the meeting goes on without you reading it. The bridge leaves the
meeting when its process exits. A locked room's password comes from your human, never a guess.

### What you get
- `join(url, { name, owner?, tts?, password?, profile? })`: the name must say whose agent it is
  ("Ada (Sam's assistant)"). A password is never guessed: without one, a locked room is an error to show your human.
  `chromium`: a Playwright `chromium` you already load, to drive your own Playwright install.
- `meet.lines({ toMe, trusted, fromAdmin, kinds })`: an async iterator of lines (speech, chat), each with the
  speaker, `trust` (`own`, `trusted`, `unchecked`, `distrusted`: captions are claims, not facts) and `toMe`.
- `meet.on(event, fn)`: `joined`, `people`, `speaking`, `line`, `hand`, `stage`, `agenda`, `video`, `app`, `host`, `left`.
- Actions: `say`, `chat`, `hand`, `mic`, `stage.ask/leave`, `app.run/stop/room`, `agenda.next/set`, `profile`,
  `leave`. Each resolves, or rejects with the page's own sentence.
- Ports: `audio.out.open({rate})` (PCM16 in), `audio.in.open({who:'room', rate})` (PCM16 frames out),
  `video.in.open({who, fps, width})` (JPEG frames, blurred as the room blurs them; nothing is decoded until you
  open one), `video.out.open({width, height, fps})` (your agent's camera, under the same blur and consent rules).
- `meet.tools()`: the actions as JSON-schema tools for any LLM loop.

`say` needs a voice: install `kokoro-js` for the default one, or pass `tts: async (text) => ({ pcm, rate })` (or
`({ wav })`, for example from `espeak-ng -w`). Without one, `say` rejects with "No voice": answer in chat instead.

Subscribing to lines or room audio marks the agent's tile "taking notes". In a hosted meeting the host's
"AI notes" setting (allowed / ask / off) is obeyed by the page.

## Python: `gifos-agent`

```sh
pip install gifos-agent
npm install -g @gifos-app/agent      # the seat it drives (Node 22+)
```

```python
from gifos_agent import join
async with await join("https://gifos.app/meet#room=abc", name="Ada", owner="Sam") as meet:
    async for line in meet.lines(to_me=True):
        await meet.chat("You said: " + line["text"])
```

Browser mode, as in Node: chat, lines, `transcript()`, people, hand, the Stage, apps, `say()` (with a `tts=` of your
own or the seat's kokoro-js) and `audio_in()` (the room's sound as PCM frames). Details: `python/README.md`.

`gifos-agent-stdio` (src/stdio.js) is the seat for any other language too: one JSON object per line in and out
(the protocol is in the file's header).

Tests: `npm test`; `python3 -m unittest discover -s python/tests`.
