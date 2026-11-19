import { describe, it, expect } from 'vitest';
import { expandCommand, frontMatter, projectAgents, projectCommands, projectStyles } from '../../src/projectfiles.js';

const enc = (s) => ({ data: new TextEncoder().encode(s) });
const dec = (b) => new TextDecoder().decode(b);
const files = {
  '.chronicle/commands/fix-issue.md': enc('---\ndescription: Fix a GitHub issue\n---\nFix issue #$ARGUMENTS. Run the tests after.'),
  '.claude/commands/review.md': enc('Review the last change for bugs.'),
  '.claude/commands/fix-issue.md': enc('shadowed by the .chronicle one'),
  '.chronicle/agents/tester.md': enc('---\nname: tester\ndescription: Runs and fixes tests\ntools: full\nmodel: glm-5.3\n---\nYou run the test suite and fix failures.'),
  '.claude/agents/reader.md': enc('---\ndescription: Reads code\ntools: read_file, grep_files\n---\nOnly read.'),
  '.chronicle/styles/learning.md': enc('---\ndescription: Leaves TODOs for me\n---\nLeave small TODO(human) parts for the user.'),
  'src/x.md': enc('not a command'),
};
describe('project files', () => {
  it('front matter', () => {
    expect(frontMatter('---\na: 1\nb: "two"\n---\nbody')).toEqual({ meta: { a: '1', b: 'two' }, body: 'body' });
    expect(frontMatter('plain').body).toBe('plain');
  });
  it('commands from both folders, the .chronicle one first', () => {
    const c = projectCommands(files, dec);
    expect(c.map((x) => x.cmd)).toEqual(['fix-issue', 'review']);
    expect(c[0].title).toBe('Fix a GitHub issue');
    expect(expandCommand(c[0].text, '42')).toBe('Fix issue #42. Run the tests after.');
    expect(expandCommand('Review it.', 'quickly')).toBe('Review it.\n\nquickly');
    expect(expandCommand('Move $1 to $2', 'a.js b.js')).toBe('Move a.js to b.js');
  });
  it('agents with their tools and model', () => {
    const a = projectAgents(files, dec);
    expect(a.find((x) => x.name === 'tester')).toMatchObject({ tools: 'full', model: 'glm-5.3', allow: null, prompt: 'You run the test suite and fix failures.' });
    expect(a.find((x) => x.name === 'reader')).toMatchObject({ tools: 'full', allow: ['read_file', 'grep_files'] });
  });
  it('styles', () => {
    expect(projectStyles(files, dec)[0]).toMatchObject({ name: 'learning', description: 'Leaves TODOs for me' });
  });
});
