import { fileURLToPath } from 'node:url';
import { test, expect, send, MOCK } from './helpers.js';

test.use({ appSettings: { prefs: { learn: true, useMemory: true, episodes: true } } });

const all = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);
// the system prompt and the per-turn context after the history (memories are there since decision 199)
const sysOf = (r) => r.messages.filter((m) => m.role === 'system' && typeof m.content === 'string').map((m) => m.content).join('\n\n');
// the last thing the user said (memories and other per-turn context follow it as a system message)
const lastUser = (r) => r.messages.filter((m) => m.role === 'user').at(-1)?.content;
const closeSheets = (app) => app.evaluate(() => document.querySelectorAll('.sheet.open').forEach((x) => x.querySelector('[data-close]')?.click()));

test('in a group, every speaker learns about you (not just the first)', async ({ app, request }) => {
  await app.click('#persona-name-btn');
  await app.click('#chat-make-group');
  await app.click('#ge-members .persona-item:has-text("Coder")');
  await app.selectOption('#ge-mode', 'all');
  await app.click('#ge-save');
  await app.fill('#input', 'My name is Rich and I like apples a lot');
  await app.click('#send-btn');
  await app.waitForFunction(() => document.querySelectorAll('.msg.assistant').length === 2 && !document.body.classList.contains('streaming'));
  await expect.poll(async () => (await all(request)).filter((r) => sysOf(r).includes('Keep your own long-term memory')).length).toBe(2);
  // each speaker writes its own memories, in first person, about the user by name
  const prompts = (await all(request)).map(sysOf).filter((t) => t.includes('Keep your own long-term memory'));
  expect(prompts.some((t) => t.startsWith('You are Assistant.'))).toBe(true);
  expect(prompts.some((t) => t.startsWith('You are Coder.'))).toBe(true);
  expect(prompts[0]).toContain('long-term memory of Rich');
  expect(prompts[0]).toContain('Write EVERY memory in first person');
  expect(prompts[0]).toContain('YOUR CHARACTER (write in this voice):');
  const coder = prompts.find((t) => t.startsWith('You are Coder.'));
  expect(coder.split('YOUR CHARACTER (write in this voice):')[1].trim().length).toBeGreaterThan(40); // her character text, not a placeholder
  expect(coder).not.toContain('(a helpful assistant)');
});

test('a persona remembers what happened in an earlier chat', async ({ app, request }) => {
  await send(app, 'Let us talk about apples for a while');
  await send(app, 'Which apples are the sweetest ones?');
  await app.click('#menu-btn');
  await app.click('#drawer-new'); // leaving the chat writes the persona\'s notes
  await expect.poll(async () => (await all(request)).filter((r) => sysOf(r).includes('personal memory of past chats')).length).toBe(1);
  // the notes show up in the memory list ...
  await app.click('#menu-btn');
  await app.click('#open-memory');
  await expect(app.locator('.mem-item', { hasText: 'I talked with Rich about apples.' })).toContainText('notes from');
  await closeSheets(app);
  // ... and in the next chat with the same persona
  await send(app, 'Hello again');
  const req = (await all(request)).filter((r) => sysOf(r).includes('Your memories of earlier chats')).at(-1);
  expect(sysOf(req)).toContain('I talked with Rich about apples.');
});

test('two speakers in a row: both replies are fully shown (none stuck on the dots)', async ({ app }) => {
  await app.click('#persona-name-btn');
  await app.click('#chat-make-group');
  await app.click('#ge-members .persona-item:has-text("Coder")');
  await app.selectOption('#ge-mode', 'all');
  await app.click('#ge-save');
  await app.fill('#input', 'Say hello to me, both of you');
  await app.click('#send-btn');
  await app.waitForFunction(() => document.querySelectorAll('.msg.assistant').length >= 2 && !document.body.classList.contains('streaming'));
  await app.waitForTimeout(500);
  const replies = app.locator('.msg.assistant');
  await expect(replies).toHaveCount(2);
  await expect(replies.nth(0)).toContainText('Assistant speaking.');
  await expect(replies.nth(1)).toContainText('Coder speaking.');
  await expect(app.locator('.msg.streaming-msg')).toHaveCount(0);
  await expect(app.locator('.dots')).toHaveCount(0);
});

test('roleplay memory is per chat: a new roleplay with the same character starts fresh', async ({ app, request }) => {
  const seraphina = fileURLToPath(new URL('./fixtures/seraphina.png', import.meta.url)); // pathname gives /C:/… on Windows
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.setInputFiles('#card-file', seraphina);
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  await closeSheets(app);
  await app.click('.persona-pick:has-text("Seraphina")');
  await app.click('#cv-chat');
  await send(app, 'My name is Rich, nice to meet you');

  // learned, and stored for THIS roleplay
  await app.click('#menu-btn');
  await app.click('#open-memory');
  const item = app.locator('.mem-item', { hasText: 'I learned his name is Rich.' });
  await expect(item).toBeVisible();
  await expect(item).toContainText('only in');
  await closeSheets(app);

  // used again in the same roleplay
  await send(app, 'Tell me more about the glade');
  expect(sysOf((await all(request)).filter((r) => lastUser(r) === 'Tell me more about the glade').at(-1))).toContain('I learned his name is Rich.');

  // a NEW roleplay with the same character: fresh – nothing carried over
  await app.click('#menu-btn');
  await app.click('#drawer-new');
  await app.click('.persona-pick:has-text("Seraphina")');
  await app.click('#cv-chat');
  await send(app, 'Hello there, stranger');
  const fresh = (await all(request)).filter((r) => lastUser(r) === 'Hello there, stranger').at(-1);
  expect(sysOf(fresh)).not.toContain('I learned his name is Rich.');
  expect(sysOf(fresh)).not.toContain('I talked with Rich about apples.'); // the old roleplay's notes stay in the old roleplay

  // deleting the first roleplay deletes its memories
  await app.click('#menu-btn');
  app.once('dialog', (d) => d.accept());
  await app.click('.conv-item >> nth=1 >> .conv-more');
  await app.click('#cm-delete');
  await expect(app.locator('.conv-item')).toHaveCount(1); // the first roleplay is gone
  await app.click('#open-memory'); // the menu is still open
  await expect(app.locator('.mem-item', { hasText: 'I learned his name is Rich.' })).toHaveCount(0);
});

test('✂ Shorten rewrites long memories as short ones', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-memory');
  const long = 'Rich said that he really likes drinking a lot of hot tea in the evenings after work while reading long books about history and science, and that he prefers loose leaf over bags. '.slice(0, 190);
  await app.fill('#mem-new', long);
  await app.click('#mem-add');
  await expect(app.locator('.mem-item .mem-text').first()).toHaveText(long);
  await app.click('#mem-shorten');
  await expect(app.locator('.mem-item .mem-text').first()).toHaveText('Rich likes tea.');
  await expect(app.locator('#mem-shorten-status')).toContainText('Shortened 1');
});

// What the persona remembers (read from the memory list)
async function memories(app) {
  await app.click('#menu-btn');
  await app.click('#open-memory');
  const texts = await app.locator('.mem-item .mem-text').allTextContents();
  await closeSheets(app);
  return texts;
}

test('retrying or editing a turn undoes the memory it saved (and swiping brings it back)', async ({ app }) => {
  await send(app, 'My name is Rich, nice to meet you');
  await expect.poll(() => memories(app)).toEqual(['I learned his name is Rich.']);

  // Retry: the old reply's memory is undone and the new reply learns again – no duplicate
  await app.click('.msg.assistant:last-child .act:has-text("Retry")');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'));
  await expect.poll(() => memories(app)).toEqual(['I learned his name is Rich.']);

  // Edit my message: the replies it cut off no longer teach anything; the new text teaches its own
  await app.click('.msg.user .act:has-text("Edit")');
  await app.fill('#input', 'My name is Bob, nice to meet you');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'));
  await expect.poll(() => memories(app)).toEqual(['I learned his name is Bob.']);

  // Back to the first version of my message: its memory returns, the edited one's goes
  await app.click('.msg.user .pager-btn >> nth=0');
  await expect.poll(() => memories(app)).toEqual(['I learned his name is Rich.']);
});

test('the Undo button on the "remembered" note forgets what that reply taught', async ({ app }) => {
  await send(app, 'My name is Ann, nice to meet you');
  await expect.poll(() => memories(app)).toEqual(['I learned his name is Ann.']);
  await app.locator('.msg.assistant:last-child .mem-note summary').click();
  await app.click('.msg.assistant:last-child .mem-note button:has-text("Undo")');
  await expect.poll(() => memories(app)).toEqual([]);
  await expect(app.locator('.mem-note')).toHaveCount(0);
});

test.describe('smart memory', () => {
  const facts = ['Owns a corgi named Biscuit', 'Works nights as a nurse', 'Prefers short answers', 'Is learning Japanese', 'Lives in Cebu', 'Allergic to peanuts', 'Plays guitar on weekends', 'Drives a red motorbike', 'Likes strong coffee', 'Hates cilantro', 'Collects old maps', 'Runs every morning', 'Vegetarian', 'Owns a telescope'].map((text, i) => ({ id: 'm' + i, text, scope: 'global', source: 'manual', createdAt: 1000 + i, updatedAt: 1000 + i }));
  test.use({ appSettings: { memories: facts, prefs: { smartMemory: true, memLimit: 4, learn: false } } });
  test('facts are chosen by meaning, not just shared words', async ({ app, request }) => {
    await app.addInitScript(() => {
      globalThis.__ocmEmbedder = async (texts) => texts.map((t) => (/corgi|dog|puppy|pet/i.test(t) ? [1, 0] : [0, 1]));
    });
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    // the ranking by meaning is prepared in the background, so it applies from the next message on
    await send(app, 'my puppy has been limping all day');
    await app.waitForTimeout(300);
    await send(app, 'should I worry?');
    const req = (await all(request)).filter((r) => sysOf(r).includes('About the user')).at(-1);
    expect(sysOf(req)).toContain('Biscuit');
    expect(sysOf(req)).not.toContain('peanuts'); // old and unrelated → left out
  });
});

test('🧹 Tidy up proposes merges and removals, applies the ticked ones, and can be undone', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-memory');
  for (const t of ['Likes tea', 'Drinks tea in the evening', 'Junk fact about nothing', 'Name is Rich']) {
    await app.fill('#mem-new', t);
    await app.click('#mem-add');
  }
  await app.selectOption('#mem-filter', 'global');
  await app.click('#mem-tidy');
  await expect(app.locator('.tidy-item')).toHaveCount(2);
  await expect(app.locator('.tidy-new')).toHaveText('Likes tea in the evening.');
  await app.locator('.tidy-item', { hasText: 'Remove' }).locator('input').uncheck(); // keep the "junk" one
  await app.click('#tidy-apply');
  await expect(app.locator('.mem-item .mem-text')).toHaveCount(3);
  await expect(app.locator('.mem-item .mem-text', { hasText: 'Likes tea in the evening.' })).toBeVisible();
  await expect(app.locator('.mem-item .mem-text', { hasText: 'Junk fact' })).toBeVisible();
  await app.click('#mem-tidy-undo');
  await expect(app.locator('.mem-item .mem-text')).toHaveCount(4);
  await expect(app.locator('.mem-item .mem-text', { hasText: 'Drinks tea in the evening' })).toBeVisible();
});

test.describe('memories in the chat sheet', () => {
  const facts = ['Name is Rich', 'Owns a corgi named Biscuit', 'Works nights as a nurse', 'Is learning Japanese', 'Lives in Cebu', 'Allergic to peanuts'].map((text, i) => ({ id: 'm' + i, text, scope: 'global', source: 'manual', createdAt: 1000 + i, updatedAt: 1000 + i }));
  test.use({ appSettings: { memories: facts, prefs: { memLimit: 3, learn: false } } });
  test('shows what is remembered, what is sent, and lets you pin or delete', async ({ app }) => {
    await app.click('#persona-name-btn');
    await app.click('#chat-mem-box summary');
    await expect(app.locator('#chat-mem-list .cm-item')).toHaveCount(6);
    await expect(app.locator('#chat-mem-info')).toContainText('3 of 6');
    await expect(app.locator('#chat-mem-list .cm-item.off')).toHaveCount(3);
    await app.locator('.cm-item', { hasText: 'Allergic to peanuts' }).locator('button[aria-label="Delete memory"]').click();
    await expect(app.locator('#chat-mem-list .cm-item')).toHaveCount(5);
    // edit one in place
    await app.locator('.cm-item', { hasText: 'Lives in Cebu' }).locator('button[aria-label="Edit memory"]').click();
    await app.locator('.cm-edit textarea').fill('Lives in Manila');
    await app.click('.cm-edit button:has-text("Save")');
    await expect(app.locator('.cm-item', { hasText: 'Lives in Manila' })).toHaveCount(1);
    await expect(app.locator('.cm-item', { hasText: 'Cebu' })).toHaveCount(0);
    // and add one
    await app.fill('.cm-add input', 'Likes hiking');
    await app.selectOption('.cm-add select', 'global');
    await app.click('.cm-add button:has-text("Add")');
    await expect(app.locator('.cm-item', { hasText: 'Likes hiking' })).toHaveCount(1);
  });
});

test('the picture preview shows the whole description', async ({ app }) => {
  const long = 'A very long introduction. '.repeat(40) + 'THE END OF THE BLURB';
  const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Longwind', description: 'short', first_mes: 'hi', creator_notes: long } };
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.setInputFiles('#card-file', { name: 'longwind.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(card)) });
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Longwind' })).toBeVisible();
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await app.click('.persona-pick:has-text("Longwind")');
  await app.click('#cv-chat');
  await app.click('#persona-btn');
  await expect(app.locator('.art-desc')).toContainText('THE END OF THE BLURB');
});
