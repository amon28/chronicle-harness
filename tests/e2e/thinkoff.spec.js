import { test, expect, send, lastRequest } from './helpers.js';

// 🧠 off for an OpenCode Go model that can switch its thinking off (decision 204)
test.use({ appSettings: { model: 'qwen3.8-flash' } });

test('🧠 offers "off" for a model with the switch, and sends thinking disabled instead of an effort', async ({ app, request }) => {
  const chip = app.locator('#effort-btn');
  await expect(chip).toBeVisible();
  await chip.click(); // default → off
  await expect(chip).toHaveText('🧠 off');
  await send(app, 'hello');
  const req = await lastRequest(request);
  expect(req.thinking).toEqual({ type: 'disabled' });
  expect(req).not.toHaveProperty('reasoning_effort');
  await chip.click(); // off → low
  await expect(chip).toHaveText('🧠 low');
  await send(app, 'again');
  const req2 = await lastRequest(request);
  expect(req2.reasoning_effort).toBe('low');
  expect(req2).not.toHaveProperty('thinking');
});

test.describe('a model without the switch', () => {
  test.use({ appSettings: { model: 'glm-5.3' } });
  test('has no "off"', async ({ app }) => {
    const chip = app.locator('#effort-btn');
    if (!(await chip.isVisible())) return;
    for (let i = 0; i < 6; i++) {
      await expect(chip).not.toHaveText('🧠 off');
      await chip.click();
    }
  });
});
