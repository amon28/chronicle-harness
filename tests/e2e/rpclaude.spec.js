import { test, expect, MOCK } from './helpers.js';
import { BUILTIN_PERSONAS } from '../../src/personas.js';

// Decision 237: the Claude chip lists Claude from a provider too, so it is there in a roleplay (where Claude Code is not).
const MIRA = { id: 'p_mira', name: 'Mira', rp: true, cardMode: true, prompt: 'You are Mira.', card: { name: 'Mira', description: 'An archivist.', first_mes: 'Hi.' } };
test.use({ appSettings: { personas: [...BUILTIN_PERSONAS.map((p) => ({ ...p, builtin: true })), MIRA], providers: [{ id: 'pvT', kind: 'anthropic', name: 'Anthropic (Claude)', baseUrl: MOCK + '/anthropic', apiKey: 'sk-ant-good', via: 'native', models: 'claude-opus-5-5', context: 1000000, enabled: true }] } });

test('in a roleplay the Claude chip is there and lists the Claude models from an Anthropic key', async ({ app }) => {
  await app.evaluate(() => new Promise((res) => { const q = indexedDB.open('chronicle'); q.onsuccess = () => { const t = q.result.transaction('conversations', 'readwrite'); t.objectStore('conversations').put({ id: 'rp1', title: 'RP test', personaId: 'p_mira', createdAt: Date.now(), updatedAt: Date.now(), messages: [{ role: 'assistant', personaId: 'p_mira', content: 'Hi.', at: Date.now() }] }); t.oncomplete = res; }; }));
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.evaluate(() => document.querySelector('#menu-btn').click());
  await app.evaluate(() => document.querySelector('.mode-tab[data-mode="rp"]').click());
  await app.evaluate(() => [...document.querySelectorAll('.conv-item')].find((x) => x.textContent.includes('RP test'))?.click());
  await app.evaluate(() => document.querySelector('#model-btn').click());
  const chip = app.locator('#model-filters .filter-chip', { hasText: 'Claude' });
  await expect(chip).toHaveText(/^Claude \d+$/);
  await chip.click();
  const names = await app.locator('#model-list .model-title').allInnerTexts();
  expect(names.length).toBeGreaterThan(0);
  expect(names.every((n) => /claude/i.test(n))).toBe(true);
  expect(names).toContain('Claude Opus 5.5');
  await app.locator('#model-list .model-item', { hasText: 'Claude Opus 5.5' }).first().click();
  await expect(app.locator('#model-name')).toContainText('Claude Opus 5.5');
});
