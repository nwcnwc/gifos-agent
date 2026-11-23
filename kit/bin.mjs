#!/usr/bin/env node
// gifos-bot <bot.json> [--for <seconds>]: run one bot from its config until Ctrl-C (or --for seconds).
import { loadConfig } from './config.js';
import { runBot } from './runner.js';
const file = process.argv[2];
if (!file || file === '-h' || file === '--help') { console.log('usage: gifos-bot <bot.json> [--for <seconds>]   (docs/bot-kit.md)'); process.exit(file ? 0 : 2); }
const i = process.argv.indexOf('--for'); const secs = i > 0 ? Number(process.argv[i + 1]) : 0;
const cfg = loadConfig(file);
if (process.env.GIFOS_BOT_LINK) cfg.link = process.env.GIFOS_BOT_LINK;   // the same bot at another link (a demo room)
const bot = await runBot(cfg);
const end = async () => { await bot.stop(); console.log(JSON.stringify({ ev: 'stopped', ...bot.stats(), rss_mb: Math.round(process.memoryUsage().rss / 1048576) })); process.exit(0); };
process.on('SIGINT', end); process.on('SIGTERM', end);
if (secs > 0) setTimeout(end, secs * 1000);
setInterval(() => console.log(JSON.stringify({ ev: 'stats', ...bot.stats(), rss_mb: Math.round(process.memoryUsage().rss / 1048576), cpu_s: +(process.cpuUsage().user / 1e6).toFixed(1) })), 60000).unref();
