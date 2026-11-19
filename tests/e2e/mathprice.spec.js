import { test, expect, send } from './helpers.js';

// "$" as a price is not a formula (decision 203)
test('two prices with a sentence between them stay text; real maths still renders', async ({ app }) => {
  await send(app, 'go to opencode go. They raised the limit of GLM 5.3 to 200$. Now I want to compare usage between it and deepseek flash. Deepseek flash limit is 100$.');
  const mine = app.locator('.msg.user').last();
  await expect(mine).toContainText('to 200$. Now I want to compare usage between it and deepseek flash. Deepseek flash limit is 100$.');
  expect(await mine.locator('.math').count()).toBe(0);
  await send(app, 'costs $5 and $10 each; the area is $\\pi r^2$ and let $x$ be a number');
  const second = app.locator('.msg.user').last();
  await expect(second.locator('.math')).toHaveCount(2);
  await expect(second).toContainText('costs $5 and $10 each');
});
