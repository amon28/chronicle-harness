import { describe, it, expect } from 'vitest';
import { contentBottom } from '../../src/browsercontrol.js';

// The real page script against a tiny fake page: a 390×844 screen, a heading ending at 60px, and one fixed box.
const measure = async (box, style = {}) => {
  const els = [
    { r: { left: 0, top: 0, right: 390, bottom: 60, width: 390, height: 60 }, pos: 'static' },
    { r: { left: box.left ?? 0, top: box.top, right: box.right ?? 390, bottom: box.bottom, width: (box.right ?? 390) - (box.left ?? 0), height: box.bottom - box.top }, pos: 'fixed', ...style },
  ];
  const document = { documentElement: { scrollHeight: 844 }, body: { firstElementChild: {}, scrollHeight: 844, getBoundingClientRect: () => els[0].r, pos: 'static', querySelectorAll: () => els.map((e) => ({ getBoundingClientRect: () => e.r, ...e, contains: () => false })) } };
  const getComputedStyle = (e) => ({ position: e.pos, visibility: 'visible', opacity: e.opacity ?? '1' });
  const api = { eval: async ({ js }) => ({ value: JSON.stringify(new Function('document', 'getComputedStyle', 'innerWidth', 'innerHeight', 'scrollY', 'return ' + js)(document, getComputedStyle, 390, 844, 0)) }) };
  return (await contentBottom(api)).b;
};

describe('where a page ends: a small popup floating over a short page', () => {
  it('a centred dialog (under a quarter of the screen) is kept in the picture', async () => {
    // it used to be cut off: the picture ended at the heading (97px) and said "the page\'s content ends" there
    expect(await measure({ left: 45, right: 345, top: 300, bottom: 500 })).toBe(500);
  });
  it('a toast near the top is kept too', async () => {
    expect(await measure({ left: 20, right: 370, top: 80, bottom: 140 })).toBe(140);
  });
  it('a bar pinned to the bottom edge still does not stop the cut', async () => {
    expect(await measure({ top: 784, bottom: 844 })).toBe(60);
  });
  it('an invisible fixed box (opacity 0) or one off the screen does not count', async () => {
    expect(await measure({ left: 45, right: 345, top: 300, bottom: 500 }, { opacity: '0' })).toBe(60);
    expect(await measure({ left: -400, right: -100, top: 300, bottom: 500 })).toBe(60);
  });
});
