import { test, expect, send, MOCK } from './helpers.js';

// shorten the app's retry pauses (4s / 12s) so the tests are quick
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => (globalThis.__ocmRetryMs = [60, 60]));
});
const chatRequests = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);

test('a Cloudflare 520 from the provider is retried automatically and the reply arrives', async ({ app, request }) => {
  await send(app, 'CF520 please answer');
  await expect(app.locator('.msg-error')).toHaveCount(0);
  await expect(app.locator('.msg.assistant').last()).toContainText('Reply #');
  expect((await chatRequests(request)).length).toBe(2); // the failed try + the retry
});

test('if the provider keeps failing, you get a plain explanation and a Retry button', async ({ app, request }) => {
  await send(app, 'CF520 ALWAYS please');
  const err = app.locator('.msg-error');
  await expect(err).toContainText('Cloudflare error 520');
  await expect(err).toContainText("problem on the provider's servers");
  await expect(err).not.toContainText('"cloudflare_error"'); // not the raw JSON
  await expect(app.locator('.msg.assistant').last().locator('.act:has-text("Retry")')).toBeVisible();
  expect((await chatRequests(request)).length).toBe(3); // 1 + 2 automatic retries
});

test('an empty reply is retried instead of leaving a blank message', async ({ app, request }) => {
  await send(app, 'EMPTYREPLY please');
  await expect(app.locator('.msg-error')).toHaveCount(0);
  await expect(app.locator('.msg.assistant').last()).toContainText('Reply #');
  expect((await chatRequests(request)).length).toBe(2);
});

test('a 429 "overloaded" is retried, and is not blamed on your usage limit', async ({ app, request }) => {
  await send(app, 'OVERLOAD429 hello');
  await expect(app.locator('.msg-error')).toHaveCount(0);
  await expect(app.locator('.msg.assistant').last()).toContainText('Reply #');
  expect((await chatRequests(request)).length).toBe(2);
});

test('if it stays overloaded the message says the provider is busy, not that you hit a limit', async ({ app }) => {
  await send(app, 'OVERLOAD429 ALWAYS hello');
  const err = app.locator('.msg-error');
  await expect(err).toContainText('provider is busy');
  await expect(err).not.toContainText('usage limit');
});

test.describe('fallback model', () => {
  test.use({ appSettings: { model: 'glm-5.3', prefs: { fallbackModel: 'kimi-k3' } } });
  test('a model that stays overloaded is replaced by the fallback model', async ({ app, request }) => {
    await send(app, 'FALLBACKTEST please answer');
    await expect(app.locator('.msg-error')).toHaveCount(0);
    await expect(app.locator('.msg.assistant').last()).toContainText('Reply #');
    await expect(app.locator('.msg.assistant').last().locator('.msg-model')).toContainText('instead of');
    const reqs = await chatRequests(request);
    expect(reqs.map((r) => r.model)).toEqual(['glm-5.3', 'glm-5.3', 'glm-5.3', 'kimi-k3']);
  });
});
