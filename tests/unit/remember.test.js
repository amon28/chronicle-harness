import { describe, it, expect } from 'vitest';
import { rememberText, addToAgentsMd } from '../../src/remember.js';

describe('# to remember', () => {
  it('only a single # followed by a space', () => {
    expect(rememberText('# always use tabs')).toBe('always use tabs');
    expect(rememberText('## Heading')).toBeNull();
    expect(rememberText('#hashtag')).toBeNull();
    expect(rememberText('hello')).toBeNull();
  });
  it('adds to the Notes section of AGENTS.md, creating it when needed', () => {
    expect(addToAgentsMd('', 'use tabs')).toBe('# Project instructions\n\n## Notes\n- use tabs\n');
    expect(addToAgentsMd('# P\n\nBuild with make.', 'use tabs')).toBe('# P\n\nBuild with make.\n\n## Notes\n- use tabs\n');
    expect(addToAgentsMd('# P\n\n## Notes\n- a\n\n## Other\nx', 'b')).toBe('# P\n\n## Notes\n- a\n- b\n\n## Other\nx\n');
  });
});
