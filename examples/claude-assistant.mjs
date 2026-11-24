// Answers lines addressed to it with a Claude call. Needs: npm i @anthropic-ai/sdk, and ANTHROPIC_API_KEY set.
// Run: node examples/claude-assistant.mjs https://gifos.app/meet#room=<room>   (say needs a voice: see the README)
import { join } from '../src/index.js';   // in your own project: from '@gifos-app/agent'
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();           // reads ANTHROPIC_API_KEY from the environment
const meet = await join(process.argv[2], { name: "Ada (Sam's assistant)" });
const history = [];

for await (const line of meet.lines({ toMe: true, trusted: true })) {
  history.push({ role: 'user', content: `${line.name}: ${line.text}` });
  const res = await client.messages.create({
    model: 'claude-sonnet-5-5',
    max_tokens: 300,
    system: 'You are a helpful assistant in a video meeting. Answer in one or two short spoken sentences.',
    messages: history,
  });
  const reply = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  history.push({ role: 'assistant', content: reply });
  if (history.length > 20) history.splice(0, 2);   // short history: keep the last 10 exchanges
  await meet.chat(reply);
  await meet.say(reply).catch(() => {});           // no voice installed: the chat post still went out
}
