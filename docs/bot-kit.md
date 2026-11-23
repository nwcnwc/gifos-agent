# Run your own GifOS meeting bot

The bot kit (`@gifos-app/agent/kit`) runs an interactive bot in a GifOS meeting from one config file. You choose its
first name, what it says about itself, its prompt and rules, its limits, its brain (any LLM, or none), its voice (any
speech service, on-device, or none) and its animated avatar. It runs at your own meeting link, on your own computer,
with your own accounts.

The bot is a person on stage like anyone else. It joins through the same meeting page, solves the same proof of work,
and follows every room rule: passwords, the host's orders, slow mode, blur and consent. The kit needs no GifOS
account, key or pass. A plan (if you want a hosted room) is yours, bought like anyone's.

## 1. Install

```sh
npm install @gifos-app/agent      # Node 20+, and Chrome, Edge or a Playwright Chromium on the computer
npm install kokoro-js             # only for the on-device voice
```

## 2. Write the config

`my-bot.bot.json`:

```json
{
  "name": "Ada",
  "declaration": "Sam's bot",
  "link": "https://gifos.app/meet/sams-room",
  "prompt": {
    "system": "You are {name}, the bot in Sam's book club. Be warm and brief.",
    "guardrails": ["Stay on the book club.", "Never ask for personal details."],
    "knowledge": ["https://example.com/book-club.txt"],
    "allowed_hosts": ["example.com"]
  },
  "limits": { "replies_per_min": 6, "per_person_s": 8, "max_reply_chars": 300, "greet_every_s": 12 },
  "brain": { "provider": "openai", "base_url": "http://127.0.0.1:11434/v1", "model": "qwen2.5:7b" },
  "voice": { "provider": "none" },
  "avatar": { "enabled": true, "set": "blob" },
  "greet": { "enabled": true, "text": "Welcome, {names}! I'm {name}, a bot. Ask me anything." },
  "answer": "mention"
}
```

| Field | Meaning |
|---|---|
| `name` | One first name. The room shows `name (declaration)`, e.g. "Ada (Sam's bot)". |
| `declaration` | What the bot says it is, in the brackets after its name. Saying it is a bot is the honest default. |
| `link`, `password_env` | The meeting link. A locked room's password comes from the named environment variable, never the file. `GIFOS_BOT_LINK` overrides `link` (one config, many rooms). |
| `prompt.system`, `guardrails` | Who the bot is and its rules. `{name}` is filled in. |
| `prompt.knowledge` | URLs of plain text the bot answers from. Fetched at start and every `refresh_min` minutes, so answers follow the source. Only the sections that bear on a question go to the LLM. |
| `prompt.allowed_hosts` | Links in replies are kept only on these hosts. |
| `limits` | `replies_per_min` (whole room), `per_person_s` (cooldown per person), `max_reply_chars` (cut at a sentence end), `max_say_chars`, `greet_every_s`, `reply_timeout_s`, `bot_turns` (lines in a row from other bots it will answer). |
| `answer` | `mention`: answer lines that say its name. `questions`: also any line ending in `?` (while it leads). |
| `rank`, `siblings` | Several copies of one bot in a room: `{"Leo": 1}`. The lowest rank present greets and answers questions; a line naming a bot is answered by that bot. Siblings are matched by name among seats the page flags as bots. |
| `brain`, `voice`, `avatar`, `greet` | Below. |

Secrets never go in the config: the loader refuses `key`, `api_key`, `token`, `secret` and `password` fields. Name an
environment variable (`key_env`) or a file outside your repo (`key_file`, e.g. mode 0600).

## 3. Brain

| `provider` | What |
|---|---|
| `fixed` (default) | No LLM: a hello for hellos, else the best-matching section of `knowledge`, else `fallback`. Free and instant. |
| `openai` | Any OpenAI-compatible `/chat/completions`. Set `base_url`, `model`, and `key_env` when the server needs a key. |

`openai` examples:
- OpenAI: `"base_url": "https://api.openai.com/v1", "model": "gpt-4o-mini", "key_env": "OPENAI_API_KEY"`
- Ollama on your computer: `"base_url": "http://127.0.0.1:11434/v1", "model": "qwen2.5:7b"` (free; `ollama pull qwen2.5:7b`)
- Ollama cloud: `"base_url": "https://ollama.com/v1", "model": "<a cloud model>", "key_env": "OLLAMA_API_KEY"`
- OpenRouter, Groq, llama.cpp `llama-server`: their `/v1` URL and model name.

Every reply goes through the limits: rate, cooldown, length, timeout (then `fallback`), and an output filter that
drops links off `allowed_hosts` and never asks anyone for personal data.

## 4. Voice

`say()` stops by itself when someone starts talking. The bot speaks only when nobody is talking; otherwise, when it
has no voice, or when it is cut off, it writes the answer in chat.

| `provider` | Cost | Notes |
|---|---|---|
| `none` (default) | free | chat only |
| `openai` | OpenAI `gpt-4o-mini-tts`: $0.60 per 1M input tokens + $12 per 1M audio tokens (OpenAI says about 1.5 cents a minute); `tts-1`: $15 per 1M characters | Any OpenAI-compatible `/audio/speech`. Set `base_url`, `model`, `voice`, `key_env`. Asks for raw 24 kHz PCM. |
| `openai` on Ollama | free | Ollama 0.40.11+ serves `/v1/audio/speech` with the `phonon` model, on macOS for now (not yet Linux or Windows). `"base_url": "http://127.0.0.1:11434/v1", "model": "phonon"`. |
| `kokoro` | free, on device | `npm i kokoro-js`. Needs about 400 MB more memory per bot; the first use downloads 92 MB of weights. `"voice": "af_heart"`. |
| `espeak` | free, tiny | `espeak-ng` installed; robotic. |

Check the provider's own pricing page before you turn on a paid voice. A greeting is about 100 characters; a busy hour
of a talkative bot is a few thousand.

## 5. Avatar

With `"avatar": { "enabled": true }` the bot's camera is a drawn animation, sent through the SDK's `video.out`. The
room treats it as any camera, so rooms without a password blur it. The states are built to read through that blur:

| State | Shape | Colour | Motion |
|---|---|---|---|
| speaking | big disc with a mouth | orange | swells with the voice level; the mouth opens with each syllable |
| listening (someone else talks) | big ear | teal | sound rings ripple into the ear |
| idle | disc with eyes | grey-blue | slow breathing |

Fine detail (eyes, mouth) shows in password rooms, where video is clear.

Cost: 160x120 at 6 fps while speaking or listening, 1 frame a second when idle. Drawing a frame takes well under a
millisecond of CPU; the browser's video encoder is the larger cost (see the measured numbers in the GifOS welcome
guide example).

Swap the look: `"set": "./my-avatar.js"`, a module that exports
`frame(state, tMs, level, width, height, rgba)` and paints one RGBA frame (`kit/avatars/blob.js` is the reference).

## 6. Run

```sh
export OPENAI_API_KEY=...             # only if your brain or voice needs it
npx gifos-bot my-bot.bot.json         # Ctrl-C leaves the meeting
```

From code:

```js
import { loadConfig, runBot } from '@gifos-app/agent/kit';
const bot = await runBot(loadConfig('my-bot.bot.json'));
```

The bot logs one JSON line per event (joined, greeting, reply, said, chatted) and, every minute, its frames, memory
and CPU.

## 7. Host it well

- One bot per room is simplest. For two, give them `rank` and `siblings`.
- A hosted (private) room: create it in GifOS with your own plan and host password, and give the bot the room link.
  A room password goes in an environment variable named by `password_env`.
- Keep `max_reply_chars` short: people read chat and hear speech in a live room.
- The bot hears what the room's AI notes setting allows. In a hosted room the host decides.

## Works with core mode

The kit uses only the SDK's public calls (`join`, `lines`, `people`, `speaking`, `say`, `chat`, `video.out`), so it
runs unchanged when the SDK joins without a browser. Until core mode carries voice and video, a core seat answers in
chat and shows no avatar.
