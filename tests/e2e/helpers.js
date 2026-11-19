import { test as base, expect } from '@playwright/test';

// one mock server per worker (playwright.config.js starts 8788, 8789, …): each has its own request log, so tests in
// different workers do not see each other's requests. globalThis.__MOCK is the same address for code that runs in the
// test (Node) and, through the init script below, in the page.
export const MOCK = `http://localhost:${8788 + Number(process.env.TEST_PARALLEL_INDEX || 0)}`;
globalThis.__MOCK = MOCK;

/** A page with the app opened and pointed at the mock API (fresh storage per test). */
export const test = base.extend({
  // per-test overrides, e.g. test.use({ appSettings: { model: 'kimi-k3', prefs: { tools: true } } })
  appSettings: [{}, { option: true }],
  app: async ({ page, request, appSettings }, use) => {
    await request.post(MOCK + '/__reset');
    const seed = { apiKey: 'good', proxyUrl: MOCK, model: 'glm-5.3', ...appSettings, prefs: { learn: false, autoTitle: false, tools: false, userName: 'Alex', ...(appSettings.prefs || {}) } };
    await page.addInitScript((mock) => (globalThis.__MOCK = mock), MOCK);
    await page.addInitScript((seed) => {
      try {
        if (!localStorage.getItem('ocm.settingsInIdb') && !localStorage.getItem('ocm.settings')) localStorage.setItem('ocm.settings', JSON.stringify(seed));
      } catch {
        /* ignore */
      }
    }, seed);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await expect(page.locator('#input')).toBeVisible();
    await page.waitForSelector('body[data-ready="1"]'); // the static page is visible before the app has started
    await use(page);
    expect(errors, 'uncaught page errors').toEqual([]);
  },
});
export { expect };

export async function send(page, text) {
  await page.fill('#input', text);
  await page.click('#send-btn');
  await page.waitForFunction(() => document.body.classList.contains('streaming') || document.querySelector('.msg.assistant:last-child .msg-actions'), null, { timeout: 10_000 });
  await page.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30_000 });
}

export const lastRequest = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages).pop();

export const closeSheets = (page) => page.evaluate(() => document.querySelectorAll('.sheet.open').forEach((x) => x.querySelector('[data-close]')?.click()));

/** The tools a request offers: sent in full, or held back by name in load_tools' list (decision 175). */
export const offeredTools = (req) => (req?.tools || []).flatMap((t) => (t.function.name === 'load_tools' ? [...String(t.function.description || '').matchAll(/^- ([\w-]+):/gm)].map((m) => m[1]) : [t.function.name]));
