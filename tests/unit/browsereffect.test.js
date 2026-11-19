import { describe, it, expect } from 'vitest';
import { effectOf, sameText, challengeOf } from '../../src/browsereffect.js';

const snap = (o = {}) => ({ url: 'https://a.test/', title: 'A', elements: [], text: 'hello', textFrom: 0, overlay: null, dialogs: [], ...o });

describe('effectOf', () => {
  it('reports an address change', () => {
    const e = effectOf(snap(), snap({ url: 'https://a.test/b' }));
    expect(e).toMatch(/^Effect: address changed https:\/\/a\.test\/ → https:\/\/a\.test\/b/);
  });
  it('reports a title change', () => {
    expect(effectOf(snap(), snap({ title: 'B' }))).toContain('title changed "A" → "B"');
  });
  it('matches elements without their numbers, so renumbering is not a change', () => {
    const p = snap({ elements: ['[1] link "Home"', '[2] button "Buy"'] });
    const n = snap({ elements: ['[1] button "Pay"', '[2] link "Home"', '[3] button "Buy"'] });
    const e = effectOf(p, n);
    expect(e).toContain('1 new element (button "Pay")');
    expect(e).not.toContain('gone');
    expect(effectOf(p, snap({ elements: ['[5] button "Buy"', '[6] link "Home"'] }))).toBe('Effect: nothing visible changed');
  });
  it('counts gone elements and a popup', () => {
    const e = effectOf(snap({ elements: ['[1] a', '[2] b', '[3] c'] }), snap({ elements: ['[1] c'], overlay: { what: 'dialog' } }));
    expect(e).toContain('2 gone');
    expect(e).toContain('a popup appeared');
  });
  it('says nothing visible changed', () => {
    expect(effectOf(snap({ elements: ['[1] x'] }), snap({ elements: ['[4] x'] }))).toBe('Effect: nothing visible changed');
  });
});

describe('sameText', () => {
  it('is true for identical text on the same page', () => {
    expect(sameText(snap(), snap())).toBe(true);
  });
  it('is false when text, address or start differ, or there is no previous', () => {
    expect(sameText(snap(), snap({ text: 'other' }))).toBe(false);
    expect(sameText(snap(), snap({ url: 'https://a.test/x' }))).toBe(false);
    expect(sameText(snap(), snap({ textFrom: 500 }))).toBe(false);
    expect(sameText(null, snap())).toBe(false);
  });
});

describe('challengeOf', () => {
  it('flags a Cloudflare title', () => {
    expect(challengeOf(snap({ title: 'Just a moment...' }))).toBeTruthy();
  });
  it('flags an hcaptcha frame line', () => {
    const l = '[frame] from newassets.hcaptcha.com "hCaptcha challenge" at x 0–300, y 100–400 – another site';
    expect(challengeOf(snap({ elements: ['[1] button "Go"', l] }))).toMatch(/hcaptcha\.com/);
  });
  it('flags verify-you-are-human text', () => {
    expect(challengeOf(snap({ text: 'Please verify you are human to continue' }))).toBeTruthy();
  });
  it('is null on a normal page', () => {
    expect(challengeOf(snap({ elements: ['[1] link "Home"'], text: 'Welcome to the shop' }))).toBeNull();
  });
});
