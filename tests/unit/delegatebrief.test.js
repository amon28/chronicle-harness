import { describe, it, expect } from 'vitest';
import { briefIssues, buildDelegatePrompt, runDelegate } from '../../src/delegate.js';

const good = 'Compare the pricing pages on https://a.example and https://b.example for the two plans. Already ruled out: enterprise tiers. Return a table of plan, price and limits, under 200 words.';

describe('briefIssues', () => {
  it('accepts a good brief in every mode', () => {
    for (const m of ['none', 'read', 'full']) expect(briefIssues(good, m)).toEqual([]);
  });
  it('flags a short brief only when tools are on', () => {
    expect(briefIssues('List the words', 'none')).toEqual([]);
    expect(briefIssues('Find it in the file, as a list', 'read').join()).toContain('short');
  });
  it('flags a missing output format', () => {
    const t = 'Look at the file src/app.js and tell me everything interesting you notice about how it handles errors in the main loop please.';
    expect(briefIssues(t, 'read').join()).toContain('output format');
    expect(briefIssues(t, 'none').join()).toContain('output format');
  });
  it('flags a missing scope for read and full only', () => {
    const t = 'Please investigate why the thing is slow and what could be done about it, thoroughly, then give a short summary of causes.';
    expect(briefIssues(t, 'read').join()).toContain('scope');
    expect(briefIssues(t, 'full').join()).toContain('scope');
    expect(briefIssues(t, 'none').join()).not.toContain('scope');
  });
  it('is deterministic', () => {
    expect(briefIssues('x', 'read')).toEqual(briefIssues('x', 'read'));
  });
});

describe('delegate brief wiring', () => {
  it('adds the length line to the prompt', () => {
    expect(buildDelegatePrompt('t', [], {}).prompt).toContain('Reply in at most about 1,500 words unless the task asks for more.');
  });
  it('appends the note only when there are issues', async () => {
    const ctx = { delegate: async () => ({ text: 'done' }) };
    const bad = await runDelegate({ task: 'do it', tools: 'read' }, ctx);
    expect(bad.ok).toBe(true);
    expect(bad.result).toContain('Brief check');
    const ok = await runDelegate({ task: good, tools: 'read' }, ctx);
    expect(ok.result).not.toContain('Brief check');
  });
  it('counts attached files as the scope', () => {
    const t = 'Summarise the main argument and every number it gives, in five bullet points, and say which claims have no support anywhere in the text.';
    expect(briefIssues(t, 'read').join()).toContain('scope');
    expect(briefIssues(t, 'read', ['notes/a.md'])).toEqual([]);
  });
});
