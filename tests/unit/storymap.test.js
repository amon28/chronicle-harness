import { describe, it, expect } from 'vitest';
import { alternates, flattenTree, forkTree } from '../../src/storymap.js';

const c = (id, forkOf, n = 3) => ({ id, title: id, forkOf: forkOf && { id: forkOf[0], at: forkOf[1] }, messages: Array(n).fill({}) });
describe('story map', () => {
  const convs = [c('root'), c('a', ['root', 4]), c('b', ['root', 2]), c('a1', ['a', 6]), c('other')];
  it('builds the tree from any chat in it, ordered by fork point', () => {
    const rows = flattenTree(forkTree(convs, convs[3]));
    expect(rows.map((r) => `${' '.repeat(r.depth)}${r.id}`)).toEqual(['root', ' b', ' a', '  a1']);
    expect(rows.find((r) => r.current).id).toBe('a1');
  });
  it('is just the chat itself when it was never forked', () => {
    expect(flattenTree(forkTree(convs, convs[4])).map((r) => r.id)).toEqual(['other']);
  });
  it('survives a loop and a deleted original', () => {
    const loop = [{ ...c('x', ['y', 1]) }, { ...c('y', ['x', 1]) }];
    expect(flattenTree(forkTree(loop, loop[0])).length).toBeGreaterThan(0);
    expect(flattenTree(forkTree([c('z', ['gone', 1])], c('z', ['gone', 1])))[0].id).toBe('z');
  });
  it('lists the forks inside a chat: retried replies and edited messages, with what followed each', () => {
    const conv = {
      messages: [
        { role: 'user', content: 'go north', versions: [{ content: 'go south', tail: [{ role: 'assistant', content: 'You head south.', alts: [{ content: 'a' }, { content: 'b' }] }] }, { content: 'go north', tail: null }], vIndex: 1 },
        { role: 'assistant', content: 'You head north.', alts: [{ content: 'A cold wind.', tail: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] }, { content: 'You head north.' }], altIndex: 1 },
        { role: 'user', content: 'look' },
      ],
    };
    const a = alternates(conv);
    expect(a.map((x) => [x.index, x.kind, x.count, x.shown])).toEqual([[0, 'edit', 2, 2], [1, 'retry', 2, 2]]);
    expect(a[0].options[0]).toEqual({ n: 0, current: false, snippet: 'go south', after: 1, forks: 1 });
    expect(a[0].options[1]).toMatchObject({ current: true, after: 2 });
    expect(a[1].options[0]).toMatchObject({ snippet: 'A cold wind.', after: 2, current: false });
  });
});
