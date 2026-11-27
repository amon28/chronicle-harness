import { test, expect, send } from './helpers.js';

// a long chat: after a reply (or a retry) the view must stay at the bottom
test('long chats stay scrolled to the bottom after a reply and after Retry', async ({ app }) => {
  await app.evaluate(async () => {
    const para = (i) => `Paragraph ${i}. ` + 'Some long roleplay text that wraps over several lines on a phone screen. '.repeat(8 + (i % 7) * 4);
    const messages = [];
    for (let i = 0; i < 120; i++) messages.push(i % 2 ? { role: 'assistant', content: para(i) + '\n\n' + para(i + 1), personaId: 'general', model: 'glm-5.3', at: Date.now() } : { role: 'user', content: 'Short ' + i, at: Date.now() });
    const conv = { id: 'sc1', title: 'Scroll test', createdAt: Date.now(), updatedAt: Date.now(), personaId: 'general', messages };
    await new Promise((res) => { const r = indexedDB.open('chronicle'); r.onsuccess = () => { const t = r.result.transaction('conversations', 'readwrite'); t.objectStore('conversations').put(conv); t.oncomplete = res; }; });
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.click('.conv-title:has-text("Scroll test")');
  await app.waitForSelector('.msg');
  const gap = () => app.evaluate(() => { const m = document.getElementById('messages'); return Math.round(m.scrollHeight - m.scrollTop - m.clientHeight); });
  await app.waitForTimeout(300);
  expect(await gap()).toBeLessThan(30);
  await send(app, 'LONGREPLY please');
  await app.waitForTimeout(400);
  expect(await gap()).toBeLessThan(30);
  await app.locator('.msg.assistant').last().locator('.act:has-text("Retry")').click();
  await app.waitForFunction(() => !document.body.classList.contains('streaming'));
  await app.waitForTimeout(400);
  expect(await gap()).toBeLessThan(30);
});

test('the thinking box keeps its scroll position while a reply streams in', async ({ app }) => {
  await app.fill('#input', 'LONGTHINK please');
  await app.click('#send-btn');
  const body = app.locator('.msg.assistant .reasoning-body').last();
  await expect(body).toBeVisible();
  await expect.poll(() => app.evaluate(() => { const b = [...document.querySelectorAll('.msg.assistant .reasoning-body')].pop(); return b ? b.scrollHeight - b.clientHeight : 0; })).toBeGreaterThan(300);
  // while it is still thinking, scroll the box up a little and make sure the next tokens don't snap it back
  // one synchronous step in the page: the box is redrawn constantly, a handle resolved earlier could already be gone
  await app.evaluate(() => ([...document.querySelectorAll('.msg.assistant .reasoning-body')].pop().scrollTop = 120));
  await app.waitForTimeout(700);
  expect(await app.evaluate(() => [...document.querySelectorAll('.msg.assistant .reasoning-body')].pop().scrollTop)).toBe(120);
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
});

test.describe('tool cards', () => {
  test.use({ appSettings: { prefs: { tools: true } } });
  test('a tool card you open while it is being written stays open', async ({ app }) => {
    await app.fill('#input', 'SLOWTOOL please');
    await app.click('#send-btn');
    const card = app.locator('.tool-card').last();
    await expect(card).toBeVisible();
    await app.evaluate(() => [...document.querySelectorAll('.tool-card')].pop().querySelector('summary').click());
    await app.waitForTimeout(900);
    expect(await app.evaluate(() => [...document.querySelectorAll('.tool-card')].pop().open)).toBe(true);
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  });
});

test.describe('a finished agent reply', () => {
  test.use({ appSettings: { prefs: { tools: true } } });
  test('does not move what you are reading when it finishes', async ({ app }) => {
    await app.fill('#input', 'STEPSTHENTEXT please');
    await app.click('#send-btn');
    await app.waitForFunction(() => /Answer paragraph 25/.test(document.querySelector('#messages')?.innerText || ''), null, { timeout: 30000 });
    // scroll up into the answer, away from the end, and note where a paragraph is on screen
    const before = await app.evaluate(() => {
      const m = document.getElementById('messages');
      m.dispatchEvent(new WheelEvent('wheel', { deltaY: -400 }));
      m.scrollTop = m.scrollTop - 600;
      const p = [...m.querySelectorAll('.msg.assistant p')].find((x) => /Answer paragraph 12\./.test(x.textContent));
      return Math.round(p.getBoundingClientRect().top);
    });
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
    await app.waitForTimeout(500);
    const after = await app.evaluate(() => {
      const p = [...document.querySelectorAll('#messages .msg.assistant p')].find((x) => /Answer paragraph 12\./.test(x.textContent));
      return Math.round(p.getBoundingClientRect().top);
    });
    expect(Math.abs(after - before)).toBeLessThan(4);
  });
});
