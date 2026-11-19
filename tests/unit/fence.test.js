import { describe, it, expect } from 'vitest';
import { openFence, fenceAt } from '../../src/app/fence.js';

describe('code fence in the message box', () => {
  it('Enter after ```md adds the closing fence and a free line below it', () => {
    const r = openFence('```md', 5);
    expect(r.text).toBe('```md\n\n```\n');
    expect(r.caret).toBe(6); // on the empty line inside the box
  });
  it('works mid-message and keeps what comes after', () => {
    const r = openFence('look:\n```js', 11);
    expect(r.text).toBe('look:\n```js\n\n```\n');
    const r2 = openFence('```py\nlater', 5);
    expect(r2.text).toBe('```py\n\n```\nlater');
  });
  it('does nothing on other lines, on a closing fence, or when the box is already closed below', () => {
    expect(openFence('hello', 5)).toBeNull();
    expect(openFence('```md\ncode\n```', 14)).toBeNull(); // this fence closes the open box
    expect(openFence('```md\n```', 5)).toEqual({ text: '```md\n\n```', caret: 6 });
  });
});

describe('is the caret inside a code box', () => {
  it('inside a closed box, in an unclosed one, and outside', () => {
    const t = 'hi\n```js\nlet a;\n```\nafter';
    expect(fenceAt(t, 14)).toMatchObject({ lang: 'js' });
    expect(fenceAt(t, 2)).toBeNull();
    expect(fenceAt(t, t.length)).toBeNull();
    expect(fenceAt('```\nopen', 9)).toMatchObject({ close: -1 });
  });
});
