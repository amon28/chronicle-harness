import { describe, it, expect } from 'vitest';
import { isNothingNew, recordRun, runScheduleTool, describeTask, unfinishedQuietCheck } from '../../src/autonomy.js';

describe('quiet scheduled checks', () => {
  it('recognise the "nothing new" answer, and only that', () => {
    for (const t of ['NOTHING_NEW', ' nothing_new ', '**NOTHING_NEW**', 'NOTHING NEW.']) expect(isNothingNew(t)).toBe(true);
    for (const t of ['NOTHING_NEW, but the price rose', 'Nothing new on the page, but the shop added a sale', 'The price dropped']) expect(isNothingNew(t)).toBe(false);
  });
  it('schedule_task takes quiet, and the task keeps its last runs', () => {
    const list = [];
    const ctx = { schedules: { list: () => list, add: (t) => list.push(t), remove: () => false } };
    const r = runScheduleTool({ action: 'add', prompt: 'check the lamp price', every_minutes: 60, quiet: true }, ctx);
    expect(r.ok).toBe(true);
    expect(list[0].quiet).toBe(true);
    for (let i = 0; i < 12; i++) recordRun(list[0], i % 2 ? 'nothing new' : 'dropped', 1000 + i);
    expect(list[0].history).toHaveLength(10);
    expect(describeTask(list[0])).toMatch(/quiet \(only speaks when something is new\); last run .*: nothing new/);
  });
});

describe('a quiet check the app was closed during', () => {
  const check = { role: 'user', content: '⏰ Scheduled check (st_1): look at the price', scheduled: true, quiet: true };
  const before = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
  it('is taken out on the next start when its reply never came or never finished', () => {
    expect(unfinishedQuietCheck([...before, check])).toBe(2);
    expect(unfinishedQuietCheck([...before, check, { role: 'assistant', content: 'The pri', streaming: true }])).toBe(2);
    expect(unfinishedQuietCheck([...before, check, { role: 'assistant', content: 'NOTHING_NEW' }])).toBe(2); // closed just before it was taken out
  });
  it('stays when it said something, failed, or you wrote after it', () => {
    expect(unfinishedQuietCheck([...before, check, { role: 'assistant', content: 'The price dropped to 40 €' }])).toBe(-1);
    expect(unfinishedQuietCheck([...before, check, { role: 'assistant', content: '', error: 'HTTP 500' }])).toBe(-1);
    expect(unfinishedQuietCheck([...before, check, { role: 'user', content: 'what now?' }])).toBe(-1);
    expect(unfinishedQuietCheck(before)).toBe(-1);
    expect(unfinishedQuietCheck([...before, { ...check, quiet: false }])).toBe(-1);
  });
});
