import { test, expect, send, MOCK } from './helpers.js';
import { fileURLToPath } from 'node:url';

// A zip of photos lands in the agent's sandbox; view_images lets the model actually look at them.
const zip = fileURLToPath(new URL('./fixtures/photos.zip', import.meta.url));
const requests = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);

async function sendZip(app) {
  await app.setInputFiles('#file-input', zip);
  await expect(app.locator('#attachments .file-chip')).toHaveCount(1);
  await send(app, 'check the images');
}

test.describe('vision model', () => {
  test.use({ appSettings: { model: 'kimi-k3', prefs: { tools: true, toolWeb: false, toolPython: false } } });
  test('sees images from a zip directly', async ({ app, request }) => {
    await sendZip(app);
    await expect(app.locator('.msg.assistant').last()).toContainText('I looked at 2 images directly.');
    await expect(app.locator('.tool-card summary').last()).toContainText('Looked at');
    const last = (await requests(request)).at(-1).messages.at(-1);
    expect(last.role).toBe('user');
    const imgs = last.content.filter((p) => p.type === 'image_url');
    expect(imgs).toHaveLength(2);
    expect(imgs[0].image_url.url).toMatch(/^data:image\/(jpeg|png);base64,/);
  });
});

test.describe('text-only model', () => {
  test.use({ appSettings: { model: 'glm-5.3', prefs: { tools: true, toolWeb: false, toolPython: false } } });
  test('gets descriptions from a vision model instead', async ({ app, request }) => {
    await sendZip(app);
    await expect(app.locator('.msg.assistant').last()).toContainText('one red and one blue square');
    const reqs = await requests(request);
    const helper = reqs.find((r) => Array.isArray(r.messages[0].content));
    expect(helper.model).not.toBe('glm-5.3');
    expect(helper.messages[0].content.filter((p) => p.type === 'image_url')).toHaveLength(2);
    // the main model got the descriptions as the tool result
    const tool = reqs.at(-1).messages.find((m) => m.role === 'tool');
    expect(tool.content).toContain('a solid red square');
  });
});

test.describe('two long pictures in one message', () => {
  test.use({ appSettings: { model: 'kimi-k3' } });
  test('stay inside the screen (no sideways scrolling)', async ({ app }) => {
    await app.evaluate(async () => {
      const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.fillStyle = '#3b82f6'; g.fillRect(0, 0, w, h); return c.toDataURL('image/png'); };
      const conv = { id: 'wide1', title: 'Long pictures', createdAt: Date.now(), updatedAt: Date.now(), personaId: 'general', messages: [{ role: 'user', content: 'two long screenshots', images: [mk(500, 3200), mk(500, 3200)], at: Date.now() }, { role: 'assistant', content: 'ok', personaId: 'general', model: 'kimi-k3', at: Date.now() }] };
      await new Promise((res) => { const r = indexedDB.open('chronicle', 3); r.onsuccess = () => { const t = r.result.transaction('conversations', 'readwrite'); t.objectStore('conversations').put(conv); t.oncomplete = res; }; });
    });
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await app.click('#menu-btn');
    await app.click('.conv-title:has-text("Long pictures")');
    await expect(app.locator('.msg.user .msg-images img')).toHaveCount(2);
    const over = await app.evaluate(() => {
      const m = document.getElementById('messages');
      return { scroll: m.scrollWidth - m.clientWidth, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    expect(over.scroll).toBeLessThanOrEqual(1);
    expect(over.doc).toBeLessThanOrEqual(1);
  });
});

test.describe('older pictures', () => {
  test.use({ appSettings: { model: 'kimi-k3' } });
  test('are named, not sent again: only the newest two picture turns carry their images', async ({ app, request }) => {
    await app.evaluate(async () => {
      const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const t = Date.now();
      const u = (content, imgs, paths) => ({ role: 'user', content, images: imgs, ...(paths ? { imagePaths: paths } : {}), at: t });
      const a = (content) => ({ role: 'assistant', content, personaId: 'general', model: 'kimi-k3', at: t });
      const conv = { id: 'pics3', title: 'Three pictures', createdAt: t, updatedAt: t, personaId: 'general', messages: [u('first photo', [px], ['uploads/cat.png']), a('a cat'), u('second photo', [px]), a('a dog'), u('third photo', [px, px]), a('two birds')] };
      await new Promise((res) => { const r = indexedDB.open('chronicle', 3); r.onsuccess = () => { const tx = r.result.transaction('conversations', 'readwrite'); tx.objectStore('conversations').put(conv); tx.oncomplete = res; }; });
    });
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await app.click('#menu-btn');
    await app.click('.conv-title:has-text("Three pictures")');
    await send(app, 'which was best?');
    const last = (await requests(request)).at(-1);
    const users = last.messages.filter((m) => m.role === 'user');
    const imgs = (m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').length : 0);
    expect(users.map(imgs)).toEqual([0, 1, 2, 0]); // the first photo's turn: no picture any more
    expect(users[0].content).toContain('[Image the user attached earlier, not sent again: uploads/cat.png]');
    expect(users[0].content).toContain('first photo');
  });
});

test.describe('attached pictures keep their bytes', () => {
  test.use({ appSettings: { model: 'kimi-k3', prefs: { tools: true, toolWeb: false, toolPython: false } } });
test('an attached PNG is saved byte for byte (no JPEG re-encode) and small ones are sent as they are', async ({ app, request }) => {
  // a 16×16 PNG with transparency, made in the page
  const png = await app.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(255,0,0,0.5)';
    g.fillRect(2, 2, 8, 8);
    const b = await new Promise((r) => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  });
  await app.setInputFiles('#file-input', { name: 'icon.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await app.fill('#input', 'look');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 15000 });
  const reqs = (await (await request.get(`${globalThis.__MOCK}/__requests`)).json()).filter((r) => r.messages);
  const parts = reqs.at(-1).messages.at(-1).content;
  const img = parts.find((p) => p.type === 'image_url').image_url.url;
  expect(img.startsWith('data:image/png;base64,')).toBe(true);
  expect(Buffer.from(img.split(',')[1], 'base64').equals(Buffer.from(png))).toBe(true);
  // the model is told where the file is and that it is the file as sent
  expect(parts.find((p) => p.type === 'text').text).toMatch(/\[Attached: icon\.png – saved exactly as sent/);
});

test('view_images enlarges a 16×16 icon with hard edges, on checker, dark and light', async ({ app, request }) => {
  const png = await app.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d');
    g.fillStyle = '#00f';
    g.fillRect(0, 0, 8, 16);
    const b = await new Promise((r) => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  });
  await app.setInputFiles('#file-input', { name: 'icon.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await app.fill('#input', 'here');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 15000 });
  await app.fill('#input', 'VIEWPIX look at it closely');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 15000 });
  await expect(app.locator('.msg.assistant').last()).toContainText('Showing 1 image');
  const reqs = (await (await request.get(`${globalThis.__MOCK}/__requests`)).json()).filter((r) => r.messages);
  const shown = reqs.at(-1).messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === 'image_url').at(-1).image_url.url;
  expect(shown.startsWith('data:image/png;base64,')).toBe(true);
  const buf = Buffer.from(shown.split(',')[1], 'base64');
  // three 256 px copies side by side with 8 px gaps: 256*3 + 16 wide, 256 high
  expect([buf.readUInt32BE(16), buf.readUInt32BE(20)]).toEqual([784, 256]);
  // the colours are not smoothed: the pixel column at the edge between blue and transparent is pure
  const edge = await app.evaluate(async (u) => {
    const img = new Image();
    img.src = u;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    return [...g.getImageData(127, 100, 2, 1).data];
  }, shown);
  expect(edge.slice(0, 3)).toEqual([0, 0, 255]); // last blue pixel stays blue
  expect(edge.slice(4, 7)).not.toEqual([0, 0, 255]); // the next one is background, no blend
});
});

