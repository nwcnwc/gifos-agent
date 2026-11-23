// Knowledge: text the bot answers from, fetched from URLs at start and refreshed (so it cannot drift from its source).
// Split into sections at Markdown headings; search() finds the sections that share the most words with a question.
const STOP = new Set('a an and are as at be but by can do does for from how i if in is it its me my of on or so that the this to was what when where which who why will with you your'.split(' '));

export function words(s) {
  return String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((w) => w.length > 1 && !STOP.has(w)) || [];
}

export function sections(text, source = '') {
  const out = [];
  let cur = { title: '', body: [], source };
  for (const line of String(text).split('\n')) {
    if (/^#{1,3}\s/.test(line)) {
      if (cur.body.join('').trim()) out.push(cur);
      cur = { title: line.replace(/^#+\s*/, '').trim(), body: [], source };
    } else cur.body.push(line);
  }
  if (cur.body.join('').trim()) out.push(cur);
  return out.map((s) => ({ title: s.title, text: s.body.join('\n').trim(), source: s.source }));
}

export class Knowledge {
  constructor(urls = [], { refreshMin = 60, maxChars = 12000, fetchFn = globalThis.fetch } = {}) {
    this.urls = urls; this.refreshMs = refreshMin * 60000; this.maxChars = maxChars; this.fetchFn = fetchFn;
    this.parts = []; this.text = ''; this.at = 0;
  }
  async refresh() {
    const parts = [];
    for (const u of this.urls) {
      try {
        const r = await this.fetchFn(u, { headers: { accept: 'text/plain' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        parts.push(...sections(await r.text(), u));
      } catch (e) { if (!this.parts.length) throw new Error(`knowledge ${u}: ${e.message}`); return false; }   // keep the old copy
    }
    this.parts = parts; this.at = Date.now();
    this.text = parts.map((p) => (p.title ? '## ' + p.title + '\n' : '') + p.text).join('\n\n').slice(0, this.maxChars);
    return true;
  }
  async fresh() { if (this.urls.length && Date.now() - this.at > this.refreshMs) await this.refresh().catch(() => {}); return this; }
  // The sections that bear on a question, up to maxChars: what an LLM is given (a small model's context stays small).
  context(q, maxChars = this.maxChars, n = 4) {
    const picked = this.search(q, n);
    const out = (picked.length ? picked : this.parts.slice(0, 2)).map((p) => (p.title ? '## ' + p.title + '\n' : '') + p.text).join('\n\n');
    return out.slice(0, maxChars);
  }
  search(q, n = 2) {
    const want = new Set(words(q));
    if (!want.size) return [];
    return this.parts
      .map((p) => { const ws = words(p.title + ' ' + p.title + ' ' + p.text); let hit = 0; const seen = new Set(); for (const w of ws) if (want.has(w) && !seen.has(w)) { seen.add(w); hit++; } return { p, score: hit / Math.sqrt(want.size) }; })
      .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, n).map((x) => x.p);
  }
}
