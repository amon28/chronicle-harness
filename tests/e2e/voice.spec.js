import { test, expect, send } from './helpers.js';
import { fileURLToPath } from 'node:url';

// Stand-ins for the phone's speech engine and recogniser (the browser in the tests has neither).
async function withFakeSpeech(app) {
  await app.addInitScript(() => {
    window.__spoken = [];
    const voices = [
      { name: 'Alice', lang: 'en-US', localService: true },
      { name: 'Bob', lang: 'en-GB', localService: true },
    ];
    window.__voiced = [];
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { getVoices: () => voices, speak: (u) => (window.__spoken.push(u.text), window.__voiced.push(u.voice?.name || null), setTimeout(() => u.onend?.(), 300)), cancel: () => {} },
    });
    window.SpeechSynthesisUtterance = function (t) {
      this.text = t;
    };
    window.SpeechRecognition = window.webkitSpeechRecognition = function () {
      this.start = () =>
        setTimeout(() => {
          this.onresult?.({ results: [[{ transcript: 'hello from my voice' }]] });
          this.onend?.();
        }, 30);
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
}
const spoken = (app) => app.evaluate(() => window.__spoken);

test('read a reply aloud from its ⋯ menu (no markdown or code read out)', async ({ app }) => {
  await withFakeSpeech(app);
  await send(app, 'hello');
  await app.locator('.msg.assistant').last().locator('.act-more').click();
  await app.click('#mm-speak');
  await expect(app.locator('#tts-pill')).toBeVisible();
  await expect.poll(() => spoken(app)).toHaveLength(1);
  const [t] = await spoken(app);
  expect(t).toContain('Here is bold and code');
  expect(t).not.toContain('**');
  expect(t).not.toContain('console.log');
  await expect(app.locator('#tts-pill')).toBeHidden();
});

test('dictate a message with the mic button', async ({ app }) => {
  await withFakeSpeech(app);
  await expect(app.locator('#mic-btn')).toBeVisible();
  await app.fill('#input', 'So:');
  await app.click('#mic-btn');
  await expect(app.locator('#input')).toHaveValue('So: hello from my voice');
});

test.describe('auto-read in roleplay', () => {
  test.use({ appSettings: { prefs: { ttsAuto: true, ttsDialogue: true } } });
  test('new replies are read aloud – only the dialogue in roleplay', async ({ app }) => {
    await withFakeSpeech(app);
    await app.click('#menu-btn');
    await app.click('#open-personas');
    await app.setInputFiles('#card-file', fileURLToPath(new URL('./fixtures/seraphina.png', import.meta.url)));
    await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
    await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
    await app.click('.persona-pick:has-text("Seraphina")');
    await app.click('#cv-chat');
    await send(app, 'QUOTEDREPLY please');
    await expect.poll(() => spoken(app)).toEqual(['Welcome home, … Sit down.']);
  });
});

test('each persona can have its own voice', async ({ app }) => {
  await withFakeSpeech(app);
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.click('#persona-list .persona-item:has-text("Assistant")');
  await app.click('#pe-voice-box summary');
  await expect(app.locator('#pe-voice option')).toHaveCount(3); // default + 2 voices
  await app.selectOption('#pe-voice', 'Bob');
  await expect(app.locator('#pe-voice-sum')).toContainText('Bob');
  await app.click('#pe-voice-test');
  await expect.poll(() => app.evaluate(() => window.__voiced)).toEqual(['Bob']);
  await app.click('#pe-save');
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));

  await send(app, 'hello');
  await app.locator('.msg.assistant').last().locator('.act-more').click();
  await app.click('#mm-speak');
  await expect.poll(() => app.evaluate(() => window.__voiced)).toEqual(['Bob', 'Bob']);
});
