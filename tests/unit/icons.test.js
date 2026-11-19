import { describe, it, expect } from 'vitest';
import { iconFor, setIconPack } from '../../src/icons.js';
import colors from '../../src/icons-color.js';

// a stand-in for the page: setIconPack redraws what is on screen
globalThis.document ||= { querySelectorAll: () => [] };

describe('interface icons', () => {
  it('a fork and git history get different icons (both were 🌿)', async () => {
    await setIconPack('line');
    const fork = iconFor('🌿', ' Fork from here');
    const git = iconFor('🌿', ' Git history');
    expect(fork).toMatch(/<svg class="ic"/);
    expect(git).toMatch(/<svg class="ic"/);
    expect(fork).not.toBe(git);
    expect(iconFor('🌿', '')).toBe(fork); // the fork mark beside a chat name has no words
  });
  it('the colourful pack draws flat colour icons, with a different one for fork and git', async () => {
    await setIconPack('color');
    expect(iconFor('🎭', ' Roleplay')).toMatch(/class="ic ic-color" viewBox="0 0 32 32"/);
    expect(iconFor('🌿', ' Fork')).toContain(colors['🔀']);
    expect(iconFor('🌿', ' Git history')).toContain(colors['🕰']);
    expect(iconFor('✓', '')).toContain(colors['✅']);
    // no colourful drawing (☰): the line icon is used
    expect(iconFor('☰', ' Command box')).toMatch(/<svg class="ic"/);
  });
  it('the emoji pack leaves the emoji; unknown emoji are never touched', async () => {
    await setIconPack('emoji');
    expect(iconFor('🎭', '')).toBe(null);
    await setIconPack('line');
    expect(iconFor('🦄', '')).toBe(null);
  });
});

describe('Material and Duotone packs', () => {
  it('draw every interface icon, with fork and git told apart', async () => {
    const names = (await import('../../src/icon-names.js')).default;
    for (const [pack, file] of [['material', 'icons-material.js'], ['duotone', 'icons-duotone.js']]) {
      const m = await import(`../../src/${file}`);
      expect(Object.keys(names).filter((k) => !m.default[k])).toEqual([]); // nothing falls back
      await setIconPack(pack);
      const fork = iconFor('🌿', ' Fork from here');
      expect(fork).toContain(`class="ic ic-${pack}"`);
      expect(fork).toContain(m.default['🌿']);
      expect(iconFor('🌿', ' Git history')).toContain(m.default['🌿git']);
      expect(iconFor('↩', ' Wrap')).toContain(m.default['↩wrap']);
    }
    await setIconPack('line');
  });
});

describe('symbols Android draws as colour emoji', () => {
  it('⏰ ✂ ⏪ ▶ ⬇ ⤴ ⤵ have an icon in every pack', async () => {
    for (const pack of ['line', 'color', 'material', 'duotone']) {
      await setIconPack(pack);
      for (const e of ['⏰', '✂', '⏪', '▶', '⬇', '⤴', '⤵']) expect(iconFor(e, ' Scheduled'), `${pack} ${e}`).toMatch(/^<svg class="ic/);
      if (pack !== 'line') expect(iconFor('⏰', ''), pack).toContain(`ic-${pack}`);
    }
    await setIconPack('line');
  });
});
