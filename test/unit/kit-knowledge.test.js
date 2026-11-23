// sections, words, and Knowledge refresh/search.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sections, words, Knowledge } from '../../kit/knowledge.js';

const source = 'https://example.com/guide.md';

test('sections() splits on # / ## / ### headings and keeps the title and source', () => {
  const md = [
    'Preamble line',
    '# One',
    'Alpha',
    '## Two',
    'Beta',
    '### Three',
    'Gamma',
    '#### Four',
    'still three',
  ].join('\n');
  const s = sections(md, source);
  assert.deepEqual(s.map((p) => p.title), ['', 'One', 'Two', 'Three']);
  assert.equal(s[1].text, 'Alpha');
  assert.equal(s[2].text, 'Beta');
  assert.match(s[3].text, /Gamma/);
  assert.match(s[3].text, /#### Four/);
  assert.match(s[3].text, /still three/);
  assert.ok(s.every((p) => p.source === source));
});

test('words() drops stop words', () => {
  assert.deepEqual(words('What is the plan for the meeting'), ['plan', 'meeting']);
  assert.deepEqual(words('a an the'), []);
  assert.deepEqual(words(''), []);
});

function knowledge(md, opts = {}) {
  const urls = ['https://example.com/guide.md'];
  const fetchFn = async (url) => {
    assert.equal(url, urls[0]);
    return { ok: true, text: async () => md };
  };
  return new Knowledge(urls, { fetchFn, ...opts });
}

test('refresh then search ranks the section that shares the most words', async () => {
  const k = knowledge('# Apples\nApples are a red fruit.\n\n# Colour\nThe banner is red.\n');
  assert.equal(await k.refresh(), true);
  const hits = k.search('red fruit');
  assert.equal(hits[0].title, 'Apples');
  assert.equal(hits[0].source, 'https://example.com/guide.md');
  assert.equal(hits[1].title, 'Colour');
});

test('refresh caps text at maxChars', async () => {
  const k = knowledge('# Title\n' + 'abcdef '.repeat(50), { maxChars: 30 });
  assert.equal(await k.refresh(), true);
  assert.equal(k.text.length, 30);
  assert.ok(k.parts[0].text.length > 30);
});

test('a failing refresh after a good one keeps the old parts', async () => {
  let n = 0;
  const k = new Knowledge(['https://example.com/guide.md'], {
    fetchFn: async () => {
      n += 1;
      if (n === 1) return { ok: true, text: async () => '# Keep\nThis stays.\n' };
      return { ok: false, status: 503, text: async () => '# New\nnope\n' };
    },
  });
  assert.equal(await k.refresh(), true);
  const before = k.parts.map((p) => ({ title: p.title, text: p.text, source: p.source }));
  const text = k.text;
  assert.equal(await k.refresh(), false);
  assert.deepEqual(k.parts.map((p) => ({ title: p.title, text: p.text, source: p.source })), before);
  assert.equal(k.text, text);
  assert.equal(k.parts[0].title, 'Keep');
});
