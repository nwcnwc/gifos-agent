// @gifos-app/agent/kit: run your own interactive meeting bot from one config file. See docs/bot-kit.md.
export { loadConfig, normalizeConfig, resolveKey, seatName, DEFAULTS } from './config.js';
export { Knowledge, sections, words } from './knowledge.js';
export { makeBrain, fixedBrain, openaiBrain, guarded, clip, filterReply, systemPrompt } from './brain.js';
export { makeVoice, openaiVoice, espeakVoice, envelope, wavToPcm } from './voice.js';
export { Avatar, loadSet } from './avatar.js';
export { runBot, greetingText, namesMe, leads, shouldAnswer, baseName } from './runner.js';
