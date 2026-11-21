// Join a meeting and answer whoever speaks to the agent. `ask` is your own LLM call.
import { join } from '@gifos/agent';
import { ask } from './my-llm.js';   // your own LLM call (see claude-assistant.mjs for a real one)

const meet = await join(process.argv[2], { name: "Ada (Sam's assistant)" });
const history = [];
for await (const line of meet.lines({ toMe: true, trusted: true })) {
  history.push({ role: 'user', content: `${line.name}: ${line.text}` });
  const reply = await ask(history);
  history.push({ role: 'assistant', content: reply });
  await meet.say(reply);              // stops by itself if someone talks over it
}
