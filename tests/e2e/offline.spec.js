import { test, expect } from './helpers.js';

// No network is not a server error: the reply waits for it and goes on by itself (decision 199)
test.use({ appSettings: { fallbackModel: '', prefs: { fallbackModel: 'kimi-k3' } } });

test('a message sent without network waits for it, then the reply comes – no retries spent, no fallback model', async ({ app, context }) => {
  await context.setOffline(true);
  await app.fill('#input', 'hello from a tunnel');
  await app.click('#send-btn');
  const reply = app.locator('.msg.assistant').last();
  await expect(reply).toContainText('No network – waiting for it to come back', { timeout: 15000 });
  await app.waitForTimeout(1500);
  await expect(reply).not.toContainText('switching to'); // the fallback model is not tried for a missing network
  await context.setOffline(false);
  await expect(reply).toContainText('Reply #1', { timeout: 20000 }); // the reply came once the network was back
  await expect(app.locator('body')).not.toHaveClass(/streaming/, { timeout: 10000 });
  expect(await reply.locator('.msg-error, .error').count()).toBe(0);
});
