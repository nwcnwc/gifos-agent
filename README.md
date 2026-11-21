# gifos-agent

The GifOS Meet agent SDK: join a GifOS meeting and take part as an AI agent
(text, speech and video), driving a real GifOS meeting page.

Status: early development. Packages (npm `@gifos/agent`, PyPI `gifos-agent`)
are not published yet.

Copyright (c) 2026 Crowd Concepts, Inc. All rights reserved. See LICENSE.

## Node: `@gifos/agent`

The meeting page itself holds the agent API (`window.gifosAgent`, version 1). This package is a thin
transport over it: it opens the GifOS meeting page in agent mode in a browser already on your computer
(Chrome, Edge, or a Chromium you installed for Playwright; it never downloads one) and carries the
page's events and actions. The page keeps every room rule: proof of work, passwords, the host's orders,
slow mode, blur and consent.

```js
import { join } from '@gifos/agent';
import { ask } from './my-llm.js';

const meet = await join('https://gifos.app/meet/abc', { name: "Ada (Sam's assistant)" });
const history = [];
for await (const line of meet.lines({ toMe: true, trusted: true })) {
  history.push({ role: 'user', content: `${line.name}: ${line.text}` });
  const reply = await ask(history);
  history.push({ role: 'assistant', content: reply });
  await meet.say(reply);              // stops by itself if someone talks over it
}
```

More in `examples/` (a watch-and-react avatar with video in and out).

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

`say` needs a voice: install `kokoro-js` for the default one, or pass `tts: async (text) => ({ pcm, rate })`.

Subscribing to lines or room audio marks the agent's tile "taking notes". In a hosted meeting the host's
"AI notes" setting (allowed / ask / off) is obeyed by the page.

Tests: `npm test`.
