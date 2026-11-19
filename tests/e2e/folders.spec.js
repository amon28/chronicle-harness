import { test, expect, send } from './helpers.js';

const open = (app) => app.click('#menu-btn');

test('chat folders: create, move a chat in, collapse, rename, new chat inside, delete', async ({ app }) => {
  await send(app, 'plan the aquarium');
  await open(app);
  // create a folder from the drawer
  await app.click('#new-folder');
  await app.fill('#nf-input', 'Aquarium project');
  await app.click('#nf-create');
  await expect(app.locator('.folder-row')).toContainText('Aquarium project');
  await expect(app.locator('.folder-row .folder-count')).toHaveText('0');
  // move the chat into it from the chat's menu
  await app.click('.conv-item.active .conv-more');
  await app.click('#cm-folder');
  await app.click('#cm-folder-list .menu-item:has-text("Aquarium project")');
  await expect(app.locator('.folder-row .folder-count')).toHaveText('1');
  await expect(app.locator('.conv-item.in-folder')).toHaveCount(1);
  // collapse hides the chat, expand shows it again
  await app.click('.folder-title');
  await expect(app.locator('.conv-item.in-folder')).toHaveCount(0);
  await app.click('.folder-title');
  await expect(app.locator('.conv-item.in-folder')).toHaveCount(1);
  // rename
  await app.click('.folder-row .conv-more');
  await app.click('#fm-rename');
  await app.fill('#fm-rename-input', 'Fish tank');
  await app.click('#fm-rename-save');
  await expect(app.locator('.folder-row')).toContainText('Fish tank');
  // a new chat started inside the folder lands in it once it has a message
  await app.click('.folder-row .conv-more');
  await app.click('#fm-new-chat');
  await send(app, 'second chat');
  await open(app);
  await expect(app.locator('.folder-row .folder-count')).toHaveText('2');
  // deleting the folder keeps the chats
  await app.click('.folder-row .conv-more');
  app.once('dialog', (d) => d.accept());
  await app.click('#fm-delete');
  await expect(app.locator('.folder-row')).toHaveCount(0);
  await expect(app.locator('.conv-item')).toHaveCount(2);
});

test('a chat can be created straight into a new folder and taken out again', async ({ app }) => {
  await send(app, 'hello');
  await open(app);
  await app.click('.conv-item.active .conv-more');
  await app.click('#cm-folder');
  await app.fill('#cm-folder-new', 'Ideas');
  await app.click('#cm-folder-add');
  await expect(app.locator('.folder-row')).toContainText('Ideas');
  await app.click('.conv-item.active .conv-more');
  await app.click('#cm-folder');
  await app.click('#cm-folder-list .menu-item:has-text("Remove from its folder")');
  await expect(app.locator('.folder-row .folder-count')).toHaveText('0');
  await expect(app.locator('.conv-item.in-folder')).toHaveCount(0);
});
