import { test, expect, MOCK } from './helpers.js';

const requests = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);
const idle = (app) => app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });

test('a message sent while the assistant is writing is queued, then sent when the reply is done', async ({ app }) => {
  await app.fill('#input', 'LONGTHINK first question');
  await app.click('#send-btn');
  await expect(app.locator('body')).toHaveClass(/streaming/);
  await app.fill('#input', 'second question');
  await expect(app.locator('#steer-btn')).toBeVisible(); // typing while it writes offers queue (send) and steer
  await app.click('#send-btn'); // = queue
  await expect(app.locator('#queue-bar .queue-item')).toHaveCount(1);
  await expect(app.locator('#queue-bar')).toContainText('second question');
  await expect(app.locator('.msg.user')).toHaveCount(1); // not sent yet
  // it goes out by itself once the first reply is finished
  await expect(app.locator('.msg.user')).toHaveCount(2, { timeout: 25000 });
  await expect(app.locator('.msg.user').last()).toContainText('second question');
  await idle(app);
  await expect(app.locator('.msg.assistant')).toHaveCount(2);
  await expect(app.locator('#queue-bar')).toBeHidden();
});

test('a queued message can be removed, and stopping the reply keeps the queue from sending', async ({ app }) => {
  await app.fill('#input', 'LONGTHINK first');
  await app.click('#send-btn');
  await app.fill('#input', 'never mind this');
  await app.click('#send-btn');
  await expect(app.locator('#queue-bar .queue-item')).toHaveCount(1);
  await app.click('#queue-bar .queue-item button');
  await expect(app.locator('#queue-bar')).toBeHidden();
  await app.fill('#input', 'second one');
  await app.click('#send-btn');
  await expect(app.locator('#queue-bar .queue-item')).toHaveCount(1);
  await app.fill('#input', ''); // nothing typed: the button is Stop
  await app.click('#send-btn');
  await idle(app);
  await app.waitForTimeout(1200);
  await expect(app.locator('.msg.user')).toHaveCount(1); // it did not send: you stopped the reply
  await expect(app.locator('#queue-bar .queue-item')).toHaveCount(1);
});

test('steer interrupts a plain reply and answers the new message right away', async ({ app }) => {
  await app.fill('#input', 'LONGTHINK tell me a long story');
  await app.click('#send-btn');
  await expect(app.locator('body')).toHaveClass(/streaming/);
  await app.fill('#input', 'actually, make it short');
  await app.click('#steer-btn');
  await expect(app.locator('.msg.user')).toHaveCount(2, { timeout: 10000 });
  await expect(app.locator('.msg.user').last()).toContainText('make it short');
  await idle(app);
});

test.describe('agent turn', () => {
  test.use({ appSettings: { prefs: { tools: true } } });
  test('steering during tool work reaches the model at its next step', async ({ app, request }) => {
    await app.fill('#input', 'SLOWTOOL write me a file');
    await app.click('#send-btn');
    await expect(app.locator('body')).toHaveClass(/streaming/);
    await app.fill('#input', 'use blue');
    await app.click('#steer-btn');
    await idle(app);
    await expect(app.locator('.steer-note')).toContainText('use blue');
    const last = (await requests(request)).at(-1).messages;
    const iTool = last.findIndex((m) => m.role === 'tool');
    expect(iTool).toBeGreaterThan(0);
    expect(last[iTool + 1]).toMatchObject({ role: 'user', content: 'use blue' });
  });
});
