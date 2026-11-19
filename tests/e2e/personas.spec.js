import { test, expect, send, MOCK, lastRequest } from './helpers.js';
import { fileURLToPath } from 'node:url';

const fx = (f) => fileURLToPath(new URL('./fixtures/' + f, import.meta.url));
const requests = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);
const sys = (r) => (typeof r.messages[0].content === 'string' ? r.messages[0].content : '');
const closeSheets = (app) => app.evaluate(() => document.querySelectorAll('.sheet.open').forEach((x) => x.querySelector('[data-close]')?.click()));

async function importCards(app, files) {
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.setInputFiles('#card-file', files.map(fx));
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Captain Rook' })).toBeVisible();
  await closeSheets(app);
}

test('@mention calls another persona into a single chat for one reply', async ({ app, request }) => {
  await app.fill('#input', 'hey @Cod');
  await expect(app.locator('.mention-item', { hasText: '@Coder' })).toBeVisible();
  await app.click('.mention-item:has-text("@Coder")');
  await expect(app.locator('#input')).toHaveValue('hey @Coder ');
  await app.fill('#input', '@Coder can you check this?');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming') && document.querySelectorAll('.msg.assistant').length === 1);
  const guestMsg = app.locator('.msg.assistant').last();
  await expect(guestMsg).toContainText('Guest Coder here.');
  await expect(guestMsg.locator('.msg-model b')).toHaveText('Coder');
  await expect(app.locator('#persona-name')).toHaveText('Assistant'); // the chat itself didn't change

  await send(app, 'thanks, and you?');
  await expect(app.locator('.msg.assistant').last().locator('.msg-model b')).toHaveText('Assistant');
  const host = (await requests(request)).at(-1);
  expect(sys(host)).not.toContain('You were called in');
  expect(host.messages.some((m) => m.role === 'user' && String(m.content).includes('[Coder]: Guest Coder here.'))).toBe(true);
});

test('roleplay group: main character sets the scene, the conversation decides who replies', async ({ app, request }) => {
  await importCards(app, ['seraphina.png', 'rook.json']);
  await app.click('.persona-pick:has-text("Seraphina")');
  await app.click('#cv-chat');
  await app.click('#persona-name-btn');
  await app.click('#chat-make-group');
  await app.click('#ge-members .persona-item:has-text("Captain Rook")');
  await expect(app.locator('#ge-main-row')).toBeVisible();
  await expect(app.locator('#ge-main')).toHaveValue(/.+/);
  expect(await app.locator('#ge-main option:checked').textContent()).toBe('Seraphina');
  await expect(app.locator('#ge-mode')).toHaveValue('auto');
  await app.click('#ge-save');
  await expect(app.locator('.mention-chip.lead')).toContainText('@Seraphina');

  // not addressed to anyone → the main character answers alone
  await send(app, 'I look around the glade.');
  await expect(app.locator('.msg.assistant').last()).toContainText('Seraphina speaking.');
  let reqs = await requests(request);
  expect(sys(reqs.find((r) => sys(r).startsWith('You moderate'))).includes('Seraphina (MAIN CHARACTER)')).toBe(true);
  expect(reqs.filter((r) => /in a group chat/.test(sys(r)))).toHaveLength(1);

  // addressed to the supporting character → only he answers, with the main character's scene
  await request.post(MOCK + '/__reset');
  await send(app, 'What do you think, Rook?');
  await expect(app.locator('.msg.assistant').last()).toContainText('Captain Rook speaking.');
  reqs = await requests(request);
  const rook = reqs.find((r) => /You are Captain Rook in a group chat/.test(sys(r)));
  expect(sys(rook)).toContain('[The main character of this story: Seraphina]');
  expect(sys(rook)).toContain('Seraphina is the main character of this story; you are a supporting character');
  expect(reqs.filter((r) => /in a group chat/.test(sys(r)))).toHaveLength(1);
});

test('character art is kept at full resolution', async ({ app }) => {
  await importCards(app, ['seraphina.png', 'rook.json']);
  await app.click('.persona-pick:has-text("Seraphina")');
  await app.click('#cv-chat');
  await app.click('.msg.assistant .msg-avatar');
  const img = app.locator('.art-view img');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((i) => [i.naturalWidth, i.naturalHeight])).toEqual([400, 600]);
  expect(await img.evaluate((i) => i.src.slice(0, 22))).toBe('data:image/png;base64,');
  await img.click();
  await expect(app.locator('.art-view.zoomed')).toBeVisible();
  await app.click('.art-close');
  await expect(app.locator('.art-view')).toHaveCount(0);
});

test('This chat shows the current character compactly; Change opens a filtered, searchable list', async ({ app }) => {
  await importCards(app, ['seraphina.png', 'rook.json']);
  await app.click('.persona-pick:has-text("Seraphina")');
  await app.click('#cv-chat');
  await app.click('#persona-name-btn');
  await expect(app.locator('#chat-persona-current .persona-title')).toHaveText('Seraphina');
  await expect(app.locator('#chat-persona-picker')).toBeHidden();
  await expect(app.locator('#chat-ctx')).toBeInViewport(); // chat settings are right there, no scrolling past a list
  await app.click('#chat-persona-current button:has-text("Change")');
  const names = () => app.locator('#chat-persona-list .persona-title').allTextContents();
  expect(await names()).not.toContain('Assistant'); // roleplay chat → only roleplay characters
  expect(await names()).toContain('Captain Rook');
  await app.fill('#chat-persona-search', 'rook');
  expect(await names()).toEqual(['Captain Rook']);
  await app.fill('#chat-persona-search', '');
  await app.check('#chat-persona-all');
  expect(await names()).toContain('Assistant');
  await app.click('#chat-persona-list .persona-item:has-text("Captain Rook")');
  await expect(app.locator('#chat-persona-current .persona-title')).toHaveText('Captain Rook');
  await expect(app.locator('#chat-persona-picker')).toBeHidden();
  await app.screenshot({ path: 'test-results/this-chat.png' });
});

test('roleplay starts on the character grid; Personas has New/Import on top and tabs', async ({ app }) => {
  await importCards(app, ['seraphina.png', 'rook.json']);
  // new roleplay: the grid of characters, no greeting until you pick one
  await expect(app.locator('.empty-label')).toHaveText(/Roleplay with/i);
  await expect(app.locator('.msg.assistant')).toHaveCount(0);
  await app.click('.persona-pick:has-text("Captain Rook")');
  await app.click('#cv-chat');
  await expect(app.locator('#persona-name')).toHaveText('Captain Rook');

  await app.click('#menu-btn');
  await app.click('#open-personas');
  await expect(app.locator('#persona-new')).toBeInViewport();
  await expect(app.locator('#persona-tabs .active')).toContainText('Roleplay');
  expect(await app.locator('#persona-list .persona-title').allTextContents()).not.toContain('Coder');
  await app.click('#persona-tabs [data-ptab="chat"]');
  expect(await app.locator('#persona-list .persona-title').allTextContents()).toContain('Coder');
  await app.fill('#persona-search', 'cod');
  expect(await app.locator('#persona-list .persona-title').allTextContents()).toEqual(['Coder']);
});

test('a roleplay character becomes a chat persona (with what happened in the chat)', async ({ app, request }) => {
  await importCards(app, ['seraphina.png', 'rook.json']);
  await app.click('.persona-pick:has-text("Seraphina")');
  await app.click('#cv-chat');
  await send(app, 'Thank you for saving me, Seraphina.');
  await app.click('#chat-more-btn');
  await app.click('#cm-more');
  await app.click('#cm-to-persona');
  await expect(app.locator('#pe-gen-model')).toBeVisible();
  await expect(app.locator('#persona-editor')).toHaveClass(/open/);
  await expect(app.locator('#pe-name')).toHaveValue('Seraphina');
  await expect(app.locator('#pe-rp')).not.toBeChecked();
  await expect(app.locator('#pe-prompt')).toHaveValue(/^You \*are\* Seraphina/);
  const req = (await requests(request)).find((r) => sys(r).startsWith('You turn a roleplay character'));
  expect(req.max_tokens).toBe(8000); // long output: not capped by an endpoint's reply limit
  expect(sys(req)).toContain('Write ALL of the sections below');
  expect(req.messages[1].content).toContain('DESCRIPTION:');
  expect(req.messages[1].content).toContain('Alex: Thank you for saving me, Seraphina.');
  await app.click('#pe-save');
  await closeSheets(app);
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.click('#persona-tabs [data-ptab="chat"]');
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  await app.click('#persona-tabs [data-ptab="rp"]');
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible(); // the character is still there
});

test('the persona writer model can be chosen', async ({ app, request }) => {
  await importCards(app, ['seraphina.png', 'rook.json']);
  await app.click('.persona-pick:has-text("Seraphina")');
  await app.click('#cv-chat');
  await app.click('#chat-more-btn');
  await app.click('#cm-more');
  await app.click('#cm-to-persona');
  await app.selectOption('#pe-gen-model', 'kimi-k3');
  await app.click('#pe-generate');
  await expect(app.locator('#pe-gen-status')).not.toHaveText(/Writing/);
  const reqs = await requests(request);
  expect(reqs.at(-1).model).toBe('kimi-k3');
});

test('the group editor lists only this side of the app', async ({ app }) => {
  await importCards(app, ['seraphina.png', 'rook.json']);
  // switch to the Chats side (importing cards had moved us to Roleplay)
  await app.click('#menu-btn');
  await app.click('.mode-tab[data-mode="chat"]');
  await app.evaluate(() => document.getElementById('scrim').click());
  await app.waitForTimeout(300);
  await app.click('#persona-name-btn');
  await app.click('#chat-make-group');
  const names = () => app.locator('#ge-members .persona-title').allTextContents();
  expect(await names()).toContain('Coder');
  expect(await names()).not.toContain('Captain Rook');
  await app.check('#ge-all');
  expect(await names()).toContain('Captain Rook');
  await app.uncheck('#ge-all');
  await app.fill('#ge-search', 'tut');
  expect((await names()).sort()).toEqual(['Assistant', 'Tutor']); // Assistant is the chat's persona, already selected
});

test('a scenario card + a persona in a roleplay group: opens with the scenario\'s first message', async ({ app, request }) => {
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.setInputFiles('#card-file', fx('scenario.json'));
  await expect(app.locator('#persona-list .persona-title', { hasText: 'The Glass Citadel' })).toBeVisible();
  // mark it as a scenario card
  await app.click('#persona-list .persona-item:has-text("The Glass Citadel")');
  await app.check('#pe-scenario-card');
  await app.click('#pe-save');
  await closeSheets(app);

  // roleplay: new group = the scenario + an assistant persona (Coder)
  await app.click('.persona-pick:has-text("The Glass Citadel")');
  await app.click('#cv-chat');
  await app.click('#persona-name-btn');
  await app.click('#chat-make-group');
  await app.check('#ge-all');
  await app.click('#ge-members .persona-item:has-text("Coder")');
  await expect(app.locator('#ge-scene')).toHaveValue(/.+/);
  expect(await app.locator('#ge-scene option:checked').textContent()).toBe('The Glass Citadel');
  expect(await app.locator('#ge-main').inputValue()).toBe(''); // no main character
  await app.click('#ge-save');

  // not empty: the scenario's opening message is there, from the scenario card
  const opening = app.locator('.msg.assistant').first();
  await expect(opening).toContainText('The gates of the Glass Citadel hum');
  await expect(opening.locator('.msg-model b')).toHaveText('The Glass Citadel');
  await expect(app.locator('.mention-chip.scene')).toContainText('@The');

  // the narrator answers, plays the lorebook's characters, and the player gets the scenario
  await send(app, 'I ask the herald who summoned me.');
  await expect(app.locator('.msg.assistant').last()).toContainText('The Glass Citadel speaking.');
  let reqs = await requests(request);
  const mod = reqs.find((r) => sys(r).startsWith('You moderate'));
  expect(sys(mod)).toContain('The Glass Citadel (SCENARIO / NARRATOR)');
  const narrator = reqs.find((r) => /You are The Glass Citadel in a group chat/.test(sys(r)));
  expect(sys(narrator)).toContain('narrator and game master');
  expect(sys(narrator)).toContain('Master Orrin, the herald'); // lorebook entry triggered by "herald"
  expect(sys(narrator)).toContain('You are the narrator of this story');

  await request.post(MOCK + '/__reset');
  await send(app, 'Coder, what do you make of this?');
  await expect(app.locator('.msg.assistant').last()).toContainText('Coder speaking.');
  reqs = await requests(request);
  const player = reqs.find((r) => /You are Coder in a group chat/.test(sys(r)));
  expect(sys(player)).toContain('[The scenario of this story: The Glass Citadel]');
  expect(sys(player)).toContain('The Glass Citadel is the narrator of this story');
  expect(sys(player)).not.toContain('narrator and game master'); // the player doesn't get the narrator's own prompt
});

test('the persona editor never scrolls sideways (button rows wrap)', async ({ app }) => {
  await importCards(app, ['seraphina.png', 'rook.json']);
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.click('#persona-tabs [data-ptab="rp"]');
  await app.click('#persona-list .persona-item:has-text("Seraphina")');
  const card = app.locator('#persona-editor .sheet-card');
  await expect(app.locator('#pe-to-chat')).toBeVisible(); // the row with all six buttons
  const m = await card.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(m.scroll).toBeLessThanOrEqual(m.client + 1);
  // every button is fully inside the sheet
  const right = await app.locator('#persona-editor .row.gap button:visible').evaluateAll((bs) => Math.max(...bs.map((b) => b.getBoundingClientRect().right)));
  expect(right).toBeLessThanOrEqual(await card.evaluate((el) => el.getBoundingClientRect().right));
});

test('the context size can be any custom value', async ({ app }) => {
  await app.click('#persona-name-btn');
  await app.evaluate(() => (globalThis.prompt = () => '55k'));
  await app.selectOption('#chat-ctx', 'custom');
  await expect(app.locator('#chat-ctx')).toHaveValue('55000');
  await expect(app.locator('#chat-ctx option:checked')).toHaveText(/Custom/);
  await app.evaluate(() => (globalThis.prompt = () => 'abc'));
  await app.selectOption('#chat-ctx', 'custom');
  await expect(app.locator('#chat-ctx')).toHaveValue('55000');
});

test('the lorebook that came with a character shows as on in the chat’s world info', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.setInputFiles('#card-file', fx('scenario.json'));
  await expect(app.locator('#persona-list .persona-title', { hasText: 'The Glass Citadel' })).toBeVisible();
  await closeSheets(app);
  await app.click('.persona-pick:has-text("The Glass Citadel")');
  await app.click('#cv-chat');
  await app.click('#persona-name-btn');
  const own = app.locator('#chat-lore label', { hasText: 'comes with the character' });
  await expect(own).toHaveCount(1);
  await expect(own.locator('input')).toBeChecked();
  await expect(own.locator('input')).toBeDisabled();
});

test('character definitions can be overridden for one chat, field by field', async ({ app, request }) => {
  await importCards(app, ['seraphina.png', 'rook.json']);
  await app.click('.persona-pick:has-text("Seraphina")');
  await app.click('#cv-chat');
  await app.click('#persona-name-btn');
  await expect(app.locator('#chat-card-box')).toBeVisible();
  await expect(app.locator('#cc-description')).toHaveValue(/.+/);
  const original = await app.locator('#cc-description').inputValue();
  // customize the description and the greeting for this chat
  await app.click('#chat-card-box summary');
  await app.fill('#cc-description', 'Seraphina is now a stern lighthouse keeper.');
  await app.fill('#cc-first_mes', 'The lamp turns slowly. "State your business."');
  await app.click('#cc-save');
  await expect(app.locator('#cc-note')).toContainText('description');
  await app.click('#chat-sheet [data-close]');
  await expect(app.locator('.msg.assistant').first()).toContainText('State your business');
  await send(app, 'hello keeper');
  const req = await lastRequest(request);
  const sys = typeof req.messages[0].content === 'string' ? req.messages[0].content : '';
  expect(sys).toContain('stern lighthouse keeper');
  expect(sys).not.toContain(original.slice(0, 40));
  // the character itself is unchanged, and reset brings the chat back to it
  await app.click('#persona-name-btn');
  await app.click('#cc-reset');
  await expect(app.locator('#cc-description')).toHaveValue(original);
});

test('a persona keeps earlier versions of its prompt: compare and restore', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.click('#persona-list .persona-item:has-text("Coder")');
  const original = await app.locator('#pe-prompt').inputValue();
  await expect(app.locator('#pe-history')).toBeHidden(); // nothing yet
  await app.fill('#pe-prompt', original + '\n- Always answer in haiku.');
  await app.click('#pe-save');
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.click('#persona-list .persona-item:has-text("Coder")');
  await expect(app.locator('#pe-history')).toBeVisible();
  await app.click('#pe-history');
  await expect(app.locator('#history-list .hist-item')).toHaveCount(1);
  await expect(app.locator('#history-list .hist-head')).toContainText('+1 −0');
  await app.click('#history-list button:has-text("Compare with now")');
  await expect(app.locator('#history-list .diff .d-add')).toContainText('Always answer in haiku');
  await app.click('#history-list button:has-text("Restore into the editor")');
  await expect(app.locator('#pe-prompt')).toHaveValue(original);
});

test.describe('a lorebook on your own persona', () => {
  const entry = { id: 'le_u', name: 'Alex', keys: [], secondaryKeys: [], selective: false, logic: 'and_any', content: 'USER-LORE-MARKER: Alex is a lighthouse keeper.', enabled: true, constant: true, order: 100, position: 'before', depth: 4, role: 'system', probability: 100, wholeWords: true, caseSensitive: false };
  test.use({ appSettings: { lorebooks: [{ id: 'lb_u', name: 'About me', entries: [entry], scanDepth: 4, budgetTokens: 2048, recursive: true }], userPersonas: [{ id: 'up_x', name: 'Alex', description: '', lorebookId: 'lb_u' }], defaultUserPersonaId: 'up_x' } });
  test('its world info is always on in your chats', async ({ app, request }) => {
    await send(app, 'hello');
    const sys = (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages).at(-1).messages[0].content;
    expect(sys).toContain('USER-LORE-MARKER');
    await app.click('#persona-name-btn');
    await expect(app.locator('#chat-lore label', { hasText: 'comes with your persona' })).toHaveCount(1);
  });
});
