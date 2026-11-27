// Decision 244: a sync that changed nothing does not save the workspace. A save copies every file of the chat into
// the database on the screen's thread – after every Claude Code reply and every tool it used, with a few MB of files,
// that froze typing for seconds.
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeFs } from './helpers/fakefs.js';
import { syncWork } from '../../src/bridge.js';
import * as shellfs from '../../src/shellfs.js';
import { getWorkspace, wsPut } from '../../src/sandbox.js';

let fs;
beforeEach(() => {
  fs = fakeFs();
  globalThis.__ocmFiles = fs;
  delete globalThis.__ocmMode;
});

describe('saving after a sync', () => {
  it('saves when files crossed, not when nothing changed, and again when the shell wrote something', async () => {
    const w = await getWorkspace('save1');
    wsPut(w, 'notes.md', 'first notes');
    wsPut(w, 'data/a.json', '{"a":1}');
    expect((await syncWork(w, 'save1')).saved).toBe(true); // copied into the shell
    expect((await syncWork(w, 'save1', { prefer: 'b' })).saved).toBe(false); // the end of a reply that wrote nothing
    expect((await syncWork(w, 'save1')).saved).toBe(false);
    // Claude Code wrote a file in its folder
    await shellfs.writeFile('work/save1', 'report.md', new TextEncoder().encode('# Report'));
    const r = await syncWork(w, 'save1', { prefer: 'b' });
    expect(r.down).toBe(1);
    expect(r.saved).toBe(true);
    expect(w.files['report.md']).toBeTruthy();
    expect((await syncWork(w, 'save1', { prefer: 'b' })).saved).toBe(false);
    // and a delete in the shell is a change too
    await shellfs.removeFile('work/save1', 'notes.md');
    const d = await syncWork(w, 'save1', { prefer: 'b' });
    expect(d.saved).toBe(true);
    expect(w.files['notes.md']).toBeUndefined();
  });
});
