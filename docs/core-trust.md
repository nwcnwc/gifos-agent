# Core mode: which code runs on the agent's computer

`join(url, { core: true })` runs the GifOS meeting core in the agent's own Node process, loaded from the meeting's
site. A meeting link is untrusted input: anyone can paste a link into a chat that an agent reads. Before this change
the SDK fetched `<origin>/js/core/node.js` and ran it with `vm.runInThisContext` and a `require` that allowed every Node
built-in module, so a hostile site could read and write files and start programs on the agent's computer.

Two rules now hold. The first is the boundary; the second limits the damage if the first ever fails.

## 1. Only a core signed by GifOS runs

- At release, the GifOS signer signs the core: `js/core/core.sig.json` on the site lists every file of the core
  (`js/core/node.js`, `files.json`, `platform.json`, `media/nones.json` and every script `files.json` names) with its
  SHA-256, and carries an Ed25519 signature over that list. The key is the gifos.app domain key (the one that signs
  store apps; its public half is `https://gifos.app/gifos.key`). The private key stays on the signer's machine.
- The SDK pins the public key in its own code (`src/core-trust.js`). It never takes a key from the site: a hostile
  site would serve its own key.
- Before anything runs, the SDK fetches `core.sig.json`, checks the signature against the pinned key, then fetches
  each file and checks its hash. A file that is not in the signed list is never fetched for running; a file whose hash
  differs stops the join. Only then does the host start.
- The signed bytes are `gifos-core-sig-v1\n`, then `build <build>\n`, then one line per file, sorted by path:
  `<sha256 hex>  <path>\n`. Paths are plain site paths (`js/...`, no spaces, no `..`), so no line can be forged.
  Hashes are of the bytes as served. The list is capped (256 KB, 400 files, 8 MB a file) before it is read.
- The SDK fetches each file once, checks it, and hands the host a loader that serves only those checked bytes: a path
  outside the signed list answers 404, so `files.json` can name only signed files, and nothing is fetched again
  between the check and the run. The core loads no code at run time (no eval, no `import()`; a script element
  throws, as there is no page); what it fetches while it runs is data.
- Any site may serve a signed core (a mirror, a self-hosted relay): trust comes from the signature, not the origin.
- An unsigned site, a bad signature or a changed file fails the join with one plain sentence, for example
  "This site's GifOS core is not signed by GifOS, so it will not run on this computer. Join without { core: true }
  to use a browser instead." Core mode stays opt-in (`core: true`).
- The operator (never the link) can trust another key with `join(url, { core: true, coreKeys: [base64 key] })`, for
  a self-built core or a test. It replaces the pinned list.
- Replay: the SDK pins a minimum build (`MIN_CORE_BUILD`, 0.9.28 now) and refuses an older signed core.
- Key rotation: the pinned keys are a list; a new key ships in an SDK release before cores are signed with it.

## 2. The core runs in a child process that Node's permission model holds

A Node `vm` context is not a security boundary: any host object handed to it (a timer, `fetch`, a class) leads back
to the host's `Function` and from there to `process`. So the core runs in its own Node process, started by the SDK as

    node --permission --allow-fs-read=<src/core-child.cjs> --allow-fs-read=<the node_modules root werift resolves in> \
         --max-old-space-size=1024 src/core-child.cjs

  started with `fork(..., { env: {}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json' })` and its own
  `execArgv` (not the parent's).

- No file writes, no child processes, no worker threads, no native addons, no WASI, no inspector (Node's permission
  model refuses them with `ERR_ACCESS_DENIED`). File reads only of the child script and the folder werift and its
  dependencies sit in (werift is required by its resolved path).
- An empty environment: API keys and other secrets in the agent's environment never reach the core, and
  `NODE_OPTIONS` cannot loosen the flags.
- The child has no stdin and its stdout and stderr go to the SDK's log: under `gifos-agent-stdio` (the Python
  package) and an MCP server, this process's stdout is a protocol channel the core cannot write to.
- Signals are not covered by the permission model, so the child replaces `process.kill` before the host runs.
- Known limit: the network stays open. The core needs the meeting's relay (WebSocket), its site (fetch) and WebRTC
  (UDP), and Node's permission model does not restrict sockets, so a core could reach this computer's local network.
  The signature is what keeps a hostile core from running at all.
- The agent's profile (its person key, in `core-storage.json`) is written by the parent: the child sends storage
  changes over the IPC channel. The child is handed the profile's contents at start.
- The parent and the child speak the transport's own messages over IPC: `call(name, args)` and its answer, page events,
  `close`. The parent never evaluates anything the child sends; answers are plain JSON.
- Inside the child, the host's `require` hands out only `vm` (the participant's own context), `crypto` (WebCrypto for
  the core's keys and signatures) and `os` (the CPU count a page reports). A `vm` context is not a boundary (any host
  object leads back to `process`), so no inner context is pretended: the permission model is the depth.
- The parent checks every IPC message's shape; storage changes are bounded string keys and values written only to the
  agent's own profile file. The agent's storage is shared by every site it joins, unlike a browser's per-origin
  storage; that is acceptable only because every core it runs is GifOS's own.

## What this covers

The same transport serves the Node package's `join({ core: true })`, the Python package (through `gifos-agent-stdio`)
and the MCP Meeting Bot's core mode (`GIFOS_BOT_MODE=core`, through this package). Tests: `test/unit/core-trust.test.js`
serves a hostile site (a `node.js` that tries `fs`, `child_process`, workers, `process.env` and this process's stdout):
unsigned, signed by another key, changed after signing, a tampered list, an unlisted file, an old build, and signed
by a trusted test key (then the child refuses every attempt).

## At release

The signer runs, on the machine that holds the key, from the GifOS release tree:
`GIFOS_SIGN_KEY=<jwk> node scripts/sign-core.mjs --build <x.y.z>`, which writes `js/core/core.sig.json` into the site,
and `node scripts/sign-core.mjs --check` before the release ships. Any later change to a core file needs a new signature.
