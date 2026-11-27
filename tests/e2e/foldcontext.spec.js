import { test, expect, send, MOCK } from './helpers.js';

// decision 147: compaction without a model call, and the folded messages stay readable
const requests = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);
const sys = (r) => String(r.messages[0]?.content || '');
const summaryAsked = (reqs) => reqs.some((r) => /^You compress/.test(sys(r)));

async function putConv(app, conv, mode = '') {
  await app.evaluate(async (conv) => {
    await new Promise((res) => {
      const r = indexedDB.open('chronicle');
      r.onsuccess = () => {
        const tx = r.result.transaction('conversations', 'readwrite');
        tx.objectStore('conversations').put(conv);
        tx.oncomplete = res;
      };
    });
  }, conv);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  if (mode) await app.evaluate((m) => document.querySelector(`.mode-tab[data-mode="${m}"]`)?.click(), mode);
  await app.click('#menu-btn');
  await app.click(`.conv-title:has-text("${conv.title}")`);
}

test.describe('structured compaction', () => {
  test.use({ appSettings: { prefs: { tools: true, agentMode: 'auto', compactStyle: 'structured' } } });
  test('/compact folds the older messages without asking a model, and read_chat "this" reads them back', async ({ app, request }) => {
    await send(app, 'DOCALLS [["write_file",{"path":"notes.txt","content":"hello"}]]');
    await expect(app.locator('.msg.assistant').last()).toContainText('RESULTS: Wrote notes.txt');
    for (const t of ['remember the code word PELICAN', 'two', 'three']) await send(app, t);
    await request.post(MOCK + '/__reset');
    await app.fill('#input', '/compact');
    await app.click('#send-btn');
    await expect(app.locator('.summary-divider')).toContainText('folded into a structured record');
    expect(await requests(request)).toEqual([]); // nothing was sent: no summary request at all
    await send(app, 'what now?');
    const reqs = await requests(request);
    expect(summaryAsked(reqs)).toBe(false);
    const s = sys(reqs.at(-1));
    expect(s).toContain('[Structured record of messages #0–#3');
    expect(s).toContain('#0: DOCALLS [["write_file"');
    expect(s).toContain('#2: remember the code word PELICAN');
    expect(s).toContain('created: notes.txt');
    // the folded messages are only out of the prompt: the model can read them, tool results included
    await send(app, 'DOCALLS [["read_chat",{"id":"this"}]]');
    await expect(app.locator('.msg.assistant').last()).toContainText('RESULTS: This chat, messages #0–#3');
    const last = (await requests(request)).at(-1);
    const result = last.messages.filter((m) => m.role === 'tool').at(-1).content;
    expect(result).toContain('[write_file notes.txt] → Wrote notes.txt');
    expect(result).toContain('PELICAN');
  });
});

test.describe('structured compaction when the provider refuses a long request', () => {
  test.use({ appSettings: { prefs: { compactStyle: 'structured' } } });
  test('the older messages are folded into the record at once and the request fits', async ({ app, request }) => {
    const t = Date.now();
    const messages = [];
    for (let i = 0; i < 30; i++) messages.push(i % 2 ? { role: 'assistant', content: `Answer ${i}. ` + 'words '.repeat(330), personaId: 'general', model: 'glm-5.3', at: t } : { role: 'user', content: `Question ${i}. ` + 'words '.repeat(330), at: t });
    await putConv(app, { id: 'long2', title: 'Long structured', createdAt: t, updatedAt: t, personaId: 'general', messages });
    await send(app, 'TOOLONG what now?');
    await expect(app.locator('.msg.assistant').last()).toContainText('It fits now');
    const reqs = (await requests(request)).filter((r) => JSON.stringify(r.messages).includes('TOOLONG'));
    expect(reqs.length).toBe(2);
    expect(sys(reqs[1])).toContain('[Structured record of messages #0–');
    expect(sys(reqs[1])).toContain('Question 0.'); // the first question survives, in the record
    expect(JSON.stringify(reqs[1].messages).length).toBeLessThan(20000);
    expect(summaryAsked(await requests(request))).toBe(false);
    // stored with the chat: opened again, the divider says what happened
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await app.click('#menu-btn');
    await app.click('.conv-title:has-text("Long structured")');
    await expect(app.locator('.summary-divider')).toContainText('structured record');
  });
});

test.describe('roleplays are not affected', () => {
  test.use({ appSettings: { prefs: { compactStyle: 'structured' } } });
  test('/compact in a roleplay still asks the model for a summary', async ({ app, request }) => {
    const t = Date.now();
    const messages = [];
    for (let i = 0; i < 10; i++) messages.push(i % 2 ? { role: 'assistant', content: `*waves* line ${i}`, personaId: 'roleplay', model: 'glm-5.3', at: t } : { role: 'user', content: `hello ${i}`, at: t });
    await putConv(app, { id: 'rp2', title: 'RP structured', createdAt: t, updatedAt: t, personaId: 'roleplay', messages }, 'rp');
    await request.post(MOCK + '/__reset');
    await app.fill('#input', '/compact');
    await app.click('#send-btn');
    await expect.poll(async () => summaryAsked(await requests(request))).toBe(true);
  });
});
