import { test, expect, send } from './helpers.js';

test('story map shows the original and its fork, and opens the other chat', async ({ app }) => {
  await send(app, 'first question');
  await app.click('#menu-btn');
  await app.click('.conv-item.active .conv-more');
  await app.click('#cm-fork');
  await expect(app.locator('#messages > .msg')).toHaveCount(2);
  await app.evaluate(() => document.getElementById('scrim').click());
  await app.click('#persona-name-btn');
  await app.click('#chat-map');
  await expect(app.locator('#smap-tree .smap-node')).toHaveCount(2);
  await expect(app.locator('#smap-tree .smap-node.current')).toContainText('(fork)');
  await app.locator('#smap-tree .smap-node:not(.current)').click();
  await expect(app.locator('#smap-sheet')).not.toHaveClass(/open/);
  await app.click('#persona-name-btn');
  await expect(app.locator('#chat-fork-box')).toContainText('1 fork of this chat');
});

test('story map lists a retried reply as a fork and jumps to the other version', async ({ app }) => {
  await send(app, 'hello');
  await app.locator('.msg.assistant').last().locator('.act[aria-label="Retry"]').click();
  await app.waitForFunction(() => !document.body.classList.contains('streaming') && document.querySelector('.msg.assistant:last-child .pager-num')?.textContent === '2/2', null, { timeout: 15000 });
  await app.click('#persona-name-btn');
  await app.click('#chat-map');
  await expect(app.locator('#smap-alts .smap-fork')).toContainText('the reply was retried · 2 versions');
  await expect(app.locator('#smap-alts .smap-opt')).toHaveCount(2);
  await app.locator('#smap-alts .smap-opt:not(.current)').click();
  await expect(app.locator('.msg.assistant:last-child .pager-num')).toHaveText('1/2');
});
