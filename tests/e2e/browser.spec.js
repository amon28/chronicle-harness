import { test, expect } from './helpers.js';

const fake = () => {
  let frame;
  globalThis.__ocmBrowser = {
    open: async () => {
      frame?.remove();
      frame = document.createElement('iframe');
      frame.style.cssText = 'position:fixed;left:-9999px;width:390px;height:844px';
      frame.srcdoc = '<title>Greeter</title><h1>Welcome</h1><label for=n>Your name</label><input id=n type=text><button onclick="document.getElementById(\'out\').textContent=\'Hello \'+document.getElementById(\'n\').value">Greet</button><a href="https://example.test/about">About us</a><div id=out></div>';
      document.body.append(frame);
      await new Promise((r) => (frame.onload = r));
      return { url: 'https://example.test/form', title: 'Greeter' };
    },
    eval: async ({ js }) => ({ value: JSON.stringify(frame.contentWindow.eval(js.split('location.href').join("'https://example.test/form'"))) }),
    screenshot: async () => ({ base64: '', width: 1, height: 1 }),
    close: async () => {
      globalThis.__browserClosed = true;
      frame?.remove();
    },
  };
};

test.use({ appSettings: { prefs: { tools: true, toolBrowser: true } } });

test('browser control: open a page, type into a field, click a button, and close itself when idle', async ({ app }) => {
  await app.addInitScript(() => (globalThis.__ocmBrowserIdleMs = 2500));
  await app.addInitScript(fake);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.fill('#input', 'BROWSEME greet me');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 25000 });
  await expect(app.locator('.tool-card', { hasText: 'Browser' })).toHaveCount(3);
  // the last page read shows the page changed by the click
  await expect(app.locator('.tool-card').last()).toContainText('Hello Ada');
  await expect.poll(() => app.evaluate(() => globalThis.__browserClosed)).toBe(true);
});

test('handoff: the page is put on screen for the user, and the assistant continues after Done', async ({ app }) => {
  await app.addInitScript(() => {
    globalThis.__shown = [];
    let frame;
    globalThis.__ocmBrowser = {
      open: async () => {
        frame?.remove();
        frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;left:-9999px;width:390px;height:844px';
        frame.srcdoc = '<title>Login</title><h1>Sign in</h1><button>Continue</button>';
        document.body.append(frame);
        await new Promise((r) => (frame.onload = r));
        return {};
      },
      eval: async ({ js }) => ({ value: JSON.stringify(frame.contentWindow.eval(js.split('location.href').join("'https://example.test/login'"))) }),
      show: async (o) => (globalThis.__shown.push(o.message), { done: true }),
      screenshot: async () => ({ base64: '', width: 1, height: 1 }),
      close: async () => frame?.remove(),
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.fill('#input', 'BROWSEHAND log me in');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 25000 });
  expect(await app.evaluate(() => globalThis.__shown)).toEqual(['Please sign in, then tap Done']);
  await expect(app.locator('.tool-card', { hasText: 'Browser' })).toHaveCount(2);
});

test('handoff waits for the page to stop moving after Done (a sign-in handler forwarding back), then reads the page it lands on', async ({ app }) => {
  await app.addInitScript(() => {
    let frame;
    globalThis.__url = 'https://example.test/login';
    globalThis.__ocmBrowser = {
      open: async () => {
        frame?.remove();
        frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;left:-9999px;width:390px;height:844px';
        frame.srcdoc = '<title>Login</title><h1>Sign in</h1><button>Continue</button>';
        document.body.append(frame);
        await new Promise((r) => (frame.onload = r));
        return {};
      },
      eval: async ({ js }) => ({ value: JSON.stringify(frame.contentWindow.eval(js.split('location.href').join(JSON.stringify(globalThis.__url)))) }),
      // Done: the page goes on to the auth handler, and 2 s later forwards back to the site, signed in
      show: async () => {
        globalThis.__url = 'https://example.test/__/auth/handler?code=x';
        frame.contentDocument.body.innerHTML = '';
        setTimeout(() => {
          globalThis.__url = 'https://example.test/app';
          frame.contentDocument.body.innerHTML = '<h1>Signed in as Ada</h1>';
        }, 2000);
        return { done: true };
      },
      screenshot: async () => ({ base64: '', width: 1, height: 1 }),
      close: async () => frame?.remove(),
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.fill('#input', 'BROWSEHAND log me in');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  await expect(app.locator('.tool-card', { hasText: 'Browser' }).last()).toContainText('Signed in as Ada');
});

test('monitor button: shows only while a browser page is open, and puts the page on screen to watch', async ({ app }) => {
  await app.addInitScript(() => {
    globalThis.__ocmBrowserIdleMs = 1500;
    globalThis.__shown = [];
    globalThis.__seen = [];
    let frame;
    globalThis.__ocmBrowser = {
      open: async () => {
        frame?.remove();
        frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;left:-9999px;width:390px;height:844px';
        frame.srcdoc = '<title>Login</title><h1>Sign in</h1><button>Continue</button>';
        document.body.append(frame);
        await new Promise((r) => (frame.onload = r));
        return {};
      },
      eval: async ({ js }) => ({ value: JSON.stringify(frame.contentWindow.eval(js.split('location.href').join("'https://example.test/login'"))) }),
      show: async (o) => {
        globalThis.__shown.push(o.view ? 'view' : 'handoff');
        if (!o.view) { globalThis.__seen.push(!document.querySelector('#browser-view-btn').hidden); document.querySelector('#browser-view-btn').click(); }
        return { done: true };
      },
      screenshot: async () => ({ base64: '', width: 1, height: 1 }),
      close: async () => frame?.remove(),
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await expect(app.locator('#browser-view-btn')).toBeHidden();
  await app.fill('#input', 'BROWSEHAND log me in');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 25000 });
  expect(await app.evaluate(() => globalThis.__seen)).toEqual([true]);
  expect(await app.evaluate(() => globalThis.__shown)).toEqual(['handoff', 'view']);
  await expect(app.locator('#browser-view-btn')).toBeVisible(); // stays open between replies
  await expect(app.locator('#browser-view-btn')).toBeHidden({ timeout: 5000 }); // closes when idle
});
