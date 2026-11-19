import { describe, it, expect, beforeEach } from 'vitest';
import { closeBrowser, runBrowser } from '../../src/browsercontrol.js';

const ID = 'esc1';
let pressAnswer;
beforeEach(async () => {
  pressAnswer = '"pressed"';
  globalThis.__ocmBrowser = {
    open: async () => {},
    eval: async ({ js }) => {
      if (js === 'document.readyState') return { value: '"complete"' };
      if (js.includes('try{window.__ocmB.press("Escape"')) return { value: pressAnswer };
      return { value: JSON.stringify({ url: 'https://example.com/', title: 'T', text: 'hello', textFrom: 0, textLen: 5, elements: [], scrollY: 0, pageHeight: 800, viewHeight: 800 }) };
    },
    close: async () => {},
  };
  await closeBrowser(ID);
});

describe('press Escape', () => {
  it('says which popup it closed', async () => {
    await runBrowser({ action: 'open', url: 'https://example.com/' }, { convId: ID });
    pressAnswer = JSON.stringify('Escape closed the dialog dialog#d "Subscribe".');
    const r = await runBrowser({ action: 'press', key: 'Escape' }, { convId: ID });
    expect(r.result).toMatch(/^Escape closed the dialog dialog#d "Subscribe"\./);
  });
  it('says nothing more when nothing was closed', async () => {
    await runBrowser({ action: 'open', url: 'https://example.com/' }, { convId: ID });
    const r = await runBrowser({ action: 'press', key: 'Escape' }, { convId: ID });
    expect(r.result).toMatch(/^(Effect: [^\n]*\n)?Page: T/); // the effect line may come first, nothing else
  });
});

describe('effect line and unchanged page text', () => {
  it('says what changed, and never points "unchanged" at another "unchanged"', async () => {
    const open = await runBrowser({ action: 'open', url: 'https://example.com/' }, { convId: ID });
    expect(open.result).not.toContain('Effect:');
    expect(open.result).toContain('hello');
    const one = await runBrowser({ action: 'press', key: 'Escape' }, { convId: ID });
    expect(one.result).toContain('Effect: nothing visible changed');
    expect(one.result).toContain('(page text unchanged since your last browser result)');
    expect(one.result).not.toContain('\nhello');
    const two = await runBrowser({ action: 'press', key: 'Escape' }, { convId: ID });
    expect(two.result).not.toContain('page text unchanged'); // the last one had no text: this one carries it again
    expect(two.result).toContain('hello');
    const three = await runBrowser({ action: 'press', key: 'Escape' }, { convId: ID });
    expect(three.result).toContain('page text unchanged');
  });
});
