import { describe, it, expect, beforeEach } from 'vitest';
import { closeBrowser, runBrowser } from '../../src/browsercontrol.js';

// "dialog mode dismiss" lives in the page (window.__ocmDialogMode). A click that loads another page, a reload, or the
// page being opened again starts a new document, where confirm() is answered OK again – "Delete everything?" → OK.
const ID = 'dlg1';
let evals, page;
beforeEach(async () => {
  evals = [];
  page = { mode: undefined, text: undefined }; // what the document in the browser has; a navigation resets it
  globalThis.__ocmBrowser = {
    open: async () => { page = {}; },
    eval: async ({ js }) => {
      evals.push(js);
      if (js === 'document.readyState') return { value: '"complete"' };
      const m = /window\.__ocmDialogMode=("accept"|"dismiss"),window\.__ocmPromptText=(null|"[^"]*")/.exec(js);
      if (m) { page.mode = JSON.parse(m[1]); page.text = JSON.parse(m[2]); return { value: '"ok"' }; }
      if (js.includes('try{window.__ocmB.click(')) { page = {}; return { value: '"clicked"' }; } // the click loads the next page
      if (js.includes('try{JSON.stringify(window.__ocmDialogs||[])}')) return { value: '[]' };
      return { value: JSON.stringify({ url: 'https://example.com/', title: 'T', text: 'hello', textFrom: 0, textLen: 5, elements: [], scrollY: 0, pageHeight: 800, viewHeight: 800 }) };
    },
    close: async () => {},
  };
  await closeBrowser(ID);
});

describe('dialog mode', () => {
  it('"dismiss" still holds on the page a click led to', async () => {
    await runBrowser({ action: 'open', url: 'https://example.com/' }, { convId: ID });
    const d = await runBrowser({ action: 'dialog', mode: 'dismiss', text: 'no' }, { convId: ID });
    expect(d.result).toMatch(/dismiss/);
    expect(page).toEqual({ mode: 'dismiss', text: 'no' });
    await runBrowser({ action: 'click', selector: 'text=Next' }, { convId: ID }); // → a new document
    const firstClick = evals.findLastIndex((j) => j.includes('try{window.__ocmB.click('));
    await runBrowser({ action: 'click', selector: 'text=Delete account' }, { convId: ID });
    // the mode was put back before this click ran
    const set = evals.findLastIndex((j) => j.includes('window.__ocmDialogMode="dismiss"'));
    const click = evals.findLastIndex((j) => j.includes('try{window.__ocmB.click('));
    expect(set).toBeGreaterThan(firstClick);
    expect(set).toBeLessThan(click);
    expect(evals[set]).toContain('window.__ocmPromptText="no"');
  });
  it('is kept when the page is opened again, and forgotten by a new open', async () => {
    await runBrowser({ action: 'open', url: 'https://example.com/' }, { convId: ID });
    await runBrowser({ action: 'dialog', mode: 'dismiss' }, { convId: ID });
    await closeBrowser(ID);
    await runBrowser({ action: 'read' }, { convId: ID });
    expect(page.mode).toBe('dismiss');
    await runBrowser({ action: 'open', url: 'https://example.com/other' }, { convId: ID });
    await runBrowser({ action: 'read' }, { convId: ID });
    expect(page.mode).toBeUndefined();
  });
  it('asking for the dialogs without a mode changes nothing and says how they are answered', async () => {
    await runBrowser({ action: 'open', url: 'https://example.com/' }, { convId: ID });
    const r = await runBrowser({ action: 'dialog' }, { convId: ID });
    expect(page.mode).toBeUndefined();
    expect(r.result).toMatch(/accepted automatically/);
  });
});

describe('the dialog listing', () => {
  it('says the dialogs it lists came before this call, with the answer they got then, and how the next ones are answered', async () => {
    const shown = [{ type: 'confirm', message: 'Delete the draft?', answer: 'OK' }];
    const base = globalThis.__ocmBrowser.eval;
    globalThis.__ocmBrowser.eval = async (a) => (a.js.includes('try{JSON.stringify(window.__ocmDialogs||[])}') ? { value: JSON.stringify(JSON.stringify(shown)) } : base(a));
    await runBrowser({ action: 'open', url: 'https://example.com/' }, { convId: ID });
    const r = await runBrowser({ action: 'dialog', mode: 'dismiss' }, { convId: ID });
    expect(r.result).toMatch(/^From now on alert\/confirm\/prompt dialogs are answered with "dismiss"/);
    expect(r.result).toMatch(/Dialogs this page showed BEFORE this call \(1, oldest first, each with the answer it got then\)/);
    expect(r.result).toMatch(/"answer": "OK"/);
    shown.length = 0;
    const e = await runBrowser({ action: 'dialog' }, { convId: ID });
    expect(e.result).toMatch(/This page has shown no dialogs before this call/);
  });
});
