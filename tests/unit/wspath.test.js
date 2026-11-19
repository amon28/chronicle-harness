import { describe, it, expect } from 'vitest';
import { wsPathIn } from '../../src/app/wspath.js';

const files = Object.assign(Object.create(null), { 'output/agent-harness-requests.md': {}, 'output/my notes.md': {}, 'src/app.js': {}, 'notes.md': {}, 'README.md': {}, 'testimg.png': {} });
const at = (t, o = {}) => wsPathIn(t, { convId: 'c1', files, ...o });

describe('a file path in a reply opens the file, however it is written', () => {
  it('relative, ./, workspace/, /workspace/ and /chats/<this chat>/ all name the same file', () => {
    for (const t of ['output/agent-harness-requests.md', './output/agent-harness-requests.md', 'workspace/output/agent-harness-requests.md', '/workspace/output/agent-harness-requests.md', '/chats/c1/output/agent-harness-requests.md', 'chats/c1/output/agent-harness-requests.md'])
      expect(at(t)).toBe('output/agent-harness-requests.md');
    expect(at('src/app.js:42')).toBe('src/app.js');
    // a file in the top folder with a line (and column): not taken for a URL scheme
    expect(at('notes.md:12')).toBe('notes.md');
    expect(at('README.md:3:5')).toBe('README.md');
    expect(at('testimg.png:12')).toBe('testimg.png');
    expect(at('mailto:notes.md')).toBe('');
  });
  it('only a file that is there: other text, another chat, URLs and missing files stay plain', () => {
    for (const t of ['output/missing.md', 'npm run dev', '/chats/c2/output/agent-harness-requests.md', 'https://x.dev/src/app.js', 'C:\src\app.js', '', '../../etc/passwd'])
      expect(at(t)).toBe('');
  });
  it('a name with a space in it, written in backticks, is the file too – with its line; words stay words', () => {
    expect(at('output/my notes.md')).toBe('output/my notes.md');
    expect(at('output/my notes.md:4')).toBe('output/my notes.md');
    expect(at('workspace/output/my notes.md')).toBe('output/my notes.md');
    for (const t of ['output/my', 'npm run dev', 'output/my notes.md and more', 'output/my\nnotes.md']) expect(at(t)).toBe('');
    // before the file list is there a span with a space is not guessed at (it is most likely a command)
    expect(wsPathIn('output/my notes.md', { convId: 'c1', files: null, any: true })).toBe('');
  });
  it('before the workspace is loaded, a tap still hands the path to the opener (which checks it)', () => {
    expect(wsPathIn('output/x.md', { convId: 'c1', files: null, any: true })).toBe('output/x.md');
    expect(wsPathIn('output/x.md', { convId: 'c1', files: null })).toBe('');
  });
});
