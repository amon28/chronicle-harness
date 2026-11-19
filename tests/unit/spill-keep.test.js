// A long result is saved in .out/ and the model is told where. That file must be there when it goes to read it.
import { describe, it, expect } from 'vitest';
import { runTool } from '../../src/tools.js';
import { oldSpills, spillName, SPILL_FILES } from '../../src/context.js';

const enc = (s) => new TextEncoder().encode(s);

describe('.out/ keeps the newest results, whatever tool made them', () => {
  it('a long list_files result is still in .out/ after a session with many long shell results', async () => {
    const w = { id: 'spill1', files: {} };
    // a long session: more spilled shell results than .out/ keeps
    for (let i = 0; i < SPILL_FILES + 2; i++) w.files[spillName('shell', Date.UTC(2026, 4, 1, 10, 0, i))] = { data: enc('old output ' + i), mtime: 1000 + i };
    for (let i = 0; i < 900; i++) w.files['src/some/long/folder/name/file-number-' + i + '.js'] = { data: enc('x'), mtime: 1 };
    const r = await runTool({ name: 'list_files', arguments: '{}' }, { workspace: w, settings: { prefs: {} }, convId: 'spill1' });
    const said = /saved in (\.out\/\S+\.txt)/.exec(r.result)?.[1];
    expect(said).toMatch(/^\.out\/list_files-/);
    expect(Object.keys(w.files)).toContain(said); // what the result points at exists
    expect(Object.keys(w.files).filter((p) => p.startsWith('.out/')).length).toBe(SPILL_FILES);
  });

  it('oldSpills goes by the time of the file, not by the tool name, and across a new year', () => {
    const files = {};
    for (let i = 0; i < SPILL_FILES; i++) files['.out/shell-1231-2359' + String(i).padStart(2, '0') + '-abc.txt'] = { mtime: 100 + i };
    files['.out/browser-0101-000001-abc.txt'] = { mtime: 999 }; // the newest: January after December, and "b" before "s"
    const gone = oldSpills(Object.keys(files), (p) => files[p].mtime);
    expect(gone).toEqual(['.out/shell-1231-235900-abc.txt']);
  });
});
