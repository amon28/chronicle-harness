import { test, expect, send, timing } from './helpers.js';

// Decision 239: the app stays responsive while a reply streams – fewer redraws, tool cards kept, no colouring of a code
// box still being written, the chat list left alone while the drawer is shut, the composer's code check quiet.

test.describe('while a reply streams', () => {
  test.use({ appSettings: { prefs: { tools: true } } });

  test('tool cards stay the same elements and the reply is redrawn at most ~10 times a second', async ({ app }) => {
    await app.fill('#input', 'STEPSTHENTEXT please');
    await app.click('#send-btn');
    const last = app.locator('.msg.assistant').last();
    await expect(last).toContainText('Answer paragraph 2', { timeout: 20000 });
    // mark the steps box, and count how often the reply text changes for one second
    await app.evaluate(() => {
      const m = [...document.querySelectorAll('.msg.assistant')].pop();
      m.querySelector('.tool-group').__mark = 1;
      globalThis.__paints = 0;
      const mo = new MutationObserver(() => globalThis.__paints++);
      mo.observe(m.querySelector('.md'), { childList: true, subtree: true, characterData: true });
      setTimeout(() => mo.disconnect(), 1000);
    });
    await app.waitForTimeout(1000);
    const r = await app.evaluate(() => {
      const m = [...document.querySelectorAll('.msg.assistant')].pop();
      return { streaming: document.body.classList.contains('streaming'), kept: m.querySelector('.tool-group')?.__mark === 1, paints: globalThis.__paints };
    });
    expect(r.streaming).toBe(true); // still writing: the check above was mid-reply
    expect(r.kept).toBe(true);
    expect(r.paints).toBeGreaterThan(2);
    expect(r.paints).toBeLessThanOrEqual(14);
  });

  // Decision 256: the earlier rounds' text and the finished tool cards are built once while the reply streams, then copied
  test('the text between steps and the finished step cards are not rebuilt on every update', async ({ app }) => {
    await app.addInitScript(() => {
      const d = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
      Object.defineProperty(Element.prototype, 'innerHTML', {
        ...d,
        set(v) {
          if (globalThis.__count && this.classList?.contains('round-text')) globalThis.__roundBuilds++;
          return d.set.call(this, v);
        },
      });
      const ce = Document.prototype.createElement;
      Document.prototype.createElement = function (t, o) {
        if (globalThis.__count && t === 'details') globalThis.__cardBuilds++;
        return ce.call(this, t, o);
      };
    });
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await app.fill('#input', 'STEPSWITHWORDS please');
    await app.click('#send-btn');
    const last = app.locator('.msg.assistant').last();
    await expect(last).toContainText('Answer paragraph 2', { timeout: 20000 });
    await expect(last.locator('.round-text')).toHaveCount(5);
    await expect(last.locator('.tool-card')).toHaveCount(5);
    await app.evaluate(() => {
      globalThis.__roundBuilds = 0;
      globalThis.__cardBuilds = 0;
      globalThis.__count = true;
    });
    await app.waitForTimeout(1000);
    const r = await app.evaluate(() => ({ streaming: document.body.classList.contains('streaming'), rounds: globalThis.__roundBuilds, cards: globalThis.__cardBuilds }));
    expect(r.streaming).toBe(true); // measured mid-reply
    expect(r.rounds).toBe(0);
    expect(r.cards).toBe(0);
    // the cards still work: one opens, and stays open while the reply goes on
    await last.locator('.tool-card summary').first().click();
    await app.waitForTimeout(400);
    await expect(last.locator('.tool-card').first()).toHaveAttribute('open', '');
    await expect(last).toContainText('Looking at part 0 of the folder');
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
    await expect(last.locator('strong', { hasText: 'part 4' })).toHaveCount(1);
  });

  // Decision 258: the scroll of a tool's output box is kept only for boxes on view – one inside a folded card is never
  // read or set (each made the browser lay out the hidden output: seconds per update in a long Claude Code turn)
  test('boxes inside folded steps are not touched while the reply streams', async ({ app }) => {
    await app.addInitScript(() => {
      for (const prop of ['scrollTop', 'scrollLeft']) {
        const d = Object.getOwnPropertyDescriptor(Element.prototype, prop);
        Object.defineProperty(Element.prototype, prop, {
          ...d,
          get() {
            if (globalThis.__count && this.closest?.('details:not([open])')) globalThis.__hidden++;
            return d.get.call(this);
          },
          set(v) {
            if (globalThis.__count && this.closest?.('details:not([open])')) globalThis.__hidden++;
            return d.set.call(this, v);
          },
        });
      }
    });
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await app.fill('#input', 'STEPSTHENTEXT please');
    await app.click('#send-btn');
    const last = app.locator('.msg.assistant').last();
    await expect(last).toContainText('Answer paragraph 2', { timeout: 20000 });
    await expect(last.locator('.tool-group:not([open]) .tool-out, .tool-group:not([open]) .tool-body pre').first()).toBeAttached();
    await app.evaluate(() => {
      globalThis.__hidden = 0;
      globalThis.__count = true;
    });
    await app.waitForTimeout(1000);
    const r = await app.evaluate(() => ({ streaming: document.body.classList.contains('streaming'), hidden: globalThis.__hidden }));
    expect(r.streaming).toBe(true);
    expect(r.hidden).toBe(0);
    // a box you opened and scrolled keeps its place while the reply goes on
    await last.locator('.tool-group > summary').click();
    await last.locator('.tool-card summary').first().click();
    const box = last.locator('.tool-card').first().locator('.tool-out, .tool-body pre').first();
    await app.addStyleTag({ content: '.tool-out, .tool-body pre { max-height: 8px !important; overflow: auto !important; }' });
    await box.evaluate((x) => (x.scrollTop = 4));
    expect(await box.evaluate((x) => x.scrollTop)).toBeGreaterThan(0);
    await app.waitForTimeout(500);
    expect(await box.evaluate((x) => x.scrollTop)).toBeGreaterThan(0);
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  });

  test('a code box still being written is not coloured; once closed it is', async ({ app }) => {
    await app.fill('#input', 'SLOWCODE please');
    await app.click('#send-btn');
    const last = app.locator('.msg.assistant').last();
    await expect(last).toContainText('step 5', { timeout: 20000 });
    expect(await last.locator('pre .hljs, pre code.hljs').count()).toBe(0);
    await expect(last).toContainText('CODEDONE', { timeout: 20000 });
    await expect(last.locator('code.hljs')).toHaveCount(1);
    await expect(last.locator('code.hljs .hljs-keyword').first()).toHaveText('const');
  });
});

test('a save with the drawer shut leaves the chat list alone; opening it shows the change', async ({ app }) => {
  await send(app, 'first chat');
  await app.evaluate(() => (document.querySelector('#conv-list').firstElementChild.__mark = 1));
  await send(app, 'again');
  expect(await app.evaluate(() => document.querySelector('#conv-list').firstElementChild?.__mark === 1)).toBe(true);
  await app.click('#menu-btn');
  await expect(app.locator('body.drawer-open')).toHaveCount(1);
  expect(await app.evaluate(() => document.querySelector('#conv-list').firstElementChild?.__mark === 1)).toBe(false); // redrawn on opening
  await expect(app.locator('#conv-list')).toContainText('first chat');
});

test('typing outside a code box does not touch the keyboard settings; entering one does, once', async ({ app }) => {
  await app.evaluate(() => {
    globalThis.__attr = [];
    new MutationObserver((l) => l.forEach((m) => globalThis.__attr.push(m.attributeName))).observe(document.querySelector('#input'), { attributes: true, attributeFilter: ['spellcheck', 'autocapitalize', 'class'] });
  });
  await app.locator('#input').pressSequentially('hello there');
  await app.waitForTimeout(100);
  expect(await app.evaluate(() => globalThis.__attr.length)).toBe(0);
  await app.locator('#input').pressSequentially('\n```py\nx = 1');
  await expect(app.locator('#input.in-code')).toHaveCount(1);
  const n = await app.evaluate(() => globalThis.__attr.length);
  expect(n).toBeGreaterThan(0);
  await app.locator('#input').pressSequentially('\ny = 2');
  await app.waitForTimeout(100);
  expect(await app.evaluate(() => globalThis.__attr.length)).toBe(n); // still in the same box: nothing touched
});

test.describe('🩺 Timings while typing', () => {
  test.use({ appSettings: { prefs: { perfTrace: true } } });
  test('typing starts a trace that names the code holding the screen up', async ({ app }) => {
    // something slow on a timer, as a culprit would be
    // loaded from a file (a blob: URL), as the app's own code is, so the report can name the function and its place
    await app.evaluate(() => new Promise((res) => {
      const src = 'globalThis.__hog = setInterval(function hogTheThread() { const end = performance.now() + 250; while (performance.now() < end); }, 700);';
      const sc = document.createElement('script');
      sc.src = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      sc.onload = res;
      document.head.append(sc);
    }));
    await app.click('#input');
    await app.locator('#input').pressSequentially('typing along here', { delay: 60 });
    const r = await timing(app, 'While typing');
    await app.evaluate(() => clearInterval(globalThis.__hog));
    expect(r.text).toContain('slow frames (what ran):');
    expect(r.text).toContain('hogTheThread');
    expect(r.text).toMatch(/TimerHandler:setInterval/);
    expect(r.slow).toBe(true);
    expect(r.line).toContain("the app's own code");
    await expect(app.locator('#toast')).toContainText('🩺 Saved:'); // a word that it was slow, not a box over the chat
  });
});

test.describe('🩺 Timings while typing, with Claude Code running in Linux', () => {
  test.use({ appSettings: { prefs: { perfTrace: true } } });
  test('the report says which Linux programs were using the CPU, and that the app\'s code was not the hold-up', async ({ app }) => {
    await app.addInitScript((port) => {
      globalThis.__perfCmds = 0;
      globalThis.__ocmShell = {
        status: async () => ({ available: true, installed: true }),
        addListener: async () => ({ remove() {} }),
        kill: async () => {},
        exec: async ({ cmd }) => {
          const head = cmd.split('\n')[0];
          if (head === '# ocm-claude status') return { output: '@@NODE v22.11.0\n@@CLAUDE 2.1.325 (Claude Code)\n@@ACP yes\n@@AUTH yes claude.ai -\n@@END\n', exit: 0 };
          if (head === '# ocm-claude start') {
            const secret = /printf '%s\\n' '([A-Za-z0-9_-]+)' \|/.exec(cmd)[1];
            await fetch(`${globalThis.__MOCK}/__spawn-acp?port=${port}&secret=${encodeURIComponent(secret)}`);
            return { output: `@@PORT ${port}\n`, exit: 0 };
          }
          if (cmd.includes('/proc/[0-9]*/stat')) return (globalThis.__perfCmds++, { output: '   97%  node (pid 4242)\n   41%  proot (pid 4100)\n  load: 3.10 2.40 1.90\n', exit: 0 });
          return { output: '', exit: 0 };
        },
      };
    }, 41796);
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await app.evaluate(() => document.querySelector('#model-btn').click());
    await app.click('#model-list .cc-model >> nth=0', { timeout: 15000 });
    await app.fill('#input', 'echo one');
    await app.click('#send-btn');
    await expect(app.locator('.msg.assistant').last()).toContainText('Echo', { timeout: 30000 });
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
    // the send started its own trace: wait for that one to finish, then start typing
    await app.waitForTimeout(6500);
    await app.evaluate(() => localStorage.removeItem('ocm.perfHistory'));
    // a slow key, with no slow code of the app's own: as when another program has the CPU
    await app.evaluate(() => document.querySelector('#input').addEventListener('keydown', () => { const e = performance.now() + 150; while (performance.now() < e); }, { once: true }));
    await app.locator('#input').pressSequentially('next message', { delay: 60 });
    const r = await timing(app, 'While typing');
    expect(r.text).toContain('Linux, busiest programs over 1 s');
    expect(r.text).toContain('97%  node (pid 4242)');
    expect(r.text).toContain("→ the app's own code ran fast");
    expect(r.line).toContain("not the app's code");
    expect(await app.evaluate(() => globalThis.__perfCmds)).toBeGreaterThanOrEqual(1); // once per trace, when it ends
  });
});

test.describe('🩺 Timings when switching chats', () => {
  test.use({ appSettings: { prefs: { perfTrace: true } } });
  test('opening a chat is measured as its own entry, step by step, not as typing', async ({ app }) => {
    await send(app, 'first chat here');
    await app.click('#menu-btn');
    await app.click('#drawer-new');
    await send(app, 'second chat here');
    await app.evaluate(() => localStorage.removeItem('ocm.perfHistory'));
    await app.click('#menu-btn');
    await app.locator('.conv-item', { hasText: 'first chat here' }).locator('.conv-title').click();
    const r = await timing(app, 'Opening “first chat here');
    expect(r.text).toContain('header and buttons');
    expect(r.text).toMatch(/messages drawn \(\d+\)/);
    expect(r.text).toContain('…and on screen');
    expect(r.line).toMatch(/no freezes · on screen after \d+ ms|freeze|waited/);
    expect(await app.evaluate(() => JSON.parse(localStorage.getItem('ocm.perfHistory')).some((e) => e.label.startsWith('While typing')))).toBe(false);
  });
});

test.describe('🩺 a slow frame after a wait on a timer', () => {
  test.use({ appSettings: { prefs: { perfTrace: true } } });
  test('says where the timer was set, though the browser names no code for it', async ({ app }) => {
    // code that waits on a timer, then works for a long time: the browser attributes that to "TimerHandler" only
    await app.evaluate(() => new Promise((res) => {
      const src = 'globalThis.__go = true; (async function waitThenHog() { while (globalThis.__go) { await new Promise((r) => setTimeout(r, 600)); const end = performance.now() + 250; while (performance.now() < end); } })();';
      const sc = document.createElement('script');
      sc.src = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      sc.onload = res;
      document.head.append(sc);
    }));
    await app.click('#input');
    await app.locator('#input').pressSequentially('typing along', { delay: 60 });
    const r = await timing(app, 'While typing');
    await app.evaluate(() => (globalThis.__go = false));
    expect(r.text).toContain('TimerHandler:setTimeout');
    expect(r.text).toMatch(/started from: setTimeout set at .*waitThenHog/);
  });
});

test.describe('🩺 a Claude Code reply, step by step', () => {
  test.use({ appSettings: { prefs: { perfTrace: true } } });
  test('the history says how long each step before Claude Code took, and when its first words came', async ({ app }) => {
    await app.addInitScript((port) => {
      globalThis.__ocmShell = {
        status: async () => ({ available: true, installed: true }),
        addListener: async () => ({ remove() {} }),
        kill: async () => {},
        exec: async ({ cmd }) => {
          const head = cmd.split('\n')[0];
          if (head === '# ocm-claude status') return { output: '@@NODE v22.11.0\n@@CLAUDE 2.1.325 (Claude Code)\n@@ACP yes\n@@AUTH yes claude.ai -\n@@END\n', exit: 0 };
          if (head === '# ocm-claude start') {
            const secret = /printf '%s\\n' '([A-Za-z0-9_-]+)' \|/.exec(cmd)[1];
            await fetch(`${globalThis.__MOCK}/__spawn-acp?port=${port}&secret=${encodeURIComponent(secret)}`);
            return { output: `@@PORT ${port}\n`, exit: 0 };
          }
          return { output: '', exit: 0 };
        },
      };
    }, 41798);
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await app.evaluate(() => document.querySelector('#model-btn').click());
    await app.click('#model-list .cc-model >> nth=0', { timeout: 15000 });
    await app.fill('#input', 'echo hello');
    await app.click('#send-btn');
    const r = await timing(app, 'Claude Code reply');
    expect(r.text).toMatch(/Claude Code (started \(it was not running\)|was running) \(\+\d+\.\d s\)/);
    expect(r.text).toContain('connected');
    expect(r.text).toMatch(/new session started|earlier session reopened/);
    expect(r.text).toContain('message sent');
    expect(r.text).toMatch(/first words from Claude Code \(\+\d+\.\d s after sending\)/);
    expect(r.text).toContain('reply done');
    expect(r.line).toMatch(/^first words after \d+\.\d s · slowest: .+ \(\d+\.\d s\)/);
  });
});

// Decision 258: opening a chat draws the chat list once (it was two or three times), and a folder opens and shuts in place
test.describe('the chat list with many chats', () => {
  // a wide screen, where the list stays beside the chat (on a phone the drawer shuts when a chat is picked)
  test.use({ appSettings: { folders: [{ id: 'f1', name: 'Work', mode: 'chat' }] }, viewport: { width: 1100, height: 800 } });
  test('a chat opened from the list redraws it at most once; a folder toggles without redrawing the list', async ({ app }) => {
    await app.evaluate(() => new Promise((res) => {
      const q = indexedDB.open('chronicle');
      q.onsuccess = () => {
        const t = q.result.transaction('conversations', 'readwrite');
        const now = Date.now();
        for (let i = 0; i < 40; i++)
          t.objectStore('conversations').put({ id: 'c' + i, title: `Chat ${i}`, folderId: i < 6 ? 'f1' : undefined, createdAt: now - i * 3600e3, updatedAt: now - i * 3600e3, messages: [{ role: 'user', content: `hello ${i} needle${i}`, at: now }, { role: 'assistant', content: 'hi', at: now }] });
        t.oncomplete = res;
      };
    }));
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await expect(app.locator('#conv-list .conv-item')).toHaveCount(40);
    const watch = () =>
      app.evaluate(() => {
        globalThis.__clears = 0;
        globalThis.__mo?.disconnect();
        globalThis.__mo = new MutationObserver((l) => l.forEach((r) => r.removedNodes.length > 3 && globalThis.__clears++)); // the whole list at once
        globalThis.__mo.observe(document.querySelector('#conv-list'), { childList: true });
      });
    await watch();
    await app.locator('#conv-list .conv-item', { hasText: 'Chat 20' }).locator('.conv-title').click();
    await expect(app.locator('.msg.user').first()).toContainText('hello 20');
    expect(await app.evaluate(() => globalThis.__clears)).toBeLessThanOrEqual(1);
    await watch();
    const folder = app.locator('.folder-row .folder-title', { hasText: 'Work' });
    await folder.click();
    await expect(app.locator('#conv-list .conv-item.in-folder')).toHaveCount(0);
    await folder.click();
    await expect(app.locator('#conv-list .conv-item.in-folder')).toHaveCount(6);
    expect(await app.evaluate(() => globalThis.__clears)).toBe(0);
    // the search still finds words in the messages
    await app.fill('#conv-search', 'needle33');
    await expect(app.locator('#conv-list')).toContainText('Chat 33');
  });
});
