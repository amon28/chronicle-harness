import { describe, it, expect } from 'vitest';
import { mentionedFiles, snapshotFiles, atFilesBlock } from '../../src/atfiles.js';

const enc = (s) => new TextEncoder().encode(s);
const files = { 'src/app.js': { data: enc('let a = 1;') }, 'README.md': { data: enc('# Hi') }, 'img.png': { data: new Uint8Array([0, 1]) } };
describe('@file mentions', () => {
  it('finds workspace paths after @, ignores persona names and unknown files', () => {
    expect(mentionedFiles('look at @src/app.js and @README.md, not @Seraphina or @missing.txt', files)).toEqual(['src/app.js', 'README.md']);
    expect(mentionedFiles('@/workspace/src/app.js.', files)).toEqual(['src/app.js']);
  });
  it('snapshots text and marks binaries', () => {
    const dec = (b) => (b[0] === 0 ? null : new TextDecoder().decode(b));
    const s = snapshotFiles(['src/app.js', 'img.png'], files, dec);
    expect(s[0].text).toBe('let a = 1;');
    expect(s[1].text).toMatch(/binary/);
    expect(atFilesBlock(s)).toContain('[@src/app.js');
  });
});
