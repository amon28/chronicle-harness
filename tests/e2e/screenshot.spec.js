import { test, expect, send, MOCK } from './helpers.js';

const requests = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);
const fakeShots = () => {
  globalThis.__shots = [];
  globalThis.__ocmScreenshot = async (url, { view }) => {
    globalThis.__shots.push([url, view]);
    const w = view === 'mobile' ? 780 : 1280;
    const h = view === 'mobile' ? 1688 : 800;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = view === 'mobile' ? '#3b82f6' : '#22c55e';
    g.fillRect(0, 0, w, h);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width: w, height: h, mime: 'image/png' };
  };
};

test.describe('vision model', () => {
  test.use({ appSettings: { model: 'kimi-k3', prefs: { tools: true, toolWeb: true, toolPython: false } } });
  test('screenshot_page shows the model the page on a phone and on a desktop', async ({ app, request }) => {
    await app.addInitScript(fakeShots);
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await send(app, 'SHOTPAGE please look at the site');
    await expect(app.locator('.tool-card summary').last()).toContainText('Screenshot');
    expect(await app.evaluate(() => globalThis.__shots)).toEqual([['https://example.com/', 'mobile'], ['https://example.com/', 'desktop']]);
    const last = (await requests(request)).at(-1).messages.at(-1);
    const imgs = last.content.filter((p) => p.type === 'image_url');
    expect(imgs.length).toBeGreaterThanOrEqual(2); // the phone one is cut into parts if it is tall
    expect(last.content[0].text).toContain('mobile');
    expect(last.content[0].text).toContain('desktop');
    // the pictures also show up right under the reply, no need to open the files
    await expect(app.locator('.msg.assistant').last().locator('.agent-images .msg-image img')).toHaveCount(2);
    // …directly under the tool call that made them, before the rest of the reply
    await expect(app.locator('.msg.assistant').last().locator('.tool-card + .agent-images')).toHaveCount(1);
    await expect(app.locator('.msg.assistant').last().locator('.msg-image-name').first()).toContainText('example.com-mobile');
    // a second look at the same page keeps the first screenshot
    await send(app, 'SHOTPAGE again');
    await app.click('#files-btn');
    await expect(app.locator('#ws-list')).toContainText('example.com-mobile-2.png');
    await app.click('#files-sheet [data-close]');
    // saved in the chat's files so they can be opened from the file manager
    await app.click('#files-btn');
    await expect(app.locator('#ws-list')).toContainText('example.com-mobile.png'); // the files page is a tree now: folders, then names
    await expect(app.locator('#ws-list')).toContainText('example.com-desktop.png');
  });
});

test.describe('text-only model', () => {
  test.use({ appSettings: { model: 'glm-5.3', prefs: { tools: true, toolWeb: true, toolPython: false } } });
  test('a vision model describes the screenshots instead', async ({ app, request }) => {
    await app.addInitScript(fakeShots);
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await send(app, 'SHOTPAGE please look at the site');
    await expect(app.locator('.msg.assistant').last()).toContainText('one red and one blue square');
    const reqs = await requests(request);
    const tool = reqs.at(-1).messages.find((m) => m.role === 'tool');
    expect(tool.content).toContain('Description by');
  });
});
