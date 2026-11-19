import { test, expect } from './helpers.js';

const fake = () => {
  const ls = {};
  const emit = (n, e) => (ls[n] || []).forEach((f) => f(e));
  globalThis.__spoken = [];
  globalThis.__heard = ['hello there', '', ''];
  globalThis.__ocmSpeech = {
    addListener: (n, f) => ((ls[n] ||= []).push(f), Promise.resolve({ remove: () => (ls[n] = ls[n].filter((x) => x !== f)) })),
    speak: async ({ text, id }) => {
      globalThis.__spoken.push(text);
      setTimeout(() => emit('speechDone', { id, how: 'done' }), 30);
    },
    stop: async () => {},
    micPermission: async () => ({ granted: true }),
    startLive: async () => {
      const t = globalThis.__heard.shift() ?? '';
      setTimeout(() => {
        if (t) emit('livePartial', { text: t.split(' ')[0] });
        setTimeout(() => (t ? emit('liveResult', { text: t }) : emit('liveEnd', { error: 'silence' })), 40);
      }, 40);
    },
    stopLive: async () => {},
    listen: async () => ({ text: '' }),
    voices: async () => ({ voices: [], engines: [] }),
  };
};

test('voice mode: hears you, sends it, reads the reply aloud as it comes, listens again, pauses after silence', async ({ app }) => {
  await app.addInitScript(fake);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.fill('#input', '/voice');
  await app.click('#send-btn');
  await expect(app.locator('#voice-mode')).toBeVisible();
  await expect(app.locator('.msg.user').last()).toContainText('hello there');
  await expect(app.locator('#voice-mode')).toHaveAttribute('data-phase', 'paused', { timeout: 20000 });
  const spoken = await app.evaluate(() => globalThis.__spoken);
  expect(spoken.join(' ')).toContain('Reply 1.');
  await app.click('#vm-end');
  await expect(app.locator('#voice-mode')).toBeHidden();
});
