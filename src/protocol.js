// The gifosAgent v1 contract, as the meeting page (js/meet-agent.js) speaks it.
// The page holds all the logic; this file only names what crosses the wire.

export const PROTOCOL = 1;

// Events, page -> agent.
export const EVENTS = [
  'joined', 'progress', 'password', 'people', 'speaking', 'line', 'stage', 'agenda',
  'hand', 'video', 'app', 'host', 'left', 'mode',
  // port traffic
  'say.done', 'audio.in.frame', 'video.in.frame', 'port.closed',
];

// Actions, agent -> page. Each answers {ok:true, ...} or {ok:false, error:'<a sentence a person can read>'}.
export const ACTIONS = [
  'state', 'people', 'lines',
  'say', 'say.stop', 'chat', 'hand', 'mic', 'stage.ask', 'stage.leave',
  'app.run', 'app.stop', 'app.room', 'agenda.next', 'agenda.set', 'profile', 'leave',
  'audio.out.open', 'audio.out.write', 'audio.out.clear', 'audio.out.close',
  'audio.in.open', 'audio.in.close',
  'video.in.open', 'video.in.close',
  'video.out.open', 'video.out.write', 'video.out.close',
];

// A name must say whose agent it is: "Ada (Sam's assistant)". A bare "Sam" is refused.
export function agentName(name, owner) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!n) throw new Error('Give the agent a name, such as "Ada (Sam\'s assistant)".');
  if (/\([^()]*\S[^()]*\)\s*$/.test(n)) return n.slice(0, 40);
  const o = String(owner || '').replace(/\s+/g, ' ').trim();
  if (o) return (n + ' (' + o + '’s assistant)').slice(0, 40);
  throw new Error('The name must say whose agent it is, such as "' + n + ' (Sam\'s assistant)", or pass { owner: "Sam" }.');
}

// What a lines() filter keeps. trusted: the speaker's own engine or a line this page trusts (never 'unchecked' or
// 'distrusted': captions are self-reported, so an unchecked line is a claim, not a fact).
export function lineMatches(line, f = {}) {
  if (!line || line.final === false) return false;
  if (f.kinds && f.kinds.indexOf(line.kind) < 0) return false;
  if (!f.kinds && (line.kind === 'spoken' || line.kind === 'system')) return false;   // never its own words back
  if (line.mine) return false;
  if (f.toMe && !line.toMe) return false;
  if (f.fromAdmin && !line.fromAdmin) return false;
  if (f.trusted && line.kind !== 'chat' && !(line.trust === 'own' || line.trust === 'trusted')) return false;
  return true;
}
