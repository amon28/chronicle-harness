import { test, expect, MOCK } from './helpers.js';

const requests = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);

test.use({ appSettings: { model: 'kimi-k3', prefs: { tools: true } } }); // a model that can see pictures

test('the assistant writes a page, previews it, and gets the screenshot plus the page\'s errors back', async ({ app, request }) => {
  await app.addInitScript(() => {
    globalThis.__rendered = [];
    const shot = () => {
      const c = document.createElement('canvas');
      c.width = 390;
      c.height = 844;
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 390, 844);
      return c.toDataURL('image/jpeg').split(',')[1];
    };
    globalThis.__ocmBrowser = {
      renderHtml: async (o) => (globalThis.__rendered.push(o), { url: 'about:blank', title: '' }),
      eval: async () => ({ value: JSON.stringify(['oops from the page (app.js:1)']) }),
      screenshot: async () => ({ base64: shot(), width: 390, height: 844 }),
      open: async () => ({}),
      close: async () => ({}),
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.fill('#input', 'PREVIEWME make me a page');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  // several calls in a row fold into one "N steps" box: the card is there, inside it
  await expect(app.locator('.tool-card', { hasText: 'Previewed the page' })).toHaveCount(1);
  // the page was handed to the renderer as ONE document: its css and script inlined
  const sent = await app.evaluate(() => globalThis.__rendered[0]);
  expect(sent.width).toBe(390);
  expect(sent.html).toContain('<style>h1 { color: tomato;');
  expect(sent.html).toContain('document.title = "ready"');
  expect(sent.html).not.toContain('href="style.css"');
  // the assistant got the errors and the picture
  const last = (await requests(request)).at(-1);
  const tool = last.messages.filter((m) => m.role === 'tool').at(-1).content;
  expect(tool).toContain('oops from the page');
  expect(tool).toContain('/workspace/output/screenshots/preview-site_index.html-mobile.jpg');
  expect(JSON.stringify(last.messages.at(-1).content)).toContain('image_url');
});
