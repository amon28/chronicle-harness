import { test, expect } from './helpers.js';
import { fileURLToPath } from 'node:url';

test.use({ appSettings: { prefs: { tools: true } } });

test('the assistant can make a roleplay character with a lorebook, after you approve', async ({ app }) => {
  await app.fill('#input', 'MAKECHAR please');
  await app.click('#send-btn');
  await expect(app.locator('#ask-sheet')).toHaveClass(/open/);
  await expect(app.locator('#ask-question')).toContainText('Mira');
  await app.click('#ask-options .menu-item:has-text("Add it")');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
  await expect(app.locator('.tool-card', { hasText: 'Made a character' })).toBeVisible();
  const saved = await app.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('chronicle');
      r.onsuccess = () => res(r.result);
    });
    const v = await new Promise((res) => {
      const q = db.transaction('kv').objectStore('kv').getAll();
      q.onsuccess = () => res(JSON.stringify(q.result));
    });
    return v;
  });
  expect(saved).toContain('Mira');
  expect(saved).toContain('The old library');
});

test('declining adds nothing', async ({ app }) => {
  await app.fill('#input', 'MAKECHAR please');
  await app.click('#send-btn');
  await app.click('#ask-skip');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
  const saved = await app.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('chronicle');
      r.onsuccess = () => res(r.result);
    });
    return new Promise((res) => {
      const q = db.transaction('kv').objectStore('kv').getAll();
      q.onsuccess = () => res(JSON.stringify(q.result));
    });
  });
  expect(saved).not.toContain('Mira');
});

test('asking to change the Persona Maker updates it instead of making a second one', async ({ app }) => {
  await app.fill('#input', 'UPDATEPM improve yourself');
  await app.click('#send-btn');
  await expect(app.locator('#ask-question')).toContainText('Update the persona');
  await app.click('#ask-options .menu-item:has-text("Add it")');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
  const found = await app.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('chronicle');
      r.onsuccess = () => res(r.result);
    });
    const all = await new Promise((res) => {
      const q = db.transaction('kv').objectStore('kv').getAll();
      q.onsuccess = () => res(q.result);
    });
    const ps = JSON.parse(JSON.stringify(all)).flatMap((x) => x.value?.personas || x.personas || []).filter((x) => x.name === 'Persona Maker');
    return ps.map((x) => x.prompt);
  });
  expect(found).toEqual(['You are the improved Persona Maker.']);
});

test.describe('with a picture', () => {
test.use({ appSettings: { model: 'kimi-k3', prefs: { tools: true } } }); // a model that can see pictures
test('a picture you sent becomes the character’s picture', async ({ app }) => {
  await app.setInputFiles('#file-input', fileURLToPath(new URL('./fixtures/seraphina.png', import.meta.url)));
  await expect(app.locator('#attachments .thumb img')).toHaveCount(1);
  await app.fill('#input', 'MAKECHAR WITHPIC use this look');
  await app.click('#send-btn');
  await expect(app.locator('#ask-question')).toContainText('the picture you sent');
  await app.click('#ask-options .menu-item:has-text("Add it")');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
  const p = await app.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('chronicle');
      r.onsuccess = () => res(r.result);
    });
    const all = await new Promise((res) => {
      const q = db.transaction('kv').objectStore('kv').getAll();
      q.onsuccess = () => res(q.result);
    });
    const s = JSON.stringify(all);
    const mira = JSON.parse(s).flatMap((x) => x.value?.personas || x.personas || []).find((x) => x.name === 'Mira');
    return { avatar: mira?.avatar?.image?.slice(0, 22), hasArt: mira?.hasArt };
  });
  expect(p.avatar).toMatch(/^data:image\//);
  expect(p.hasArt).toBe(true);
});
});

test('the assistant can add a snippet for you, after you approve; it works as a /command at once', async ({ app }) => {
  await app.fill('#input', 'MAKESNIP make me a standup command');
  await app.click('#send-btn');
  await expect(app.locator('#ask-question')).toContainText('Add the snippet /standup');
  await expect(app.locator('#ask-question')).toContainText('Write my standup from these notes');
  await app.click('#ask-options .menu-item:has-text("Add it")');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
  await app.fill('#input', '/stand');
  await expect(app.locator('#slash-menu')).toContainText('Standup');
});

test('the assistant can add an MCP server after you approve; its tools are offered in the same reply (decision 213)', async ({ app }) => {
  await app.fill('#input', 'MAKEMCP add the pictures server');
  await app.click('#send-btn');
  await expect(app.locator('#ask-question')).toContainText('Add the MCP server “pics”');
  await expect(app.locator('#ask-question')).toContainText('Add only servers you trust');
  await app.click('#ask-options .menu-item:has-text("Add it")');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
  await expect(app.locator('.msg.assistant').last()).toContainText('MCP-OFFERED');
  await expect(app.locator('.tool-card', { hasText: 'MCP servers' }).last()).toContainText('Connected: 2 tools');
  await app.evaluate(() => document.querySelector('#open-mcp').click());
  await expect(app.locator('#mcp-list')).toContainText('pics');
});

// Decision 261: the assistant makes, changes and deletes roleplay presets – after you approve
test('the assistant can make a roleplay preset and make it the default, after you approve', async ({ app }) => {
  await app.fill('#input', 'MAKEPRESET please');
  await app.click('#send-btn');
  await expect(app.locator('#ask-sheet')).toHaveClass(/open/);
  await expect(app.locator('#ask-question')).toContainText('Make a roleplay preset “Noir”, a copy of the “Slow burn” starter');
  await app.click('#ask-options .menu-item:has-text("Make it")');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
  await expect(app.locator('.tool-card', { hasText: 'Roleplay presets' })).toContainText('Made the preset “Noir”');
  const s = await app.evaluate(
    () =>
      new Promise((res) => {
        const r = indexedDB.open('chronicle');
        r.onsuccess = () => {
          const q = r.result.transaction('kv').objectStore('kv').get('settings');
          q.onsuccess = () => res(q.result);
        };
      }),
  );
  const noir = s.rpPresets.find((p) => p.name === 'Noir');
  expect(noir.rpNote).toBe('Rain, always rain.');
  expect(noir.rpPhi).toMatch(/Let the story breathe/);
  expect(s.rpPresetId).toBe(noir.id);
});
