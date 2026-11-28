import { describe, it, expect } from 'vitest';
import { spillText, oldSpills, trimResult, roundsToTrim, pruneBoundary, searchChats, chatTranscript, SPILL_AT, SPILL_FILES } from '../../src/context.js';

describe('spilling a huge tool result', () => {
  it('keeps the start and the end and says where the rest is', () => {
    const full = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
    const { text, spilled } = spillText(full, '.out/shell-1.txt');
    expect(spilled).toBe(true);
    expect(text.length).toBeLessThan(SPILL_AT);
    expect(text.startsWith('line 0\nline 1\n')).toBe(true);
    expect(text.endsWith('line 3999')).toBe(true);
    expect(text).toMatch(/saved in \.out\/shell-1\.txt/);
    expect(spillText('short', 'x').text).toBe('short');
  });
  it('keeps only the newest spill files', () => {
    const paths = ['a.txt', ...Array.from({ length: SPILL_FILES + 3 }, (_, i) => `.out/shell-1111-${String(i).padStart(6, '0')}-x.txt`)];
    const old = oldSpills(paths);
    expect(old).toHaveLength(3);
    expect(old).toContain('.out/shell-1111-000000-x.txt');
    expect(old).not.toContain('a.txt');
  });
});

describe('pruning old tool results', () => {
  it('trims a long old result to its head and keeps the evidence line', () => {
    const r = 'x'.repeat(5000) + '\n\n[surface=linux-shell ok=1 bytes=5000 ms=3 proof=sha256:ab]';
    const t = trimResult(r);
    expect(t.length).toBeLessThan(800);
    expect(t).toMatch(/older tool result trimmed: \d+ chars/);
    expect(t).toMatch(/\[surface=linux-shell ok=1/);
    expect(trimResult('small')).toBe('small');
  });
  it('trims the current reply ten rounds at a time, after the newest eight', () => {
    expect([5, 8, 17, 18, 27, 28, 40].map(roundsToTrim)).toEqual([0, 0, 0, 10, 10, 20, 30]);
  });
  it('keeps full results from at least the last two user turns; the line moves three turns at a time', () => {
    const turns = (n) => Array.from({ length: n }, () => [{ role: 'user' }, { role: 'assistant' }]).flat();
    expect(pruneBoundary(turns(1), 2)).toBe(0);
    expect(pruneBoundary(turns(3), 2)).toBe(0); // 1 turn past the two: not moved yet
    expect(pruneBoundary(turns(4), 2)).toBe(0);
    expect(pruneBoundary(turns(5), 2)).toBe(6); // 3 past: moves to the 4th user message
    expect(pruneBoundary(turns(6), 2)).toBe(6); // …and stays there (the same prompt start, the cache hits)
    expect(pruneBoundary(turns(7), 2)).toBe(6);
    expect(pruneBoundary(turns(8), 2)).toBe(12);
    for (let n = 2; n < 20; n++) expect(pruneBoundary(turns(n), 2)).toBeLessThanOrEqual(2 * (n - 2)); // never trims the last two
  });
});

describe('searching earlier chats', () => {
  const convs = [
    { id: 'c1', title: 'Weather app', messages: [{ role: 'user', content: 'make a weather app with flask', at: 1 }, { role: 'assistant', content: 'done, app.py uses requests', at: 2 }] },
    { id: 'c2', title: 'Taxes', messages: [{ role: 'user', content: 'help with my taxes', at: 3 }] },
    { id: 'c3', title: 'Flask login', messages: [{ role: 'user', content: 'add a login page to the flask site', at: 4 }, { role: 'assistant', content: '', rounds: [{ content: 'writing login.html', calls: [{ name: 'write_file' }] }], at: 5 }] },
  ];
  it('finds chats by title and text, best first, not the current one', () => {
    const hits = searchChats(convs, 'flask login', { exclude: 'c1' });
    expect(hits.map((h) => h.id)).toEqual(['c3']);
    expect(searchChats(convs, 'flask').map((h) => h.id).sort()).toEqual(['c1', 'c3']);
    expect(searchChats(convs, 'weather')[0].snippet).toMatch(/weather app with flask/);
    expect(searchChats(convs, '')).toEqual([]);
  });
  it('a word matches where a word starts, and since / before keep to the messages of those dates (decision 270)', () => {
    const more = [...convs, { id: 'c4', title: 'Moving', messages: [{ role: 'user', content: 'locate the education office', at: 10 }, { role: 'user', content: 'the cat is ill', at: 50 }] }];
    expect(searchChats(more, 'cat').map((h) => h.id)).toEqual(['c4']);
    expect(searchChats(more, 'cat')[0].snippet).toMatch(/the cat is ill/);
    expect(searchChats(more, 'educ').map((h) => h.id)).toEqual(['c4']); // the start of a word still finds it
    expect(searchChats(more, 'cate')).toEqual([]); // not in the middle of one
    expect(searchChats(more, 'flask', { since: 3 }).map((h) => h.id)).toEqual(['c3']);
    expect(searchChats(more, 'flask', { before: 3 }).map((h) => h.id)).toEqual(['c1']);
    expect(searchChats(more, 'cat', { before: 20 })).toEqual([]);
  });
  it('reads a chat as text, with the tools it used and paging', () => {
    const t = chatTranscript(convs[2]);
    expect(t).toMatch(/#0 User: add a login page/);
    expect(t).toMatch(/#1 Assistant \[used write_file\]: writing login\.html/);
    const long = { messages: Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: 'x'.repeat(500) + i })) };
    expect(chatTranscript(long, { maxChars: 2000 })).toMatch(/more messages – read_chat with from=\d+/);
  });
});

describe('spill through runTool', async () => {
  const { runTool } = await import('../../src/tools.js');
  it('a long grep result is saved to .out and the model gets a pointer', async () => {
    const w = { id: 'sp', files: {} };
    const big = Array.from({ length: 3000 }, (_, i) => `needle ${i} ${'pad '.repeat(5)}`).join('\n');
    w.files['big.txt'] = { data: new TextEncoder().encode(big), mtime: 1 };
    const r = await runTool({ name: 'grep_files', arguments: JSON.stringify({ pattern: 'needle', max_results: 500 }) }, { workspace: w, settings: {} });
    const spill = Object.keys(w.files).find((p) => p.startsWith('.out/grep_files-'));
    expect(spill).toBeTruthy();
    expect(r.result).toMatch(new RegExp(`saved in ${spill.replace(/[.]/g, '\\.')}`));
    expect(new TextDecoder().decode(w.files[spill].data)).toMatch(/needle 499/);
  });
});
