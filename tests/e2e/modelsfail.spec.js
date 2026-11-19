import { test, expect, MOCK } from './helpers.js';

// OpenCode's model list did not come while another provider's did (decision 193): its models stay, nobody is switched
test.use({
  appSettings: {
    model: 'deepseek-v4.1-flash',
    providers: [{ id: 'pvT', kind: 'anthropic', name: 'Anthropic (Claude)', baseUrl: MOCK + '/anthropic', apiKey: 'sk-ant-good', via: 'native', models: 'claude-opus-5-5', context: 1000000, tools: true, vision: true, enabled: true }],
  },
});

test("OpenCode's list failing at a start does not drop its models or switch the chosen one", async ({ app }) => {
  await expect(app.locator('#model-name')).toHaveText('DeepSeek V4.1 Flash');
  // the next start: OpenCode's models endpoint does not answer, the other provider does
  let asked = 0;
  await app.route((u) => u.pathname === '/v1/models', (r) => (asked++, r.fulfill({ status: 503, body: 'down' })));
  await app.route('https://opencode.ai/**', (r) => r.abort());
  const toasts = [];
  app.on('console', () => {});
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.evaluate(() => {
    const t = document.querySelector('#toast');
    new MutationObserver(() => (globalThis.__toasts ||= []).push(t.textContent)).observe(t, { childList: true, characterData: true, subtree: true });
  });
  await expect.poll(() => asked).toBeGreaterThan(0);
  await app.waitForTimeout(800);
  await expect(app.locator('#model-name')).toHaveText('DeepSeek V4.1 Flash'); // not switched
  toasts.push(...(await app.evaluate(() => globalThis.__toasts || [])));
  expect(toasts.join('\n')).not.toMatch(/no longer available/);
  await app.click('#model-btn');
  await expect(app.locator('#model-list .model-item', { hasText: 'Grok 4.7' })).toHaveCount(1); // OpenCode's models stay listed
  await expect(app.locator('#model-list .model-item', { hasText: 'Claude Opus 5.5' })).toHaveCount(1); // with the other provider's
});

test("a custom provider that does not answer at a start keeps its models and the chosen one (decision 193)", async ({ app }) => {
  await app.evaluate(() => {});
  await app.click('#model-btn');
  await app.locator('#model-list .model-item', { hasText: 'Claude Opus 5.5' }).click();
  await expect(app.locator('#model-name')).toHaveText('Claude Opus 5.5');
  // the next start: the provider is down, OpenCode answers
  await app.route((u) => u.pathname.startsWith('/anthropic/v1/models'), (r) => r.fulfill({ status: 503, body: 'down' }));
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.waitForTimeout(1000);
  await expect(app.locator('#model-name')).toHaveText('Claude Opus 5.5');
  await app.click('#model-btn');
  await expect(app.locator('#model-list .model-item', { hasText: 'Claude Opus 5.5' })).toHaveCount(1);
  await expect(app.locator('#model-list .model-item', { hasText: 'Grok 4.7' })).toHaveCount(1);
});
