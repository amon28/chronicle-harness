import { test, expect, MOCK } from './helpers.js';

const requests = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);
const idle = (app) => app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
const putConv = (app, conv) =>
  app.evaluate(async (conv) => {
    await new Promise((res) => { const r = indexedDB.open('chronicle'); r.onsuccess = () => { const tx = r.result.transaction('conversations', 'readwrite'); tx.objectStore('conversations').put(conv); tx.oncomplete = res; }; });
  }, conv);
const openChat = async (app, title, mode = '') => {
  await app.click('#menu-btn');
  if (mode) await app.click(`.mode-tab[data-mode="${mode}"]`);
  await app.click(`.conv-title:has-text("${title}")`);
};

test.describe('group roleplay with a preset model', () => {
  test.use({ appSettings: { model: 'glm-5.3', rpPresets: [{ id: 'rpp_g', name: 'GroupPreset', model: 'deepseek-v4-pro', effort: '' }], rpPresetId: 'rpp_g' } });
  test('the preset model shows on the model button and does not become the app-wide model', async ({ app, request }) => {
    const t = Date.now();
    await putConv(app, { id: 'g1', title: 'Group RP', createdAt: t, updatedAt: t, personaId: 'roleplay', group: { members: ['roleplay', 'narrator'], mode: 'all', name: '', scenario: '' }, messages: [{ role: 'user', content: 'hi all', at: t }, { role: 'assistant', content: 'hello', personaId: 'roleplay', model: 'glm-5.3', at: t }] });
    await putConv(app, { id: 'p1', title: 'Plain chat', createdAt: t - 5, updatedAt: t - 5, personaId: 'general', messages: [{ role: 'user', content: 'x', at: t }, { role: 'assistant', content: 'y', personaId: 'general', model: 'glm-5.3', at: t }] });
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await openChat(app, 'Group RP', 'rp');
    await expect(app.locator('#model-name')).toContainText('GroupPreset'); // what will answer, as in a single roleplay
    await app.fill('#input', 'go on');
    await app.click('#send-btn');
    await expect(app.locator('.msg.assistant')).toHaveCount(3, { timeout: 20000 });
    await idle(app);
    const reqs = (await requests(request)).filter((r) => r.messages.some((m) => /in a group chat/.test(String(m.content))));
    expect(reqs.every((r) => r.model === 'deepseek-v4-pro')).toBe(true);
    await openChat(app, 'Plain chat', 'chat');
    await openChat(app, 'Group RP', 'rp');
    await openChat(app, 'Plain chat', 'chat');
    await expect(app.locator('#model-name')).toHaveText('GLM-5.3');
    await app.fill('#input', 'which model');
    await app.click('#send-btn');
    await idle(app);
    expect((await requests(request)).at(-1).model).toBe('glm-5.3');
  });
});

test.describe('a preset whose model is not in the list right now', () => {
  test.use({ appSettings: { model: 'glm-5.3', rpPresets: [{ id: 'rpp_k', name: 'Kept', model: 'gone-model-9', effort: 'high' }] } });

  test('editing it in Settings keeps its reasoning effort', async ({ app }) => {
    await app.click('#menu-btn');
    await app.click('#open-settings');
    await app.click('.set-item[data-page="rppreset"]');
    await app.selectOption('#rp-preset-sel', 'rpp_k');
    await expect(app.locator('#rp-preset-model')).toHaveValue('gone-model-9');
    await app.fill('#pref-phi', 'edited while the model is away');
    await app.waitForTimeout(900); // the page saves itself
    const saved = await app.evaluate(() => new Promise((res) => { const q = indexedDB.open('chronicle'); q.onsuccess = () => { const g = q.result.transaction('kv').objectStore('kv').get('settings'); g.onsuccess = () => res(g.result); }; }));
    const p = saved.rpPresets.find((x) => x.id === 'rpp_k');
    expect(p.rpPhi).toBe('edited while the model is away');
    expect(p.model).toBe('gone-model-9');
    expect(p.effort).toBe('high');
  });
});
