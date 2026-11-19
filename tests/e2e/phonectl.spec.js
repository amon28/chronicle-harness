import { test, expect, send, lastRequest, offeredTools } from './helpers.js';

test.use({ appSettings: { prefs: { tools: true } } });

test('Phone status & controls: one switch under Tools, on by default; off takes the three tools away', async ({ app, request }) => {
  await app.addInitScript(() => {
    globalThis.__ocmPhone = { status: async () => ({ battery: { percent: 63, status: 'discharging' } }) };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await send(app, 'hello');
  let tools = offeredTools(await lastRequest(request));
  expect(tools).toEqual(expect.arrayContaining(['phone_status', 'phone_control', 'take_photo']));
  // their guidance comes with load_tools now (decision 199), not in every system prompt
  expect((await lastRequest(request)).messages[0].content).not.toContain('phone_status tells you battery');

  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="tools"]');
  const row = app.locator('#pref-tool-phonectl-row');
  await expect(row).toBeVisible();
  await expect(row).toContainText('Phone status & controls');
  await expect(app.locator('#pref-tool-phonectl')).toBeChecked();
  // the map services: empty means the defaults; an address that cannot work is not kept
  await app.locator('#osm-box summary').click();
  await app.fill('#osm-tiles', 'https://tiles.example/no-placeholders.png');
  await app.locator('#osm-tiles').dispatchEvent('change');
  await expect(app.locator('#osm-tiles')).toHaveValue('');
  await app.fill('#osm-overpass', 'https://overpass.example/api/interpreter');
  await app.locator('#osm-overpass').dispatchEvent('change');
  const stored = (...keys) =>
    app.evaluate(
      (keys) =>
        new Promise((resolve) => {
          const q = indexedDB.open('chronicle');
          q.onsuccess = () => {
            const g = q.result.transaction('kv').objectStore('kv').get('settings');
            g.onsuccess = () => (resolve(JSON.stringify(keys.reduce((o, k) => o?.[k], g.result) ?? null)), q.result.close());
          };
        }),
      keys,
    );
  await expect.poll(() => stored('osm')).toBe('{"overpass":"https://overpass.example/api/interpreter"}');
  await app.click('#osm-reset');
  await expect(app.locator('#osm-overpass')).toHaveValue('');
  await app.locator('#pref-tool-phonectl').uncheck();
  await app.evaluate(() => document.querySelectorAll('.sheet.open').forEach((x) => x.querySelector('[data-close]')?.click()));
  await expect.poll(() => stored('prefs', 'toolPhoneCtl')).toBe('false'); // settings save a moment after the change
  await send(app, 'again');
  tools = offeredTools(await lastRequest(request));
  expect(tools).not.toContain('phone_status');
  expect(tools).not.toContain('take_photo');
});
