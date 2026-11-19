import { test, expect, MOCK, offeredTools } from './helpers.js';

test.use({ appSettings: { prefs: { tools: true } } });

const ELEMENTS = [
  { type: 'node', id: 1, lat: 52.5211, lon: 13.4102, tags: { amenity: 'pharmacy', name: 'Apotheke am Markt', 'addr:street': 'Hauptstr.', 'addr:housenumber': '3', opening_hours: '24/7', phone: '+49 30 1234567', website: 'https://apotheke.example/' } },
  { type: 'node', id: 2, lat: 52.5249, lon: 13.4049, tags: { amenity: 'pharmacy', name: 'Linden-Apotheke' } },
  { type: 'way', id: 3, center: { lat: 52.519, lon: 13.4 }, tags: { amenity: 'pharmacy', name: 'Apotheke West', opening_hours: 'Mo-Fr 09:00-17:00; PH off' } },
];

/** The phone and the OpenStreetMap services, stood in for – and a watch on anything that tries to leave for a real one. */
async function standIns(page, { tilesFail = false } = {}) {
  const outside = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/openstreetmap\.org|overpass|komoot|osm\.org/i.test(u)) outside.push(u);
  });
  await page.addInitScript(
    ({ elements, tilesFail }) => {
      globalThis.__tiles = [];
      globalThis.__started = [];
      globalThis.__placeReqs = [];
      globalThis.__ocmDevice = { status: async () => ({ batteryFree: true, allFiles: false }), location: async (o) => ({ lat: 52.52008, lon: 13.40495, accuracy: 12, precise: !!o.precise, time: Date.now() }) };
      globalThis.__ocmIntents = { start: async (i) => (globalThis.__started.push(i), { opened: true }) };
      globalThis.__ocmPlacesHttp = async (url, o) => (globalThis.__placeReqs.push({ url, body: o?.body || '' }), { status: 200, body: JSON.stringify({ elements }) });
      // a 256 px tile drawn here, so no picture is fetched from anywhere
      globalThis.__ocmTiles = async (z, x, y) => {
        globalThis.__tiles.push(`${z}/${x}/${y}`);
        if (tilesFail) throw new Error('no network');
        const c = document.createElement('canvas');
        c.width = c.height = 256;
        const g = c.getContext('2d');
        g.fillStyle = '#9fd3a8';
        g.fillRect(0, 0, 256, 256);
        const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
        return new Uint8Array(await blob.arrayBuffer());
      };
    },
    { elements: ELEMENTS, tilesFail },
  );
  await page.reload();
  await page.waitForSelector('body[data-ready="1"]');
  return outside;
}

const greenAtCentre = (page) =>
  page.evaluate(() => {
    const c = document.querySelector('.map-card canvas.map-tiles');
    const d = c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return d[0] === 0x9f && d[1] === 0xd3 && d[2] === 0xa8;
  });

test('places: asks once, shows the tool card, and the answer draws a map with pins and a list', async ({ app }) => {
  const outside = await standIns(app);
  await app.fill('#input', 'PLACESME nearest pharmacy');
  await app.click('#send-btn');
  await expect(app.locator('#ask-sheet')).toContainText('Find places near you?');
  await expect(app.locator('#ask-sheet')).toContainText('rounded to about 100 m');
  await app.click('#ask-options .menu-item:has-text("Search near me")');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 15000 });

  // the tool card: what was looked for, how many, the first names
  const card = app.locator('.tool-card', { hasText: 'Looked for places' });
  await expect(card).toContainText('pharmacy – 3: Apotheke West, Apotheke am Markt, Linden-Apotheke');

  // the search server got a rounded position, once
  const reqs = await app.evaluate(() => globalThis.__placeReqs);
  expect(reqs).toHaveLength(1);
  expect(decodeURIComponent(reqs[0].body)).toContain('(around:1500,52.52,13.405)[amenity=pharmacy]');
  expect(decodeURIComponent(reqs[0].body)).not.toContain('52.52008');

  // the answer: a map with three numbered pins, the "you" dot, the attribution, and the list
  const map = app.locator('.msg.assistant .map-card').last();
  await expect(map).toBeVisible();
  await expect(map.locator('canvas.map-tiles')).toBeVisible();
  await expect(map.locator('.map-pin')).toHaveCount(3);
  await expect(map.locator('.map-pin').first()).toHaveText('1');
  await expect(map.locator('.map-me')).toHaveCount(1);
  await expect(map.locator('.map-attr')).toHaveText('© OpenStreetMap contributors');
  await expect(map.locator('.map-attr')).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright');
  await expect(map.locator('.map-title')).toHaveText('Pharmacies near you');
  const rows = map.locator('.map-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText('Apotheke am Markt');
  await expect(rows.nth(1)).toContainText('370 m');
  await expect(rows.nth(1).locator('.map-open')).toHaveText('Open now'); // 24/7
  await expect(rows.nth(0)).toContainText('Hours: Mo-Fr 09:00-17:00; PH off'); // not understood: shown as written, no guess
  await expect(rows.nth(0).locator('.map-open')).toHaveCount(0);
  await expect(rows.nth(1).locator('.map-act')).toHaveText(['Directions', 'Map', 'Call', 'Website']);
  await expect(rows.nth(2).locator('.map-act')).toHaveText(['Directions', 'Map']);
  // the pins are inside the picture, and the tiles were drawn from the stand-in
  await expect.poll(() => greenAtCentre(app)).toBe(true);
  for (const b of await map.locator('.map-pin').all()) await expect(b).toBeVisible();
  const tiles = await app.evaluate(() => globalThis.__tiles);
  expect(tiles.length).toBeGreaterThan(0);
  expect(tiles.length).toBeLessThanOrEqual(12);
  expect(new Set(tiles).size).toBe(tiles.length); // each tile asked for once

  // the buttons hand over to the phone's apps
  await rows.nth(1).locator('.map-act', { hasText: 'Directions' }).click();
  await rows.nth(1).locator('.map-act', { hasText: 'Call' }).click();
  await rows.nth(1).locator('.map-act', { hasText: 'Website' }).click();
  await rows.nth(1).locator('.map-act', { hasText: /^Map$/ }).click();
  const started = await app.evaluate(() => globalThis.__started.map((i) => `${i.action} ${i.data}`));
  expect(started).toEqual(['android.intent.action.VIEW google.navigation:q=52.5211,13.4102', 'android.intent.action.DIAL tel:%2B49%2030%201234567', 'android.intent.action.VIEW https://apotheke.example/', 'android.intent.action.VIEW geo:52.5211,13.4102?q=52.5211,13.4102(Apotheke%20am%20Markt)']);

  // a pin picks its row; zooming keeps the pins; the code is one tap away
  await map.locator('.map-pin').nth(2).click();
  await expect(rows.nth(2)).toHaveClass(/picked/);
  await map.locator('.map-zoom-btn').first().click();
  await expect(map.locator('.map-pin')).toHaveCount(3);
  await map.locator('.map-zoom-btn').nth(2).click(); // back to everything
  for (const b of await map.locator('.map-pin').all()) await expect(b).toBeVisible();
  const wrap = app.locator('.msg.assistant .code-wrap.map-block').last();
  await expect(wrap.locator('pre')).toBeHidden();
  await wrap.locator('[data-diagram-toggle]').click();
  await expect(wrap.locator('pre')).toContainText('maps/pharmacy-1.json');

  // the chat opened again later: the map is drawn again from the saved file, the tiles from the cache
  await app.waitForTimeout(800); // the chat and its files are saved a moment after the reply
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.locator('#conv-list .conv-item').first().click();
  const again = app.locator('.msg.assistant .map-card').last();
  await expect(again.locator('.map-pin')).toHaveCount(3);
  await expect(again.locator('.map-row')).toHaveCount(3);
  await expect.poll(() => greenAtCentre(app)).toBe(true);
  expect(await app.evaluate(() => globalThis.__tiles.length)).toBe(0); // kept tiles: nothing asked for again

  expect(outside, 'requests to real OpenStreetMap hosts').toEqual([]);
});

test('a map without tiles still shows the grid, the pins and the list; a bad block is a readable note', async ({ app, request }) => {
  const outside = await standIns(app, { tilesFail: true });
  await app.fill('#input', 'MAPBADME');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 15000 });
  const msg = app.locator('.msg.assistant').last();
  // the broken block keeps its code and says why
  await expect(msg.locator('.map-error')).toHaveText('This map could not be read: place 1 (Nowhere) has no valid lat / lon.');
  await expect(msg.locator('.code-wrap', { has: app.locator('.map-error') }).locator('pre')).toBeVisible();
  // the inline one draws; its name is text, never markup
  const map = msg.locator('.map-card');
  await expect(map).toHaveCount(1);
  await expect(map.locator('.map-pin')).toHaveCount(1);
  await expect(map.locator('.map-name')).toHaveText('Cafe <b>Bold</b>');
  await expect(map.locator('.map-name b')).toHaveCount(0);
  await expect(map.locator('.map-me')).toHaveCount(0);
  await expect(map.locator('.map-act')).toHaveText(['Directions', 'Map', 'Call', 'Website']);
  await expect.poll(() => app.evaluate(() => globalThis.__tiles.length)).toBeGreaterThan(0); // it tried
  expect(await greenAtCentre(app)).toBe(false); // the plain grid
  await expect(map.locator('.map-attr')).toBeVisible();
  // the model was told how to use places and the block
  const sent = (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages).pop();
  expect(offeredTools(sent)).toContain('places');
  expect(sent.messages[0].content).toContain('```map block');
  expect(outside).toEqual([]);
});
