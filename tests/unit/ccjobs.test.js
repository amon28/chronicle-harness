// Background jobs on the user's Claude Code (decision 169): the model id, the routing in streamChat, the learning
// candidates, and a chat request flattened into one Claude Code turn.
import { describe, it, expect, vi } from 'vitest';
import { CC_MODEL, isCcModel, setCcTextRunner, streamChat } from '../../src/api.js';
import { learnCandidates } from '../../src/memory.js';
import { flattenForCc } from '../../src/cctask.js';

describe('Claude Code background jobs', () => {
  it('knows its model ids', () => {
    expect(isCcModel(CC_MODEL + 'sonnet')).toBe(true);
    expect(isCcModel('glm-5.3')).toBe(false);
    expect(isCcModel(undefined)).toBe(false);
  });

  it('streamChat hands a Claude Code model to the registered runner, and errors without one', async () => {
    setCcTextRunner(null);
    const onError = vi.fn();
    streamChat({}, { model: CC_MODEL + 'sonnet', messages: [] }, { onError });
    await Promise.resolve();
    expect(onError.mock.calls[0][0].message).toMatch(/not set up/);
    const run = vi.fn((req, h) => (h.onContent('hi'), h.onDone(), { cancel() {} }));
    setCcTextRunner(run);
    const got = [];
    streamChat({}, { model: CC_MODEL + 'sonnet', messages: [{ role: 'user', content: 'x' }], sessionId: 'c1-memory' }, { onContent: (t) => got.push(t), onDone: () => got.push('done') });
    expect(run.mock.calls[0][0]).toEqual({ value: 'sonnet', messages: [{ role: 'user', content: 'x' }], sessionId: 'c1-memory' });
    expect(got).toEqual(['hi', 'done']);
    setCcTextRunner(null);
  });

  it('learning tries Claude Code first, then the automatic choice', () => {
    const models = [{ id: 'glm-5.3-flash', name: 'GLM-5.3 Flash' }, { id: 'glm-5.3', name: 'GLM-5.3' }];
    const c = learnCandidates(models, CC_MODEL + 'default', 'glm-5.3');
    expect(c[0]).toBe(CC_MODEL + 'default');
    expect(c.slice(1)).toEqual(learnCandidates(models, 'auto', 'glm-5.3'));
  });

  it('flattens a request: system apart, one user message as it is, an exchange as a transcript', () => {
    expect(flattenForCc([{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Fix: i has went' }])).toEqual({ system: 'Be brief.', task: 'Fix: i has went' });
    const f = flattenForCc([
      { role: 'system', content: 'A' },
      { role: 'system', content: 'B' },
      { role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'image_url', image_url: { url: 'data:' } }] },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ]);
    expect(f.system).toBe('A\n\nB');
    expect(f.task).toMatch(/^USER:\nfirst\n\nASSISTANT:\nsecond\n\nUSER:\nthird\n\n\(Answer the last message/);
    expect(f.task).not.toContain('data:');
  });
});
