import { test, expect, send, MOCK } from './helpers.js';

test.use({ appSettings: { prefs: { tools: true } } });
const requests = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);

test('ask_user stops the agent with tappable choices and passes your answer back', async ({ app, request }) => {
  await app.fill('#input', 'ASKME build a page');
  await app.click('#send-btn');
  await expect(app.locator('#ask-sheet')).toHaveClass(/open/);
  await expect(app.locator('#ask-question')).toHaveText('Which layout do you want?');
  await expect(app.locator('#ask-options .menu-item')).toHaveText(['Grid', 'List']);
  await app.click('#ask-options .menu-item:has-text("Grid")');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
  await expect(app.locator('.tool-card', { hasText: 'Asked you' })).toBeVisible();
  const tool = (await requests(request)).at(-1).messages.find((m) => m.role === 'tool');
  expect(tool.content).toContain('The user answered: Grid');
});

test('ask_user can be skipped, which tells the model to decide', async ({ app, request }) => {
  await app.fill('#input', 'ASKME build a page');
  await app.click('#send-btn');
  await app.click('#ask-skip');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
  const tool = (await requests(request)).at(-1).messages.find((m) => m.role === 'tool');
  expect(tool.content).toContain('decide for yourself');
});

test('todo_write shows a progress chip and the list', async ({ app }) => {
  await send(app, 'PLANME build a page');
  await expect(app.locator('#todo-btn')).toContainText('1/3');
  await expect(app.locator('#todo-btn')).toContainText('Write the page');
  await expect(app.locator('.tool-card .todo-list li')).toHaveCount(3);
  await app.click('#todo-btn');
  await expect(app.locator('#todo-items li')).toHaveText(['☑ Look at the site', '▶ Write the page', '☐ Test on a phone']);
  await app.click('#todo-clear');
  await expect(app.locator('#todo-btn')).toBeHidden();
});

test('several questions come as pages with back / next arrows, and one answer goes back', async ({ app, request }) => {
  await app.fill('#input', 'ASKMULTI build a page');
  await app.click('#send-btn');
  await expect(app.locator('#ask-sheet')).toHaveClass(/open/);
  await expect(app.locator('#ask-page')).toHaveText('1 / 3');
  await app.click('#ask-options .menu-item:has-text("Grid")'); // answers and moves on
  await expect(app.locator('#ask-page')).toHaveText('2 / 3');
  await app.click('#ask-prev'); // back: the first answer is still marked
  await expect(app.locator('#ask-options .menu-item.current')).toHaveText('Grid');
  await app.click('#ask-next');
  await app.click('#ask-options .menu-item:has-text("Dark")');
  await expect(app.locator('#ask-page')).toHaveText('3 / 3');
  await app.fill('#ask-other', 'My Site');
  await expect(app.locator('#ask-send')).toHaveText('Send answers');
  await app.click('#ask-send');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
  const tool = (await requests(request)).at(-1).messages.find((m) => m.role === 'tool');
  expect(tool.content).toContain('Answer: Grid');
  expect(tool.content).toContain('Answer: Dark');
  expect(tool.content).toContain('Answer: My Site');
});

test('a tap outside does not answer; hiding keeps the question, and it belongs to its own chat', async ({ app, request }) => {
  await app.fill('#input', 'ASKME build a page');
  await app.click('#send-btn');
  await expect(app.locator('#ask-sheet')).toHaveClass(/open/);
  // a tap on the dim area does nothing
  await app.evaluate(() => document.getElementById('ask-sheet').click());
  await expect(app.locator('#ask-sheet')).toHaveClass(/open/);
  // hide it, go to another chat: no question there, the first chat is marked in the list
  await app.click('#ask-hide');
  await expect(app.locator('#ask-chip')).toBeVisible();
  await app.click('#menu-btn');
  await expect(app.locator('#conv-list .ask-mark')).toHaveCount(1);
  await app.click('#drawer-new');
  await expect(app.locator('#ask-sheet')).not.toHaveClass(/open/);
  await expect(app.locator('#ask-chip')).toBeHidden();
  // back in the first chat the chip is there, and it still works
  await app.click('#menu-btn');
  await app.locator('#conv-list .conv-title').first().click();
  await app.click('#ask-chip');
  await expect(app.locator('#ask-sheet')).toHaveClass(/open/);
  await app.click('#ask-options .menu-item:has-text("List")');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
  const tool = (await requests(request)).at(-1).messages.find((m) => m.role === 'tool');
  expect(tool.content).toContain('The user answered: List');
});
