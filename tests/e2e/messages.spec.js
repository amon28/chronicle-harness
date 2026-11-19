import { test, expect, send, lastRequest, MOCK } from './helpers.js';

const msgCount = (app) => app.locator('#messages > .msg').count();

test('delete a message, and delete everything after a message', async ({ app }) => {
  await send(app, 'first');
  await send(app, 'second');
  await send(app, 'third');
  expect(await msgCount(app)).toBe(6);

  // delete just the second reply
  await app.locator('.msg.assistant >> nth=1').locator('.act-more').click();
  app.once('dialog', (d) => d.accept());
  await app.click('#mm-delete');
  await expect(app.locator('#messages > .msg')).toHaveCount(5);

  // delete my second message and everything after it
  await app.locator('.msg.user >> nth=1').locator('.act-more').click();
  app.once('dialog', (d) => d.accept());
  await app.click('#mm-delete-after');
  await expect(app.locator('#messages > .msg')).toHaveCount(2);

  // stays deleted after a reload
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.click('.conv-item >> nth=0 >> .conv-title');
  await expect(app.locator('#messages > .msg')).toHaveCount(2);
});

test('fork from a message copies the chat up to it; the original stays', async ({ app }) => {
  await send(app, 'alpha');
  await send(app, 'beta');
  await app.locator('.msg.assistant >> nth=0').locator('.act-more').click();
  await app.click('#mm-branch');
  await expect(app.locator('#messages > .msg')).toHaveCount(2);
  await expect(app.locator('.msg.user')).toHaveText(/alpha/);
  await app.click('#menu-btn');
  await expect(app.locator('.conv-item')).toHaveCount(2);
  await expect(app.locator('.conv-item', { hasText: '(fork)' })).toHaveCount(1);
});

test('retry with guidance sends a one-off instruction; retry with another model uses it', async ({ app, request }) => {
  await send(app, 'tell me a story');
  await app.locator('.msg.assistant').last().locator('.act-more').click();
  await app.click('#mm-retry-guided');
  await app.click('#mm-guide-chips .chip:has-text("Shorter")');
  await app.fill('#mm-guide', (await app.inputValue('#mm-guide')) + ' Add a dragon.');
  await app.click('#mm-guide-go');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'));
  let req = await lastRequest(request);
  expect(req.messages.at(-1)).toEqual({ role: 'system', content: '[For this reply only – the user asked: Shorter. Add a dragon.]' });
  await expect(app.locator('.msg.assistant').last().locator('.pager-num')).toHaveText('2/2');

  await request.post(MOCK + '/__reset');
  await app.locator('.msg.assistant').last().locator('.act-more').click();
  await app.click('#mm-retry-model');
  await app.selectOption('#mm-model', 'kimi-k3');
  await app.click('#mm-model-go');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'));
  req = await lastRequest(request);
  expect(req.model).toBe('kimi-k3');
  expect(req.messages.some((m) => String(m.content).includes('For this reply only'))).toBe(false); // guidance was one-off
  await expect(app.locator('.msg.assistant').last().locator('.pager-num')).toHaveText('3/3');
  await expect(app.locator('#model-name')).not.toHaveText(/Kimi/); // the chat's own model is unchanged
});

test('send with nothing typed carries the story on with a NEW message', async ({ app, request }) => {
  const btn = app.locator('#send-btn');
  await send(app, 'hello');
  await expect(btn).toHaveClass(/go-on/); // empty box + something to continue from → ▶▶
  await app.fill('#input', 'typing…');
  await expect(btn).not.toHaveClass(/go-on/);
  await app.fill('#input', '');
  await expect(btn).toHaveClass(/go-on/);

  const before = await app.locator('.msg.assistant .md').first().textContent();
  await btn.click();
  await app.waitForFunction(() => !document.body.classList.contains('streaming') && document.querySelectorAll('.msg.assistant').length === 2);
  await expect(app.locator('.msg.assistant').last()).toContainText('And so the story went on.');
  await expect(app.locator('.msg.assistant .md').first()).toHaveText(before); // the first reply is untouched
  await expect(app.locator('.msg.user')).toHaveCount(1); // no empty user message was added
  const req = await lastRequest(request);
  expect(req.messages.at(-1).role).toBe('system');
  expect(req.messages.at(-1).content).toContain('The user sent nothing – carry on');
});

test('send with nothing typed in a group lets the next member speak', async ({ app }) => {
  await app.click('#persona-name-btn');
  await app.click('#chat-make-group');
  await app.click('#ge-members .persona-item:has-text("Coder")');
  await app.selectOption('#ge-mode', 'all');
  await app.click('#ge-save');
  await app.fill('#input', 'hi both');
  await app.click('#send-btn');
  await app.waitForFunction(() => document.querySelectorAll('.msg.assistant').length === 2 && !document.body.classList.contains('streaming'));
  await app.click('#send-btn'); // empty → the next speaker in the order
  await app.waitForFunction(() => document.querySelectorAll('.msg.assistant').length === 3 && !document.body.classList.contains('streaming'));
  await expect(app.locator('.msg.assistant').last()).toContainText('Assistant speaking.'); // wrapped around to the first member
});

test('retry an EARLIER reply: the later messages are kept with the old version', async ({ app, request }) => {
  await send(app, 'one');
  await send(app, 'two');
  await send(app, 'three');
  expect(await msgCount(app)).toBe(6);

  // retry the very first reply, with guidance – it must only see the history up to that point
  await app.locator('.msg.assistant').first().locator('.act-more').click();
  await app.click('#mm-retry-guided');
  await app.fill('#mm-guide', 'Make it dramatic.');
  await app.click('#mm-guide-go');
  await app.waitForFunction(() => !document.body.classList.contains('streaming') && document.querySelectorAll('#messages > .msg').length === 2);
  const req = await lastRequest(request);
  const seen = req.messages.map((m) => String(m.content)).join('\n');
  expect(seen).toContain('one');
  expect(seen).not.toContain('two'); // the later messages aren't sent
  expect(seen).not.toContain('three');
  expect(req.messages.at(-1).content).toContain('Make it dramatic.');
  const pager = app.locator('.msg.assistant').first().locator('.pager-num');
  await expect(pager).toHaveText('2/2');

  // swipe back: the old reply AND everything after it come back
  // (the swipe is ignored while the reply is still being wrapped up, so try until it takes)
  await expect(async () => {
    if ((await app.locator('#messages > .msg').count()) !== 6) await app.locator('.msg.assistant').first().locator('.pager-btn >> nth=0').click();
    await expect(app.locator('#messages > .msg')).toHaveCount(6, { timeout: 1500 });
  }).toPass({ timeout: 15000 });
  await expect(app.locator('.msg.assistant').first()).toContainText('Reply #1');
  await expect(app.locator('.msg.user').last()).toContainText('three');
  await expect(app.locator('.msg.assistant').last()).toContainText('Reply #3');

  // and forward again: the new version, without the later messages
  await app.locator('.msg.assistant').first().locator('.pager-btn >> nth=1').click();
  await expect(app.locator('#messages > .msg')).toHaveCount(2);

  // it all survives a reload
  await app.locator('.msg.assistant').first().locator('.pager-btn >> nth=0').click();
  await expect(app.locator('#messages > .msg')).toHaveCount(6);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.click('.conv-item >> nth=0 >> .conv-title');
  await expect(app.locator('#messages > .msg')).toHaveCount(6);
});

test('plain retry works on any reply, and › at the newest version generates another', async ({ app }) => {
  await send(app, 'one');
  await send(app, 'two');
  await app.locator('.msg.assistant').first().locator('.act-more').click();
  await app.click('#mm-retry');
  await app.waitForFunction(() => !document.body.classList.contains('streaming') && document.querySelectorAll('#messages > .msg').length === 2);
  await app.locator('.msg.assistant').first().locator('.pager-btn >> nth=1').click(); // › on the newest = another
  await app.waitForFunction(() => !document.body.classList.contains('streaming'));
  await expect(app.locator('.msg.assistant').first().locator('.pager-num')).toHaveText('3/3');
  await expect(app.locator('#messages > .msg')).toHaveCount(2);
});

test('deleting my own message offers to take the replies after it too', async ({ app }) => {
  await send(app, 'first');
  await send(app, 'second');
  expect(await msgCount(app)).toBe(4);
  await app.locator('.msg.user >> nth=0').locator('.act-more').click();
  await app.click('#mm-delete');
  await expect(app.locator('#choose-list .menu-item').first()).toContainText('This and the 3 messages after it');
  await app.click('#choose-list .menu-item >> nth=0');
  await expect(app.locator('#messages > .msg')).toHaveCount(0);
});
