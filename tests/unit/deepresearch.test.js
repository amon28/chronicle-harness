import { describe, it, expect } from 'vitest';
import { parseList, pickUrls, runDeepResearch } from '../../src/deepresearch.js';

describe('deep_research', () => {
  it('reads a list of queries however the model wraps it', () => {
    expect(parseList('Sure:\n```json\n["a b", "c d"]\n```')).toEqual(['a b', 'c d']);
    expect(parseList('1. first query\n2. "second query"')).toEqual(['first query', 'second query']);
    expect(parseList('[]')).toEqual([]);
  });
  it('picks pages round-robin over the searches, at most two per site, none twice', () => {
    const a = '1. One\n   https://a.com/1\n2. Two\n   https://a.com/2\n3. Three\n   https://a.com/3';
    const b = '1. B\n   https://b.org/x\n2. dup\n   https://a.com/1';
    expect(pickUrls([a, b], new Set(), 5).map((u) => u.url)).toEqual(['https://a.com/1', 'https://b.org/x', 'https://a.com/2']);
  });
  it('plans, searches, reads, takes notes, follows up and writes a cited report', async () => {
    const calls = [];
    const callTool = async (name, args) => {
      calls.push(name + ':' + (args.query || args.urls[0]));
      if (name === 'web_search') return { ok: true, result: `1. Page about ${args.query}\n   https://site-${args.query.length}.com/p` };
      return { ok: true, result: 'Long page text. '.repeat(40) };
    };
    const saved = {};
    const ctx = {
      delegate: async (prompt) => {
        if (prompt.startsWith('Today is')) return { text: '["battery life tests", "price comparison 2026", "known problems"]' };
        if (prompt.startsWith('You are taking research notes')) return { text: 'KIND: official\n- It lasts 12 hours.' };
        if (prompt.includes('What is still missing')) return { text: '["independent teardown"]' };
        return { text: 'It lasts 12 hours [1]. Price varies [2].' };
      },
      saveReport: (path, text) => ((saved[path] = text), path),
    };
    const r = await runDeepResearch({ question: 'Which phone has the best battery?', depth: 'standard' }, ctx, callTool);
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.startsWith('web_search')).length).toBe(4); // 3 planned + 1 follow-up
    expect(r.result).toContain('It lasts 12 hours [1]');
    expect(r.result).toMatch(/## Sources\n\[1\] .*https:\/\/site-.* \(official\)/);
    expect(r.result).not.toContain('KIND:'); // the label is taken out of the note
    expect(Object.keys(saved)[0]).toBe('research/which-phone-has-the-best-battery.md');
  });
  it('says so when nothing could be read', async () => {
    const r = await runDeepResearch({ question: 'x?' }, { delegate: async () => ({ text: '["q"]' }) }, async () => ({ ok: false, result: '' }));
    expect(r.ok).toBe(false);
    expect(r.result).toContain('No readable sources');
  });

  it('with no official or primary source it looks once more for exactly those, and the report says what it rests on', async () => {
    const prompts = [];
    let searches = 0;
    const callTool = async (name, args) => {
      if (name === 'web_search') {
        searches++;
        return { ok: true, result: /official|documentation/i.test(args.query) ? '1. Docs\n   https://docs.maker.example/battery' : `1. Thread\n   https://www.reddit.com/r/phones/${args.query.length}` };
      }
      return { ok: true, result: 'Long page text. '.repeat(40) };
    };
    const ctx = {
      delegate: async (prompt) => {
        prompts.push(prompt);
        if (prompt.startsWith('Today is')) return { text: '["battery reddit"]' };
        if (prompt.startsWith('You are taking research notes')) return { text: prompt.includes('docs.maker.example') ? 'KIND: official\n- Rated 12 hours.' : '- Someone says 10 hours.' };
        if (prompt.includes('None of the sources so far is official')) return { text: '["phone battery official documentation"]' };
        if (prompt.includes('What is still missing')) return { text: '[]' };
        return { text: 'Rated 12 hours [2]; users report 10 [1].' };
      },
    };
    const r = await runDeepResearch({ question: 'Battery?', depth: 'quick' }, ctx, callTool);
    expect(searches).toBe(2); // the plan, then the extra round for strong sources
    expect(r.result).toMatch(/\(community\)[\s\S]*\(official\)/); // the reddit page by its address, the docs by the note-taker
    expect(r.result).toContain('1 official, 1 community');
    expect(r.result).toContain('An extra round found official or primary sources.');
    const writer = prompts.find((x) => x.startsWith('Write a research report'));
    expect(writer).toContain('Sources by kind: 1 official, 1 community.');
    expect(writer).toContain('(official) https://docs.maker.example/battery');
  });
  it('kinds: the note-taker decides; the address only fills in the clear cases', async () => {
    const { splitKind, kindFromUrl } = await import('../../src/deepresearch.js');
    expect(splitKind('KIND: commercial\n- buy now', 'https://www.nasa.gov/x')).toEqual({ kind: 'commercial', text: '- buy now' });
    expect(splitKind('- no label', 'https://www.nasa.gov/x').kind).toBe('official');
    expect(kindFromUrl('https://arxiv.org/abs/1')).toBe('primary');
    expect(kindFromUrl('https://stackoverflow.com/q/1')).toBe('community');
    expect(kindFromUrl('https://some-shop.example/item')).toBe('other');
  });
});
