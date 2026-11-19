import { describe, it, expect } from 'vitest';
import { parseRecipe, parseParams, parseSchedule, parseArgs, plan, revealHidden } from '../../src/recipes.js';

const REPORT = `---
name: weekly-report
description: News on a topic
params: topic (required), days = 7
schedule: daily 08:00
---
## Find the news
Search the web for {{topic}} news from the last {{days}} days.
## Use: tidy path=/workspace/news.md who={{topic}}
## Write it up
Write the summary to /workspace/report.md for {{user}}.`;
const TIDY = `---
name: tidy
params: path (required), who
---
## Tidy
Tidy {{path}} about {{who}}.`;

describe('recipes', () => {
  it('reads parameters, schedule and steps', () => {
    const r = parseRecipe(REPORT);
    expect(r.params).toEqual([{ name: 'topic', required: true, def: '' }, { name: 'days', required: false, def: '7' }]);
    expect(r.schedule).toEqual({ at: '08:00', every: 1440 });
    expect(r.steps.map((s) => s.use || s.title)).toEqual(['Find the news', 'tidy', 'Write it up']);
    expect(parseSchedule('every 2h')).toEqual({ every: 120 });
    expect(() => parseSchedule('every 1')).toThrow();
    expect(parseParams('a=1, b (required)')).toEqual([{ name: 'a', required: false, def: '1' }, { name: 'b', required: true, def: '' }]);
    expect(() => parseRecipe('## x\ny')).toThrow(/name/);
  });
  it('takes named and plain arguments', () => {
    const ps = parseParams('topic (required), days = 7');
    expect(parseArgs('days=3 new phones', ps)).toEqual({ days: '3', topic: 'new phones' });
    expect(parseArgs('topic="a b" days=2', ps)).toEqual({ topic: 'a b', days: '2' });
  });
  it('plans the messages with sub-recipes filled in, and refuses loops or missing values', () => {
    const lib = { tidy: parseRecipe(TIDY), 'weekly-report': parseRecipe(REPORT) };
    const steps = plan(lib['weekly-report'], { topic: 'AI' }, (n) => lib[n]);
    expect(steps.map((s) => s.text)).toEqual(['Search the web for AI news from the last 7 days.', 'Tidy /workspace/news.md about AI.', 'Write the summary to /workspace/report.md for {{user}}.']);
    expect(steps[1].label).toBe('weekly-report 2/3 › tidy 1/1 · Tidy');
    expect(() => plan(lib['weekly-report'], {}, (n) => lib[n])).toThrow(/needs topic/);
    const loop = parseRecipe('---\nname: a\n---\n## Use: a\n');
    expect(() => plan(loop, {}, () => loop)).toThrow(/calls itself/);
    expect(() => plan(lib['weekly-report'], { topic: 'x' }, () => null)).toThrow(/not installed/);
  });
  it('reveals hidden characters', () => {
    const r = revealHidden('Summarise​ this\u{E0041}\u{E0042}');
    expect(r.count).toBe(3);
    expect(r.text).toContain('⟦U+200B⟧');
    expect(r.text).toContain('⟦U+E0041⟧');
    expect(r.clean).toBe('Summarise this');
  });
});
