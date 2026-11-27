import { test, expect } from './helpers.js';

// Background protection said honestly (decision 172): Android refusing the foreground service, or stopping it at its
// time limit, reaches the user instead of failing silently. A stand-in KeepAlive plays Android.
const fake = (mode) => {
  globalThis.__toasts = [];
  // every toast, also one a later toast replaces (the script runs before the page exists: watch once it does)
  document.addEventListener('DOMContentLoaded', () =>
    new MutationObserver(() => {
      const t = document.getElementById('toast')?.textContent;
      if (t && globalThis.__toasts.at(-1) !== t) globalThis.__toasts.push(t);
    }).observe(document.body, { subtree: true, childList: true, characterData: true }),
  );
  const st = (globalThis.__bg = { running: false, startedAt: 0, lastStop: '', lastStopAt: 0, notifications: true, batteryFree: true });
  globalThis.__ocmKeepAlive = {
    start: async () => {
      st.startedAt = Date.now();
      if (mode === 'refused-now') return { started: false, reason: 'refused: Android does not allow it while the app is in the background' };
      if (mode === 'refused-later') Object.assign(st, { running: false, lastStop: 'refused: ForegroundServiceStartNotAllowedException', lastStopAt: Date.now() + 1 });
      else st.running = true;
      return { started: true };
    },
    stop: async () => Object.assign(st, { running: false, lastStop: 'finished', lastStopAt: Date.now() }),
    status: async () => ({ ...st }),
    requestPermission: async () => ({ granted: true }),
    notify: async () => {},
    clear: async () => {},
    pendingActions: async () => ({ actions: [] }),
    addListener: async () => ({ remove() {} }),
  };
  Object.defineProperty(document, 'hidden', { get: () => !!globalThis.__away, configurable: true });
};
const setUp = async (app, mode) => {
  await app.addInitScript(fake, mode);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
};
const toasts = (app) => app.evaluate(() => globalThis.__toasts.join('\n'));

test.describe('background protection', () => {
  test.use({ appSettings: { prefs: { tools: true } } });

  test('a start Android refuses at once is said once, with why', async ({ app }) => {
    await setUp(app, 'refused-now');
    await app.fill('#input', 'STEPSTHENTEXT please');
    await app.click('#send-btn');
    await expect.poll(() => toasts(app), { timeout: 10000 }).toContain('Background protection is not running (Android does not allow it while the app is in the background)');
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
    expect((await toasts(app)).split('Background protection is not running').length - 1).toBe(1);
  });

  test('a service refused just after the start is said too', async ({ app }) => {
    await setUp(app, 'refused-later');
    await app.fill('#input', 'STEPSTHENTEXT please');
    await app.click('#send-btn');
    await expect.poll(() => toasts(app), { timeout: 10000 }).toContain('not running (ForegroundServiceStartNotAllowedException)');
  });

  test('a pause at Android\'s time limit is said when the app is opened again, once; a normal reply says nothing', async ({ app }) => {
    await setUp(app, 'ok');
    await app.fill('#input', 'hello');
    await app.click('#send-btn');
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
    expect(await toasts(app)).not.toContain('Background protection');
    // away; Android stops the service at its limit; back
    await app.evaluate(() => {
      globalThis.__away = true;
      document.dispatchEvent(new Event('visibilitychange'));
      Object.assign(globalThis.__bg, { running: false, lastStop: 'time limit', lastStopAt: Date.now() + 5 });
    });
    await app.waitForTimeout(50);
    const back = () => app.evaluate(() => {
      globalThis.__away = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await back();
    await expect.poll(() => toasts(app)).toContain('Android paused background work at its time limit');
    await app.evaluate(() => (globalThis.__away = true));
    await back();
    await app.waitForTimeout(300);
    expect((await toasts(app)).split('paused background work').length - 1).toBe(1);
  });
});

test.describe('a reply the app did not live to finish', () => {
  test.use({ appSettings: { prefs: { tools: true } } });
  test('a reply being written is saved when the app goes to the background; killed then, it says so, and Continue finishes it', async ({ app }) => {
    await app.addInitScript(() => Object.defineProperty(document, 'hidden', { get: () => !!globalThis.__away, configurable: true }));
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await app.fill('#input', 'STEPSTHENTEXT please');
    await app.click('#send-btn');
    await expect(app.locator('.msg.assistant').last()).toContainText('Answer paragraph 3', { timeout: 20000 });
    await app.evaluate(() => {
      globalThis.__away = true; // the user switched apps…
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await app.waitForTimeout(300);
    await app.reload(); // …and Android killed Chronicle: what the next start sees
    await app.waitForSelector('body[data-ready="1"]');
    await app.click('#menu-btn');
    await app.locator('#conv-list .conv-item').first().click();
    const last = app.locator('.msg.assistant').last();
    await expect(last.locator('.msg-cut')).toContainText('The app was closed (or Android stopped it) before this reply was finished', { timeout: 10000 });
    await last.locator('.msg-cut button', { hasText: 'Continue' }).click();
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
    await expect(last.locator('.msg-cut')).toHaveCount(0);
  });
});

// Decision 258: after the first save of a run, only the reply being written is saved (on its own); the next start puts it
// back into its chat – the whole chat is not written again every few seconds
test.describe('saving a reply while it is written', () => {
  test.use({ appSettings: { prefs: { tools: true } } });
  test('later saves write only the reply, and a kill after them still keeps what it had', async ({ app }) => {
    await app.addInitScript(() => Object.defineProperty(document, 'hidden', { get: () => !!globalThis.__away, configurable: true }));
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    const away = () =>
      app.evaluate(() => {
        globalThis.__away = true;
        document.dispatchEvent(new Event('visibilitychange'));
        globalThis.__away = false;
      });
    const stored = () =>
      app.evaluate(() => new Promise((res) => {
        const q = indexedDB.open('chronicle');
        q.onsuccess = () => {
          const r = globalThis.__ocmChatsReq();
          r.onsuccess = () => res(JSON.stringify(r.result));
        };
      }));
    await app.fill('#input', 'STEPSTHENSLOW please');
    await app.click('#send-btn');
    const last = app.locator('.msg.assistant').last();
    await expect(last).toContainText('Answer paragraph 3', { timeout: 20000 });
    await away(); // the first save of the run: the whole chat
    await app.waitForTimeout(300);
    const first = await stored();
    expect(first).toContain('Answer paragraph 3');
    await expect(last).toContainText('Answer paragraph 12', { timeout: 20000 });
    expect(await app.evaluate(() => document.body.classList.contains('streaming'))).toBe(true); // still writing
    await away(); // a later one: the reply only
    await app.waitForTimeout(300);
    expect(await stored()).not.toContain('Answer paragraph 12'); // the chat's own record was not written again
    await app.reload(); // killed: the next start puts the reply back
    await app.waitForSelector('body[data-ready="1"]');
    await app.click('#menu-btn');
    await app.locator('#conv-list .conv-item').first().click();
    await expect(last).toContainText('Answer paragraph 12');
    await expect(last.locator('.msg-cut')).toContainText('before this reply was finished');
    await expect(app.locator('.msg.user')).toHaveCount(1);
  });
});
