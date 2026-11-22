import { test, expect, send, lastRequest } from './helpers.js';

// The 📎 menu's camera (decision 229), with a stand-in for the phone's camera app.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==';
test.use({ appSettings: { model: 'kimi-k3' } });

test('Take a photo attaches it like a picked picture; Record a video goes to the chat folder and the model is told where', async ({ app, request }) => {
  await app.addInitScript((png) => {
    globalThis.__camCalls = [];
    globalThis.__ocmPhone = {
      capture: async (o) => {
        globalThis.__camCalls.push(o);
        if (o.video) return { path: '/data/shell/' + o.dest, size: 34 * 1048576 };
        return { bytes: Uint8Array.from(atob(png), (c) => c.charCodeAt(0)) };
      },
    };
  }, PNG);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');

  await app.click('#attach-btn');
  await expect(app.locator('#cmp-photo')).toBeVisible();
  await app.click('#cmp-photo');
  await expect(app.locator('#attachments img')).toHaveCount(1);

  await app.click('#attach-btn');
  await app.click('#cmp-video');
  await expect(app.locator('#attachments')).toContainText(/video-\d{8}-\d{6}\.mp4/);
  const calls = await app.evaluate(() => globalThis.__camCalls);
  expect(calls[0]).toEqual({});
  expect(calls[1].video).toBe(true);
  expect(calls[1].dest).toMatch(/^work\/[\w.-]+\/videos\/video-\d{8}-\d{6}\.mp4$/);

  await send(app, 'what is in these?');
  const req = await lastRequest(request);
  const last = req.messages.at(-1);
  const parts = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }];
  expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(1);
  const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  expect(text).toMatch(/<video name="video-\d{8}-\d{6}\.mp4" info="video, 34 MB">/);
  expect(text).toMatch(/A video the user just recorded/);
});

test('without the phone camera (a browser) the camera items are not offered', async ({ app }) => {
  await app.click('#attach-btn');
  await expect(app.locator('#cmp-attach')).toBeVisible();
  await expect(app.locator('#cmp-photo')).toBeHidden();
  await expect(app.locator('#cmp-video')).toBeHidden();
});
