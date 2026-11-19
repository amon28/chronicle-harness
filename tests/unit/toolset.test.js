import { describe, it, expect } from 'vitest';
import { applyToolset, toolsetFrom, TOOLSET_PRESETS } from '../../src/toolset.js';

describe('persona toolset', () => {
  const base = { web: true, python: true, files: true, shell: true, skills: [{ name: 'x' }], autonomy: true };
  it('switched-off groups are removed, everything else stays', () => {
    const r = applyToolset(base, { shell: false, skills: false, mcp: false });
    expect(r).toMatchObject({ web: true, python: true, shell: false, skills: [], mcp: false });
    expect(applyToolset(base, undefined)).toBe(base);
  });
  it('presets store only what is off', () => {
    expect(toolsetFrom(TOOLSET_PRESETS.all)).toBeUndefined();
    expect(toolsetFrom(TOOLSET_PRESETS.roleplay)).toMatchObject({ python: false, shell: false, mcp: false });
    expect(toolsetFrom(TOOLSET_PRESETS.roleplay).web).toBeUndefined();
  });
});
