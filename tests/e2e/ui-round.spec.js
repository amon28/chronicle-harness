// Decision 148: text size scales the whole app, settings search, the preset chip in roleplays, the app's own text
// sheet instead of prompt()/confirm(), contrast, tap targets, the tools chip menu, the Tools & agent page, a11y.
import { test, expect, send, closeSheets, lastRequest } from './helpers.js';

const openSettings = async (app) => {
  await app.click('#menu-btn');
  await app.click('#open-settings');
};
const contrast = (el, fg) =>
  el.evaluate((node, fg) => {
    const rgb = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number);
    const lum = (c) => {
      const [r, g, b] = rgb(c).map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    let bgEl = node;
    while (bgEl && /rgba?\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(bgEl).backgroundColor)) bgEl = bgEl.parentElement;
    const [a, b] = [lum(fg || getComputedStyle(node).color), lum(getComputedStyle(bgEl || document.body).backgroundColor)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  }, fg);

test.describe('text size XL on a small phone', () => {
  test.use({ viewport: { width: 360, height: 640 }, appSettings: { prefs: { textSize: 'xl', tools: true } } });
  test('scales Settings, the drawer and the chips, not only messages – and nothing runs off the screen', async ({ app }) => {
    await send(app, 'hello');
    // the composer chips and the message actions grew with the text (tap areas too)
    expect(parseFloat(await app.locator('#tools-btn').evaluate((e) => getComputedStyle(e).fontSize))).toBeCloseTo(15, 0);
    expect((await app.locator('#send-btn').boundingBox()).width).toBeGreaterThanOrEqual(47); // 38 px at M
    await app.click('#menu-btn');
    await expect.poll(() => app.locator('#drawer').evaluate((e) => getComputedStyle(e).transform)).toMatch(/none|matrix\(1, 0, 0, 1, 0, 0\)/);
    // the drawer's bottom buttons stay inside it
    const drawer = await app.locator('#drawer').boundingBox();
    for (const id of ['#open-personas', '#open-memory', '#open-settings']) {
      const b = await app.locator(id).boundingBox();
      expect(b.x + b.width, id).toBeLessThanOrEqual(drawer.x + drawer.width + 0.5);
    }
    await app.click('#open-settings');
    expect(await app.locator('.set-item .set-txt b').first().evaluate((e) => getComputedStyle(e).fontSize)).toBe('18.75px');
    for (const page of ['tools', 'rppreset', 'look', 'data']) {
      await app.click(`.set-item[data-page="${page}"]`);
      const over = await app.evaluate(() => {
        const vw = innerWidth;
        return [...document.querySelectorAll('#settings-sheet .set-page:not([hidden]) *')]
          .filter((e) => {
            const r = e.getBoundingClientRect();
            if (r.width < 1 || r.right <= vw + 0.5) return false;
            for (let p = e.parentElement; p; p = p.parentElement) if (/(auto|scroll|hidden)/.test(getComputedStyle(p).overflowX) && !p.matches('.sheet-card')) return false;
            return true;
          })
          .map((e) => e.id || e.className);
      });
      expect(over, page).toEqual([]);
      expect(await app.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
      await app.click('#set-back');
    }
  });
});

test('message actions, swipe arrows and composer chips have tap areas of at least 40×40', async ({ app }) => {
  await send(app, 'hello');
  await app.click('.msg.assistant:last-child .act-icon[aria-label="Retry"]'); // a second version: the ‹ › arrows
  await expect(app.locator('.msg.assistant:last-child .pager-btn')).toHaveCount(2);
  await app.waitForFunction(() => !document.body.classList.contains('streaming'));
  const small = await app.evaluate(() =>
    [...document.querySelectorAll('.act-icon, .act-more, .pager-btn, .composer-meta .meta-chip')]
      .map((e) => [e.className, e.getBoundingClientRect()])
      .filter(([, r]) => r.width > 0 && (r.width < 40 || r.height < 40))
      .map(([c, r]) => `${c} ${Math.round(r.width)}x${Math.round(r.height)}`),
  );
  expect(small).toEqual([]);
});

test('the tools chip says what is on and opens a menu instead of flipping the tools', async ({ app }) => {
  await expect(app.locator('#tools-btn')).toHaveText(/Tools off/);
  await app.click('#tools-btn');
  await expect(app.locator('#tools-menu')).toHaveClass(/open/);
  await expect(app.locator('#tools-btn')).toHaveText(/Tools off/); // the tap alone changed nothing
  await expect(app.locator('#tools-switch')).not.toBeChecked();
  await expect(app.locator('#tools-on-list')).toContainText('Web search');
  await app.check('#tools-switch');
  await expect(app.locator('#tools-btn')).toHaveText(/\d+ tools/);
  await expect(app.locator('#tools-on-head')).toContainText('On in this chat');
  await app.click('#tools-settings');
  await expect(app.locator('#settings-sheet')).toHaveClass(/open/);
  await expect(app.locator('.set-page[data-page="tools"]')).toBeVisible();
});

test('Settings search finds pages and single settings by their words and by synonyms, and jumps to the row', async ({ app }) => {
  await app.evaluate(() => (globalThis.__ocmDevice = { status: async () => ({}) })); // Phone data is offered
  await openSettings(app);
  await app.fill('#set-search', 'calendar');
  await expect(app.locator('#set-results .set-result').first()).toContainText('Phone data');
  await expect(app.locator('.set-item[data-page="account"]')).toBeHidden();
  await app.fill('#set-search', 'api key');
  await expect(app.locator('#set-results')).toContainText('OpenCode Go API key');
  await app.fill('#set-search', 'zzqx');
  await expect(app.locator('#set-results')).toContainText('Nothing found');
  // a setting added to the page later is found too: the index is read from the sheet
  await app.evaluate(() => document.querySelector('.set-page[data-page="chat"]').insertAdjacentHTML('beforeend', '<label class="toggle" id="t-new"><input type="checkbox" /> <span>Brand-new frobnicator</span></label>'));
  await closeSheets(app);
  await openSettings(app);
  await app.fill('#set-search', 'frobnicator');
  await expect(app.locator('#set-results .set-result')).toHaveCount(1);
  await app.fill('#set-search', 'calendar');
  await app.locator('#set-results .set-result').first().click();
  await expect(app.locator('.set-page[data-page="tools"]')).toBeVisible();
  await expect(app.locator('#set-title')).toContainText('Tools & agent');
  await expect(app.locator('#pref-tool-device-row')).toHaveClass(/set-flash/);
  await expect(app.locator('#pref-tool-device-row')).toBeInViewport();
  // back: the results are still there
  await app.click('#set-back');
  await expect(app.locator('#set-results .set-result').first()).toContainText('Phone data');
  await app.fill('#set-search', '');
  await expect(app.locator('.set-item[data-page="account"]')).toBeVisible();
});

test.describe('roleplay chat', () => {
  const P = { id: 'rpp_slow', name: 'Slow burn', model: '', effort: '', rpPhi: 'SLOW PHI' };
  test.use({ appSettings: { prefs: { mode: 'rp' }, rpPresets: [P] } });
  test('the preset chip shows the preset and changes it in one tap; Edit presets opens the page', async ({ app, request }) => {
    await expect(app.locator('#preset-btn')).toBeVisible();
    await expect(app.locator('#preset-btn')).toHaveText(/Standard/);
    await app.click('#preset-btn');
    await expect(app.locator('#choose-sheet')).toHaveClass(/open/);
    await expect(app.locator('#choose-list .menu-item.current')).toContainText('Default');
    await app.click('#choose-list .menu-item:has-text("Slow burn")');
    await expect(app.locator('#preset-btn')).toHaveText(/Slow burn/);
    await send(app, 'hi');
    const req = await lastRequest(request);
    expect(req.messages.some((m) => m.content === 'SLOW PHI')).toBe(true);
    // the chat sheet's row says the same
    await app.click('#chat-more-btn');
    await app.click('#cm-settings');
    await expect(app.locator('#chat-preset')).toHaveValue('rpp_slow');
    await closeSheets(app);
    await app.click('#preset-btn');
    await app.click('#choose-list .menu-item:has-text("Edit presets")');
    await expect(app.locator('.set-page[data-page="rppreset"]')).toBeVisible();
  });

  test('the preset chip is gone in Chats: after switching from a roleplay to the Chats side, and in a new chat there', async ({ app }) => {
    await expect(app.locator('#preset-btn')).toBeVisible();
    await app.click('#menu-btn');
    await app.click('.mode-tab[data-mode="chat"]');
    await expect(app.locator('#preset-btn')).toBeHidden();
    await app.click('#drawer-new');
    await expect(app.locator('#preset-btn')).toBeHidden();
  });

  test('the preset bar names, renames and deletes in the app’s own sheets (no system dialogs)', async ({ app }) => {
    app.on('dialog', (d) => {
      throw new Error('a system dialog opened: ' + d.message());
    });
    await openSettings(app);
    await app.click('.set-item[data-page="rppreset"]');
    await app.selectOption('#rp-preset-sel', 'rpp_slow');
    await app.click('#rp-preset-rename');
    await expect(app.locator('#text-sheet')).toHaveClass(/open/);
    await expect(app.locator('#text-input')).toHaveValue('Slow burn');
    await app.fill('#text-input', '  Slower burn  ');
    await app.press('#text-input', 'Enter');
    await expect(app.locator('#rp-preset-sel option:checked')).toHaveText(/Slower burn/);
    await expect(app.locator('#preset-btn')).toHaveText(/Standard/); // (the chat follows the default: Standard)
    // cancel keeps everything
    await app.click('#rp-preset-dup');
    await app.click('#text-sheet [data-close].ghost-btn');
    await expect(app.locator('#rp-preset-sel option')).toHaveCount(2);
    await app.click('#rp-preset-del');
    await expect(app.locator('#choose-sheet')).toHaveClass(/open/);
    await expect(app.locator('#choose-list .menu-item.danger')).toHaveText('Delete');
    await app.click('#choose-list .menu-item.danger');
    await expect(app.locator('#rp-preset-sel option')).toHaveCount(1);
  });

  test('dialogue with *emphasis* inside it keeps the dialogue colour (it was left white)', async ({ app }) => {
    await send(app, '"Who sent me?" *She parrots it.* "Boss, I already told you — *nobody* sent me." *Her voice wavers.* "That\'s how it *works* in my line of— ah, *fuck*—"');
    const msg = app.locator('.rp-on').filter({ hasText: 'Who sent me' }).first();
    const said = await msg.locator('.rp-q').allTextContents();
    expect(said.join('')).toBe('"Who sent me?""Boss, I already told you — nobody sent me.""That\'s how it works in my line of— ah, fuck—"');
    // the emphasis inside the dialogue is in the dialogue colour too; the actions are not
    const quote = await msg.locator('.rp-q').first().evaluate((e) => getComputedStyle(e).color);
    expect(await msg.locator('em .rp-q', { hasText: 'nobody' }).evaluate((e) => getComputedStyle(e).color)).toBe(quote);
    expect(await msg.locator('em', { hasText: 'She parrots it.' }).evaluate((e) => getComputedStyle(e).color)).not.toBe(quote);
    expect(await msg.locator('em', { hasText: 'nobody' }).evaluate((e) => getComputedStyle(e).fontStyle)).toBe('italic');
  });

  test('light theme: the default roleplay colours are readable; a colour you pick is kept', async ({ app }) => {
    await app.emulateMedia({ colorScheme: 'light' });
    await send(app, '*waves* "Hello!"');
    const em = app.locator('.msg.user .rp-on em, .rp-on .user-text em').first();
    await expect(em).toBeVisible();
    expect(await contrast(em)).toBeGreaterThanOrEqual(4.5);
    expect(await contrast(app.locator('.rp-on .rp-q').first())).toBeGreaterThanOrEqual(4.5);
    await openSettings(app);
    await app.click('.set-item[data-page="rp"]');
    await app.locator('#pref-rp-quote').evaluate((e) => {
      e.value = '#123456';
      e.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await app.waitForTimeout(600);
    expect(await app.evaluate(() => JSON.parse(localStorage.getItem('ocm.settings') || '{}').prefs?.rpQuote ?? 'idb')).not.toBe('');
    await app.emulateMedia({ colorScheme: 'dark' });
    expect(await app.evaluate(() => getComputedStyle(document.querySelector('.rp-on .rp-q')).color)).toBe('rgb(18, 52, 86)');
    // Reset: back to the theme's own
    await app.click('#rp-colors-reset');
    expect(await app.evaluate(() => getComputedStyle(document.querySelector('.rp-on .rp-q')).color)).toBe('rgb(240, 179, 90)');
  });
});

for (const scheme of ['light', 'dark']) {
  test(`${scheme} theme: the greyed text (--text-3) is 4.5:1 or more on the sheet`, async ({ app }) => {
    await app.emulateMedia({ colorScheme: scheme });
    await openSettings(app);
    await app.click('.set-item[data-page="chat"]');
    const dim = app.locator('.set-page[data-page="chat"] .label .dim').first();
    expect(await contrast(dim)).toBeGreaterThanOrEqual(4.5);
  });
}

test('fields have names for screen readers; reduced motion turns animations off', async ({ app }) => {
  // (read from the attributes: a closed sheet's fields have no computed name while hidden)
  const nameOf = (id) => app.locator(id).evaluate((e) => (e.getAttribute('aria-label') || [...(e.labels || [])].map((l) => l.textContent).join(' ')).trim());
  for (const id of ['#pref-fallback', '#pref-thinking', '#pref-rp-main', '#pref-helper', '#rp-preset-model', '#pref-tts-rate']) expect(await nameOf(id), id).toMatch(/\w/);
  expect(await nameOf('#pref-rp-main')).toBe('Pre-history prompt');
  expect(await nameOf('#pref-helper')).toBe('Helper model');
  await openSettings(app);
  await app.click('.set-item[data-page="account"]');
  await expect(app.locator('#pref-fallback')).toHaveAccessibleName('If a model stays busy, switch to');
  await app.emulateMedia({ reducedMotion: 'reduce' });
  expect(await app.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.sheet')).transitionDuration))).toBeLessThan(0.01);
});
