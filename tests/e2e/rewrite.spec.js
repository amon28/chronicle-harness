import { test, expect, send } from './helpers.js';

test('correct a reply with an instruction: see the change as a diff, then keep it', async ({ app }) => {
  await send(app, 'hello');
  const reply = app.locator('.msg.assistant').last();
  const before = await reply.locator('.md').last().innerText();
  expect(before).toContain('bold');
  await reply.locator('.act-more').click();
  await app.click('#mm-correct');
  await app.fill('#mm-correct-text', 'make it italic');
  await app.click('#mm-correct-go');
  await expect(app.locator('#mm-correct-diff ins').first()).toContainText('italic');
  await expect(app.locator('#mm-correct-diff del').first()).toContainText('bold');
  await app.click('#mm-correct-keep');
  await expect(reply.locator('.md').last()).toContainText('italic');
  await expect(reply.locator('.md').last()).not.toContainText('bold');
});

test('/polish tidies the draft in the box; /unpolish puts it back', async ({ app }) => {
  await app.fill('#input', '/polish i saw teh cat');
  await app.click('#send-btn');
  await expect(app.locator('#input')).toHaveValue('I saw the cat');
  await expect(app.locator('.msg.user')).toHaveCount(0); // nothing was sent
  await app.fill('#input', '/unpolish');
  await app.click('#send-btn');
  await expect(app.locator('#input')).toHaveValue('i saw teh cat');
});

test('a half-typed message survives the app being closed', async ({ app }) => {
  await app.fill('#input', 'a long message I was still writing');
  await app.evaluate(() => dispatchEvent(new Event('pagehide')));
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await expect(app.locator('#input')).toHaveValue('a long message I was still writing');
});
