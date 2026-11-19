import { test, expect, send, lastRequest } from './helpers.js';
import { fileURLToPath } from 'node:url';

const card = fileURLToPath(new URL('./fixtures/seraphina.png', import.meta.url));

test('imports a character card and roleplays with it', async ({ app, request }) => {
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.setInputFiles('#card-file', card);
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await app.click('.persona-pick:has-text("Seraphina")');
  await app.click('#cv-chat');
  const greeting = app.locator('.msg.assistant').first();
  await expect(greeting).toContainText('Seraphina');
  await expect(greeting.locator('.pager-num')).toHaveText('1/2'); // alternate greeting

  await send(app, 'Where am I?');
  const req = await lastRequest(request);
  const sys = req.messages[0].content;
  expect(req.messages[0].role).toBe('system');
  expect(sys).toContain("Write Seraphina's next reply");
  expect(req.messages.at(-1).content).toBe('Where am I?');
  // the greeting is part of the history, with {{user}} filled in
  expect(req.messages.some((m) => m.role === 'assistant' && /Alex/.test(m.content))).toBe(true);
});

test('roleplay preset: names, prompt note and samplers', async ({ app, request }) => {
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.setInputFiles('#card-file', card);
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="rppreset"]');
  await app.click('#rp-samplers summary');
  await app.fill('#rps-top_k', '49');
  await app.fill('#pref-rp-note', 'NOTE for {{char}}');
  await app.check('#pref-rp-names');
  await app.waitForTimeout(600);
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await app.click('.persona-pick:has-text("Seraphina")');
  await app.click('#cv-chat');
  await send(app, 'hi');
  const req = await lastRequest(request);
  expect(req.top_k).toBe(49);
  expect(req.messages.some((m) => m.content === 'NOTE for Seraphina')).toBe(true);
  expect(req.messages.at(-1).content).toBe('Alex: hi');
});

test('story memory records events, not the character card', async ({ app, request }) => {
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.setInputFiles('#card-file', card);
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await app.click('.persona-pick:has-text("Seraphina")');
  await app.click('#cv-chat');
  await send(app, 'Where am I?');
  await app.click('#persona-name-btn');
  await app.click('#story-box summary');
  await app.click('#story-update');
  await expect(app.locator('#story-text')).toHaveValue(/Key events/);
  const reqs = (await (await request.get(`${globalThis.__MOCK}/__requests`)).json()).filter((r) => r.messages);
  const story = reqs.find((r) => String(r.messages[0].content).startsWith('You keep the "story memory"'));
  const body = story.messages[1].content;
  expect(story.messages[0].content).toContain('never repeat or summarise them');
  expect(body).toContain('ALREADY KNOWN');
  expect(body).toContain('- Seraphina:');
  const newMessages = body.split('NEW MESSAGES:')[1];
  expect(newMessages).toContain('Where am I?');
  expect(newMessages).not.toContain('kneels beside you'); // the card's greeting isn't an event
});

test.describe('long roleplays slide instead of being summarised', () => {
  test.use({ appSettings: { model: 'tiny-1', prefs: { autoCompact: true } } }); // a 3,000-token model

  test('no auto-compact in a roleplay: the oldest messages slide out', async ({ app, request }) => {
    await app.click('#menu-btn');
    await app.click('#open-personas');
    await app.setInputFiles('#card-file', card);
    await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
    await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
    await app.click('.persona-pick:has-text("Seraphina")');
    await app.click('#cv-chat');
    const filler = 'a'.repeat(1900);
    await send(app, 'FIRSTMARK ' + filler);
    for (const n of ['two', 'three', 'four', 'five']) await send(app, `${n} ${filler}`);

    // never summarised …
    await expect(app.locator('.compact-note, .summary-divider')).toHaveCount(0);
    const stored = await app.evaluate(
      () =>
        new Promise((resolve) => {
          const q = indexedDB.open('chronicle');
          q.onsuccess = () => {
            const g = q.result.transaction('conversations').objectStore('conversations').getAll();
            g.onsuccess = () => resolve(g.result.map((c) => !!c.summary));
          };
        }),
    );
    expect(stored.every((s) => !s)).toBe(true);
    // … the window slid instead: the first message is no longer sent, the latest is
    const reqs = (await (await request.get(`${globalThis.__MOCK}/__requests`)).json()).filter((r) => r.messages);
    // the chat request for the latest message (not the background story-memory request, which reads the old messages)
    const chatReq = reqs.filter((r) => String(r.messages.at(-1).content).startsWith('five ')).at(-1);
    const last = chatReq.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    expect(last).not.toContain('FIRSTMARK');
    expect(last).toContain('five ' + filler.slice(0, 50));
    await expect(app.locator('.window-divider')).toContainText("kept just under the model's limit");
  });
});

test('import a character straight from a chub.ai link', async ({ app }) => {
  const fs = await import('node:fs');
  let asked = '';
  await app.route('https://avatars.charhub.io/**', (r) => {
    asked = r.request().url();
    r.fulfill({ status: 200, contentType: 'image/png', body: fs.readFileSync(card) });
  });
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.click('#persona-tabs [data-ptab="rp"]');
  await app.fill('#chub-url', 'https://chub.ai/characters/someone/seraphina-1234');
  await app.click('#chub-go');
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  expect(asked).toBe('https://avatars.charhub.io/avatars/someone/seraphina-1234/chara_card_v2.png');
});

test('chub import falls back to Chub\'s download API', async ({ app }) => {
  const fs = await import('node:fs');
  await app.route('https://avatars.charhub.io/**', (r) => r.fulfill({ status: 404, body: 'not here' }));
  let body = null;
  await app.route('https://api.chub.ai/**', (r) => {
    body = r.request().postDataJSON();
    r.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(card) });
  });
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.click('#persona-tabs [data-ptab="rp"]');
  await app.fill('#chub-url', 'https://chub.ai/characters/someone/seraphina-1234');
  await app.click('#chub-go');
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  expect(body).toEqual({ format: 'tavern', fullPath: 'someone/seraphina-1234', version: 'main' });
});

test('roleplay presets: a preset brings its own model, prompts and samplers; a chat can pick another', async ({ app, request }) => {
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.setInputFiles('#card-file', card);
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  // Standard keeps its own post-history line
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="rppreset"]');
  await app.fill('#pref-phi', 'STANDARD PHI');
  await app.waitForTimeout(600);
  // a new preset from a starter, with its own model, effort, PHI and temperature, made the default
  await app.selectOption('#rp-preset-new', 'starter:Short & snappy');
  // named in the app's own text sheet (no system prompt box)
  await expect(app.locator('#text-sheet')).toHaveClass(/open/);
  await expect(app.locator('#text-input')).toHaveValue('Short & snappy');
  await app.fill('#text-input', 'Fast & short');
  await app.click('#text-ok');
  await expect(app.locator('#rp-preset-sel')).toHaveValue(/^rpp_/);
  await app.selectOption('#rp-preset-model', 'deepseek-v4-pro');
  await app.selectOption('#rp-preset-effort', 'max');
  await app.fill('#pref-phi', 'PRESET PHI');
  await app.click('#rp-samplers summary');
  await app.fill('#rps-temperature', '0.33');
  await app.check('#rp-preset-default');
  await app.waitForTimeout(600);
  // Standard was not touched by editing the preset
  await app.selectOption('#rp-preset-sel', '');
  await expect(app.locator('#pref-phi')).toHaveValue('STANDARD PHI');
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));

  await app.click('.persona-pick:has-text("Seraphina")');
  await app.click('#cv-chat');
  await expect(app.locator('#model-name')).toContainText('Fast & short');
  await send(app, 'hi');
  let req = await lastRequest(request);
  expect(req.model).toBe('deepseek-v4-pro');
  expect(req.temperature).toBe(0.33);
  expect(req.reasoning_effort).toBe('max');
  expect(req.messages.some((m) => m.content === 'PRESET PHI')).toBe(true);
  expect(req.messages.some((m) => m.content === 'STANDARD PHI')).toBe(false);

  // this chat switches to Standard: the selected model and Standard's prompt again
  await app.click('#chat-more-btn');
  await app.click('#cm-more');
  await app.click('#cm-settings');
  await expect(app.locator('#chat-preset-row')).toBeVisible();
  await app.selectOption('#chat-preset', '');
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await expect(app.locator('#model-name')).not.toContainText('Fast & short');
  await send(app, 'again');
  req = await lastRequest(request);
  expect(req.model).toBe('glm-5.3');
  expect(req.messages.some((m) => m.content === 'STANDARD PHI')).toBe(true);
});
