import { describe, it, expect } from 'vitest';
import { repo } from '../../src/git.js';

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

describe('git in the workspace', () => {
  it('commits changes, lists them, and restores an earlier version', async () => {
    const w = { files: { 'app.py': { data: enc('print(1)\n') }, 'docs/readme.md': { data: enc('# hi\n') } } };
    const store = {};
    const r = repo(w, store);
    const c1 = await r.commitAll('first');
    expect(c1).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(w.files)).toEqual(['app.py', 'docs/readme.md']); // .git stays out of the workspace
    expect(Object.keys(store.git)).toContain('HEAD');
    expect(await r.commitAll('nothing')).toBeNull();
    w.files['app.py'].data = enc('print(2)\n');
    w.files['new.txt'] = { data: enc('x') };
    delete w.files['docs/readme.md'];
    const c2 = await r.commitAll('second');
    expect((await r.changes(c2)).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'app.py', change: 'modified' },
      { path: 'docs/readme.md', change: 'deleted' },
      { path: 'new.txt', change: 'added' },
    ]);
    expect((await r.log()).map((c) => c.message)).toEqual(['second', 'first']);
    await r.restore(c1, 'first');
    expect(dec(w.files['app.py'].data)).toBe('print(1)\n');
    expect(w.files['new.txt']).toBeUndefined();
    expect(dec(w.files['docs/readme.md'].data)).toBe('# hi\n');
    expect((await r.log()).length).toBe(3); // the restore is a commit too
  });
});
