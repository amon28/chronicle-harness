import { describe, it, expect } from 'vitest';
import { cleanTodos, runPlanTool } from '../../src/plantools.js';

describe('plan tools', () => {
  it('cleans a to-do list: trims, drops empties, defaults the status, one in-progress item', () => {
    const l = cleanTodos([{ text: ' a ', status: 'in_progress' }, { text: '', status: 'done' }, { text: 'b', status: 'in_progress' }, { text: 'c', status: 'weird' }, { text: 'd' }]);
    expect(l).toEqual([{ text: 'a', status: 'in_progress' }, { text: 'b', status: 'pending' }, { text: 'c', status: 'pending' }, { text: 'd', status: 'pending' }]);
  });
  it('todo_write stores the list; ask_user returns the answer', async () => {
    let saved = null;
    const ctx = { todos: { set: (i) => (saved = i) }, ask: async (q, o) => o[1] };
    const r = await runPlanTool('todo_write', { items: [{ text: 'x', status: 'done' }] }, ctx);
    expect(r.result).toContain('1/1');
    expect(saved).toHaveLength(1);
    const a = await runPlanTool('ask_user', { question: 'Which?', options: ['one', 'two'] }, ctx);
    expect(a.result).toBe('The user answered: two');
    await expect(runPlanTool('todo_write', { items: [] }, ctx)).rejects.toThrow();
  });
});
