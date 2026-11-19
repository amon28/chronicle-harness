// grep_files leaves out files over 4 MB (and binary ones). "No match in 2 files" about a file it never opened is a
// wrong answer: the model concludes the text is not there.
import { describe, it, expect } from 'vitest';
import { runCodeTool } from '../../src/codetools.js';

describe('grep_files says what it did not search', () => {
  it('a file over the size limit is named, not counted as searched', async () => {
    const big = new Uint8Array(4 * 1024 * 1024 + 10).fill(97); // "aaaa…"
    big.set(new TextEncoder().encode('\nERROR: disk full\n'), 100);
    const w = { id: 'g1', files: { 'logs/server.log': { data: big, mtime: 1 }, 'notes.txt': { data: new TextEncoder().encode('all fine'), mtime: 1 } } };
    const r = await runCodeTool('grep_files', { pattern: 'ERROR' }, {}, w);
    expect(r.result).toMatch(/No match for "ERROR" in 1 file\b/);
    expect(r.result).toMatch(/not searched.*logs\/server\.log.*4 MB/);
  });
  it('says nothing extra when every file was searched', async () => {
    const w = { id: 'g2', files: { 'notes.txt': { data: new TextEncoder().encode('all fine'), mtime: 1 } } };
    const r = await runCodeTool('grep_files', { pattern: 'fine' }, {}, w);
    expect(r.result).not.toMatch(/not searched/);
  });
});
