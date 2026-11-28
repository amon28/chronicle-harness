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
  await expect(app.locator('#toast')).not.toContainText('Recorded'); // the chip says it: no toast over it (decision 264)
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

// Decision 249: a video or any file over the 10 MB attachment limit, picked on the phone and copied by Android straight
// into the chat's folder (never through the app's memory); the model is told where it is and how to look at a video.
// Decision 262: that is "Attach a file or image" itself – a small file picked with it is attached as before.
test('📎 › Attach a file or image: a 150 MB video goes into the chat folder with progress, a picture beside it is attached', async ({ app, request }) => {
  await app.addInitScript(() => {
    globalThis.__pickCalls = [];
    globalThis.__ocmShell = { status: async () => ({ available: true, installed: true }), addListener: async () => ({ remove() {} }), kill: async () => {}, exec: async () => ({ output: '', exit: 0 }) };
    let progress = null;
    globalThis.__ocmPhoneFolder = {
      addListener: async (name, fn) => ((progress = fn), { remove: () => (progress = null) }),
      pickForChat: async (o) => {
        globalThis.__pickCalls.push(o);
        progress?.({ done: 64 * 1048576, total: 150 * 1048576, name: 'birthday trip.mp4' });
        await new Promise((r) => setTimeout(r, 300));
        // a 1×1 PNG, small: its bytes come back
        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        return { files: [{ name: 'birthday trip.mp4', size: 150 * 1048576, mime: 'video/mp4', copied: true }, { name: 'cake.png', size: 70, mime: 'image/png', data: png }] };
      },
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#attach-btn');
  // one item for any file: no separate "Video or big file", and no prompt test / inspector here (they are in the chat's ⋮)
  await expect(app.locator('#compose-menu')).not.toContainText('Video or big file');
  await expect(app.locator('#compose-menu')).not.toContainText('Prompt test');
  await expect(app.locator('#compose-menu')).not.toContainText('Inspect the prompt');
  await app.click('#cmp-attach');
  await expect(app.locator('#toast')).toContainText("Copying birthday trip.mp4 into the chat's folder… 64 MB of 150 MB");
  await expect(app.locator('#attachments')).toContainText('birthday trip.mp4');
  await expect(app.locator('#toast')).toContainText("birthday trip.mp4 (150 MB) is in this chat's folder (uploads/)");
  await expect(app.locator('#attachments img')).toHaveCount(1); // the picture, attached as a picture
  const calls = await app.evaluate(() => globalThis.__pickCalls);
  expect(calls).toHaveLength(1);
  expect(calls[0].dir).toMatch(/^work\/[\w.-]+\/uploads$/);
  expect(calls[0].inline).toBe(10 * 1024 * 1024);
  await send(app, 'what happens in this video?');
  const req = await lastRequest(request);
  const last = req.messages.at(-1);
  const text = (Array.isArray(last.content) ? last.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : last.content);
  expect(text).toContain('<video name="birthday trip.mp4" info="video, 150 MB, in the chat\'s folder">');
  // Linux is installed but this chat has no shell tool: the note says so instead of pointing at a shell it cannot use (decision 275)
  expect(text).toContain("in this chat's folder on the phone as uploads/birthday trip.mp4");
  expect(text).toContain('this chat has no shell tool');
});

test('without the phone (the browser\'s picker) a big file is refused, saying the phone takes any size', async ({ app }) => {
  await app.click('#attach-btn');
  await expect(app.locator('#cmp-attach')).toBeVisible();
  await app.evaluate(() => document.querySelectorAll('.sheet.open').forEach((x) => x.querySelector('[data-close]')?.click()));
  await app.setInputFiles('#file-input', { name: 'huge.log', mimeType: 'text/plain', buffer: Buffer.alloc(11 * 1024 * 1024, 97) });
  await expect(app.locator('#toast')).toContainText('huge.log is too large to attach');
  await expect(app.locator('#toast')).toContainText('📎 › Attach a file or image takes any size');
});
