import { test, expect } from './helpers.js';

// Roleplay and chats keep apart what belongs to each: their own selected model, and ⚡ Bypass only in agent chats.
const tab = (app, mode) => app.evaluate((m) => {
  if (!document.body.classList.contains('drawer-open')) document.getElementById('menu-btn').click();
  document.querySelector(`.mode-tab[data-mode="${m}"]`).click();
  if (document.body.classList.contains('drawer-open')) document.getElementById('scrim').click();
}, mode);
const pick = async (app, name) => {
  await app.click('#model-btn');
  await app.fill('#model-search', name);
  await app.locator('#model-sheet .model-item', { hasText: name }).first().click();
  await expect(app.locator('#model-name')).toHaveText(name);
};

test('roleplay and chats each remember their own model', async ({ app }) => {
  await expect(app.locator('#model-name')).toHaveText('GLM-5.3');
  await tab(app, 'rp');
  await pick(app, 'DeepSeek V4 Pro'); // "Soji" in roleplay
  await tab(app, 'chat');
  await expect(app.locator('#model-name')).toHaveText('GLM-5.3'); // the chat model, not the roleplay one
  await pick(app, 'DeepSeek V4.1 Flash');
  await tab(app, 'rp');
  await expect(app.locator('#model-name')).toHaveText('DeepSeek V4 Pro');
  await tab(app, 'chat');
  await expect(app.locator('#model-name')).toHaveText('DeepSeek V4.1 Flash');
  // and after a restart
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await tab(app, 'rp');
  await expect(app.locator('#model-name')).toHaveText('DeepSeek V4 Pro');
});

test.describe('⚡ Bypass is for agent chats', () => {
  test.use({ appSettings: { prefs: { tools: true, bypassDefault: true } } });
  test('a new roleplay does not start in Bypass and shows no chip; a new chat does', async ({ app }) => {
    await expect(app.locator('#mode-btn')).toHaveText('⚡ Bypass');
    await tab(app, 'rp');
    await expect(app.locator('#mode-btn')).toBeHidden();
    await tab(app, 'chat');
    await expect(app.locator('#mode-btn')).toHaveText('⚡ Bypass');
  });
});

// The side menu with both subscriptions: one card, the same rows, a hairline between them (decision 168)
test.use({ viewport: { width: 400, height: 860 } });
test('Go and Claude Code usage join into one card', async ({ app }) => {
  await app.click('#menu-btn');
  const r = await app.evaluate(() => {
    const row = (label, rest, pct) => `<div class="meter"><div class="meter-top"><span>${label}</span><span class="dim">${rest}</span></div><div class="meter-bar"><i style="width:${pct}%"></i></div></div>`;
    const go = document.getElementById('go-usage');
    go.innerHTML = '<div class="go-usage-title"><span>OpenCode Go usage</span><button class="go-usage-link">History</button><a class="go-usage-link">Console ↗</a></div>' + row('5-hour', '0% · resets 5h 1m', 0) + row('Weekly', '14% · resets 18h 28m', 14) + row('Monthly', '7% · resets 27d', 7);
    go.hidden = false;
    const cc = document.getElementById('cc-usage-line');
    cc.innerHTML = '<div class="go-usage-title"><span>Claude Code usage</span><button class="go-usage-link">Details</button></div>' + row('5-hour', '25% · resets 2h 10m', 25) + row('Weekly', '26% · resets 4d', 26);
    cc.hidden = false;
    const a = go.getBoundingClientRect();
    const b = cc.getBoundingClientRect();
    const gs = getComputedStyle(go);
    const cs = getComputedStyle(cc);
    return { gap: b.top - a.bottom, goBottom: gs.borderBottomLeftRadius, ccTop: cs.borderTopLeftRadius, ccWidth: b.width, goWidth: a.width, goTitle: getComputedStyle(go.querySelector('.go-usage-title span')).fontSize, ccTitle: getComputedStyle(cc.querySelector('.go-usage-title span')).fontSize };
  });
  expect(r.gap).toBeLessThanOrEqual(1);
  expect(r.goBottom).toBe('0px');
  expect(r.ccTop).toBe('0px');
  expect(r.ccWidth).toBe(r.goWidth);
  expect(r.ccTitle).toBe(r.goTitle);
  if (process.env.SHOT) await app.locator('#drawer').screenshot({ path: process.env.SHOT });
});
