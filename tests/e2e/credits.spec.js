import { test, expect, send, MOCK } from './helpers.js';

// Out of Anthropic credits (decision 227): said plainly, with Billing and "another model" under the reply.
test.use({
  appSettings: {
    model: 'pvT:claude-opus-5-5',
    providers: [{ id: 'pvT', kind: 'anthropic', name: 'Anthropic (Claude)', baseUrl: MOCK + '/anthropic', apiKey: 'sk-ant-good', via: 'native', models: 'claude-opus-5-5', context: 1000000, enabled: true }],
  },
});

test('a request refused for a too-low credit balance says the credits ran out, and offers Billing and another model', async ({ app }) => {
  await app.route(
    (u) => u.pathname.startsWith('/anthropic/v1/messages'),
    (r) => r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } }) }),
  );
  await send(app, 'hello');
  const reply = app.locator('.msg.assistant').last();
  await expect(reply.locator('.msg-error')).toContainText('💳 Your Anthropic credits ran out.');
  await expect(reply.locator('.msg-error')).toContainText('credit balance is too low');
  await expect(reply.locator('.credits-row button')).toHaveText(['💳 Open Billing', '↻ Another model']);
  // another model: the message menu's model picker opens, on a model that is not this one
  await reply.locator('.credits-row button', { hasText: 'Another model' }).click();
  await expect(app.locator('#mm-model-box')).toBeVisible();
  expect(await app.locator('#mm-model').inputValue()).not.toBe('pvT:claude-opus-5-5');
});
