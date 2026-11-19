import { test, expect, MOCK } from './helpers.js';

const requests = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);
test.use({ appSettings: { model: 'kimi-k3', prefs: { tools: true, toolBrowser: true } } });

test('two full_page browser screenshots in one session are saved under two names', async ({ app, request }) => {
  await app.addInitScript(() => {
    let frame;
    let n = 0;
    const jpg = (h) => {
      const c = document.createElement('canvas');
      c.width = 390;
      c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 390, h);
      g.fillStyle = '#333';
      for (let y = 10; y < h; y += 40) g.fillRect(10, y, 300, 12);
      return c.toDataURL('image/jpeg').split(',')[1];
    };
    globalThis.__ocmBrowser = {
      open: async () => {
        frame?.remove();
        frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;left:-9999px;width:390px;height:844px';
        frame.srcdoc = '<title>Tall</title><h1>Tall page</h1>' + '<p>line</p>'.repeat(200);
        document.body.append(frame);
        await new Promise((r) => (frame.onload = r));
        return { url: 'https://example.test/page', title: 'Tall' };
      },
      eval: async ({ js }) => ({ value: JSON.stringify(frame.contentWindow.eval(js.split('location.href').join("'https://example.test/page'"))) }),
      screenshot: async () => {
        n++;
        const h = n === 1 ? 317 : 7618;
        return { base64: jpg(h), width: 390, height: h, tall: true };
      },
      close: async () => frame?.remove(),
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.fill('#input', 'BROWSESHOT2 take two');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 60000 });
  const last = (await requests(request)).at(-1);
  const tools = last.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
  const names = tools.map((t) => /Saved as (\S+?\.jpg)/.exec(t)?.[1]).filter(Boolean);
  expect(names).toHaveLength(2);
  expect(names[0]).not.toBe(names[1]);
  for (const n of names) expect(tools.at(-1)).toContain(n.replace('/workspace/', ''));
});
