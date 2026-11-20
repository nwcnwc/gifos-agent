// Watch the host and react: your own vision, LLM and avatar models make the face and the voice.
import { join } from '@gifos/agent';
import { look, think, avatar } from './my-models.js';

const meet = await join(process.argv[2], { name: "Nia (Sam's avatar)" });
const cam = await meet.video.out.open({ width: 640, height: 360, fps: 24 });   // Nia's camera (blurred like anyone's)
const mouth = await meet.audio.out.open({ rate: 24000 });
const sam = (await meet.people()).find((p) => p.admin && !p.bot) || (await meet.people()).find((p) => !p.me && !p.bot);
const eye = await meet.video.in.open({ who: sam.id, as: 'jpeg', fps: 2, width: 384 });   // only now is Sam's video decoded
let seen = null;
(async () => { for await (const f of eye) seen = await look(f.jpeg); })();   // what Sam is doing now
for await (const line of meet.lines({ toMe: true, trusted: true })) {
  const reply = await think(line.text, seen);
  for await (const c of avatar(reply)) { await cam.write(c.frame); await mouth.write(c.pcm); }   // lips in sync with voice
}
