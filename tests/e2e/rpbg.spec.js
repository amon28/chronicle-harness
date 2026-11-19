import { test, expect } from './helpers.js';

const svg = (c) => 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="4000"><rect width="4000" height="4000" fill="${c}"/></svg>`).toString('base64');
const ch = (id, name, color) => ({ id, name, rp: true, cardMode: true, prompt: `You are ${name}.`, avatar: { image: svg(color) }, card: { name, description: name, first_mes: `Hi, I am ${name}.` } });
const PERSONAS = [ch('c_red', 'Red', '#ff0000'), ch('c_green', 'Green', '#00ff00'), ch('c_blue', 'Blue', '#0000ff')];
const conv = (id, pid, t) => ({ id, title: `Chat ${pid}`, createdAt: t, updatedAt: t, personaId: pid, messages: [{ role: 'assistant', content: 'Hello', personaId: pid, at: t }] });

test.use({ appSettings: { personas: PERSONAS, prefs: { rpBg: 'card', mode: 'rp' } } });

test('each roleplay chat shows its own character as the background, also when switching back', async ({ app }) => {
  await app.evaluate(
    (convs) =>
      new Promise((resolve) => {
        const q = indexedDB.open('chronicle');
        q.onsuccess = () => {
          const t = q.result.transaction('conversations', 'readwrite');
          convs.forEach((c) => t.objectStore('conversations').put(c));
          t.oncomplete = resolve;
        };
      }),
    [conv('k1', 'c_red', 3000), conv('k2', 'c_green', 2000), conv('k3', 'c_blue', 1000)],
  );
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  const bgOf = () =>
    app.evaluate(async () => {
      const u = getComputedStyle(document.getElementById('chat-bg')).getPropertyValue('--bg-url').trim().replace(/^url\("?|"?\)$/g, '');
      if (!u) return 'none';
      const img = new Image();
      img.src = u;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = 4;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, 4, 4);
      const [r, gr, b] = g.getImageData(1, 1, 1, 1).data;
      return r > 200 ? 'red' : gr > 200 ? 'green' : b > 200 ? 'blue' : 'other';
    });
  const open = async (title) => {
    await app.click('#menu-btn');
    await app.click(`.conv-item:has-text("${title}")`);
    await app.waitForTimeout(400);
    return bgOf();
  };
  const seen = {};
  for (const [t, pid] of [['Chat c_red', 'c_red'], ['Chat c_green', 'c_green'], ['Chat c_blue', 'c_blue'], ['Chat c_red', 'c_red']]) seen[pid] = [...(seen[pid] || []), await open(t)];
  console.log(JSON.stringify(seen));
  expect(seen).toEqual({ c_red: ['red', 'red'], c_green: ['green'], c_blue: ['blue'] });
});

test.describe('card art vs avatar', () => {
  test.use({ appSettings: { personas: [{ ...ch('c_art', 'Arty', '#00ff00'), hasArt: true }], prefs: { rpBg: 'avatar', mode: 'rp' } } });
  test('"Character avatar" uses the avatar even when the character has card art; a slow picture never leaves the old one up', async ({ app }) => {
    await app.evaluate(
      (c) =>
        new Promise((resolve) => {
          const q = indexedDB.open('chronicle');
          q.onsuccess = () => {
            const t = q.result.transaction(['conversations', 'kv'], 'readwrite');
            t.objectStore('conversations').put(c);
            t.objectStore('kv').put(c.__art, 'art:c_art');
            t.oncomplete = resolve;
          };
        }),
      { ...conv('a1', 'c_art', 5000), __art: svg('#ff0000') },
    );
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await app.click('#menu-btn');
    await app.click('.conv-item:has-text("Chat c_art")');
    await app.waitForTimeout(500);
    const url = await app.evaluate(() => getComputedStyle(document.getElementById('chat-bg')).getPropertyValue('--bg-url'));
    expect(url).not.toBe('');
    const color = await app.evaluate(async () => {
      const u = getComputedStyle(document.getElementById('chat-bg')).getPropertyValue('--bg-url').trim().replace(/^url\("?|"?\)$/g, '');
      const img = new Image();
      img.src = u;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = 4;
      c.getContext('2d').drawImage(img, 0, 0, 4, 4);
      const [r, g] = c.getContext('2d').getImageData(1, 1, 1, 1).data;
      return r > 200 ? 'red (card art)' : g > 200 ? 'green (avatar)' : 'other';
    });
    expect(color).toBe('green (avatar)');
  });
});
