import { test, expect, send, closeSheets } from './helpers.js';
import { MOCK } from './helpers.js';

test.use({ appSettings: { prefs: { tools: true } } });

// the scheduler stand-in keeps the page's "wake" listener, so a test can wake the page as Android would
const scheduler = () => {
  globalThis.__ocmScheduler = { plan: async () => ({ exact: true }), status: async () => ({ exact: true }), ack: async () => {}, addListener: async (ev, fn) => ((globalThis.__wake = fn), { remove() {} }) };
};
const openPrivate = async (app) => {
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="tools"]');
  await expect(app.locator('#open-private')).toBeVisible();
  await app.click('#open-private');
  await expect(app.locator('#private-sheet')).toHaveClass(/open/);
};
const answer = async (app, text, option) => {
  await expect(app.locator('#ask-sheet')).toContainText(text);
  await app.click(`#ask-options .menu-item:has-text("${option}")`);
};
const settled = (app) => app.waitForFunction(() => !document.body.classList.contains('streaming') && !document.querySelector('#ask-sheet.open'), null, { timeout: 20000 });
const toolResults = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages).flatMap((r) => r.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)));

test('notifications: off by default; allowed apps only, codes hidden; a notification trigger runs a quiet task', async ({ app, request }) => {
  await app.addInitScript(scheduler);
  await app.addInitScript(() => {
    globalThis.__cfg = [];
    globalThis.__events = [];
    globalThis.__ocmNotify = {
      status: async () => ({ enabled: true, connected: true, sdk: 34 }),
      apps: async () => ({ apps: [{ pkg: 'com.whatsapp', label: 'WhatsApp' }, { pkg: 'com.dhl.app', label: 'DHL' }, { pkg: 'com.authy.authy', label: 'Authy' }] }),
      list: async () => ({ items: [{ key: 'k1', app: 'com.dhl.app', label: 'DHL', title: 'Parcel', text: 'Locker code 482913, valid today', time: Date.now() }, { key: 'k2', app: 'com.authy.authy', label: 'Authy', title: 'Token', text: 'SECRET-TOKEN', time: Date.now() }] }),
      setConfig: async (o) => void globalThis.__cfg.push(o),
      takeEvents: async () => ({ events: globalThis.__events.splice(0) }),
      openSettings: async () => ({ opened: true }),
      openAppInfo: async () => ({ opened: true }),
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  // off: no tool
  await send(app, 'hello');
  let req = (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages).pop();
  expect(req.tools.map((t) => t.function.name)).not.toContain('notifications');

  await openPrivate(app);
  await expect(app.locator('#priv-notifications')).not.toBeChecked();
  await expect(app.locator('#private-sheet')).toContainText('goes to your AI provider');
  await app.locator('#priv-notifications').check();
  await expect(app.locator('#priv-apps input[data-pkg]')).toHaveCount(3);
  await expect(app.locator('#private-sheet')).toContainText('Allow restricted settings');
  await expect(app.locator('#priv-apps input[data-pkg="com.whatsapp"]')).not.toBeChecked(); // a messaging app is never ticked for you
  await expect(app.locator('#priv-apps label:has(input[data-pkg="com.whatsapp"])')).toContainText('messages');
  await expect(app.locator('#priv-apps input[data-pkg="com.authy.authy"]')).toBeDisabled(); // codes and passwords: never
  await app.locator('#priv-apps input[data-pkg="com.dhl.app"]').check();
  await expect.poll(() => app.evaluate(() => JSON.stringify(globalThis.__cfg.at(-1)))).toBe(JSON.stringify({ enabled: true, apps: ['com.dhl.app'], triggers: [] }));
  await closeSheets(app);

  // list: asked once per chat; only DHL; the code is hidden
  await app.fill('#input', 'DOCALLS [["notifications",{"action":"list"}]]');
  await app.click('#send-btn');
  await answer(app, 'read your notifications from DHL', 'Allow');
  await settled(app);
  await expect(app.locator('.msg.assistant').last()).toContainText('RESULTS: 1 notification from allowed apps');
  const listed = (await toolResults(request)).find((c) => c.includes('notification from allowed apps'));
  expect(listed).toContain('Locker code [code hidden]');
  expect(listed).toContain('untrusted data');
  expect(listed).not.toContain('482913');
  expect(listed).not.toContain('SECRET-TOKEN');

  // a trigger: the user confirms it; Android gets it
  await app.fill('#input', 'DOCALLS [["schedule_task",{"prompt":"Tell me when the parcel can be picked up","when":{"notification":{"app":"DHL","contains":"parcel"}}}]]');
  await app.click('#send-btn');
  await answer(app, 'When a notification from DHL containing “parcel” arrives', 'Set it up');
  await settled(app);
  await expect.poll(() => app.evaluate(() => globalThis.__cfg.at(-1)?.triggers?.length || 0)).toBe(1);
  const trig = await app.evaluate(() => globalThis.__cfg.at(-1).triggers[0]);
  expect(trig).toMatchObject({ app: 'com.dhl.app', contains: 'parcel' });
  const before = await app.locator('#messages > .msg').count();
  // a matching notification arrives: Android keeps it and wakes the page
  await app.evaluate((t) => {
    globalThis.__events.push({ kind: 'notification', taskId: t.id, convId: t.convId, app: 'com.dhl.app', appLabel: 'DHL', title: 'Your parcel', text: 'Ready at the locker, code 4417', at: Date.now() });
    globalThis.__wake({ due: [] });
  }, trig);
  await expect(app.locator('.msg.user').last()).toContainText('⚡ Trigger', { timeout: 15000 });
  await expect(app.locator('.msg.user').last()).toContainText('[code hidden]');
  await expect(app.locator('.msg.user').last()).not.toContainText('4417');
  await expect(app.locator('.msg.assistant').last()).toContainText('Reply #', { timeout: 15000 });
  expect(await app.locator('#messages > .msg').count()).toBe(before + 2);
  await app.click('#sched-btn');
  await expect(app.locator('#sched-list .sched-row')).toContainText('🔔 notification · DHL containing “parcel”');
});

test('texts: asked every time with the search shown; never in a scheduled check', async ({ app, request }) => {
  await app.addInitScript(() => {
    globalThis.__searches = [];
    globalThis.__ocmMessages = {
      smsSearch: async (o) => (globalThis.__searches.push(o), { messages: [{ address: 'DHL', body: 'Your DHL verification code is 5521', date: Date.now(), type: 'inbox', read: true }] }),
      calls: async () => ({ calls: [] }),
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await openPrivate(app);
  await expect(app.locator('#priv-messages')).not.toBeChecked();
  await expect(app.locator('#private-sheet')).toContainText('It asks you EVERY time');
  await app.locator('#priv-messages').check();
  await closeSheets(app);
  for (let i = 0; i < 2; i++) {
    await app.fill('#input', 'DOCALLS [["messages",{"action":"sms_search","from":"DHL"}]]');
    await app.click('#send-btn');
    await answer(app, 'search your text messages from “DHL”', 'Search');
    await settled(app);
  }
  expect(await app.evaluate(() => globalThis.__searches.length)).toBe(2);
  await expect(app.locator('.msg.assistant').last()).toContainText('RESULTS: 1 text message from “DHL”');
  expect((await toolResults(request)).find((c) => c.includes('1 text message from'))).toContain('verification code is [code hidden]');

  // a quiet scheduled check may not read texts: refused without a question
  await app.evaluate(async () => {
    const t = Date.now();
    const conv = { id: 'smsq', title: 'Texts check', createdAt: t, updatedAt: t, personaId: 'general', messages: [{ role: 'user', content: 'hi', at: t }, { role: 'assistant', content: 'Hello.', personaId: 'general', model: 'glm-5.3', at: t }], schedules: [{ id: 'st_sms', prompt: 'DOCALLS [["messages",{"action":"sms_search","query":"DHL"}]]', next: t + 3600000, every: 60, quiet: true, created: t }] };
    await new Promise((res) => { const r = indexedDB.open('chronicle'); r.onsuccess = () => { const tx = r.result.transaction('conversations', 'readwrite'); tx.objectStore('conversations').put(conv); tx.oncomplete = res; }; });
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.click('.conv-title:has-text("Texts check")');
  await app.click('#sched-btn');
  await app.click('#sched-list button:has-text("Run now")');
  await expect(app.locator('#sched-list .sched-history')).toContainText('never in scheduled checks', { timeout: 20000 });
  await expect(app.locator('#ask-sheet')).not.toHaveClass(/open/);
  expect(await app.evaluate(() => globalThis.__searches.length)).toBe(0);
});

test('place triggers: background location explained and asked; arriving runs the quiet task; shown in Scheduled', async ({ app }) => {
  await app.addInitScript(scheduler);
  await app.addInitScript(() => {
    globalThis.__syncs = [];
    globalThis.__events = [];
    globalThis.__bg = false;
    globalThis.__ocmGeofence = {
      status: async () => ({ sdk: 34, fine: true, coarse: true, background: globalThis.__bg, locationOn: true, label: 'Allow all the time' }),
      askBackground: async () => ((globalThis.__bg = true), { fine: true, background: true }),
      sync: async (o) => (globalThis.__syncs.push(o.places), { armed: o.places.length }),
      takeEvents: async () => ({ events: globalThis.__events.splice(0) }),
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await openPrivate(app);
  await app.locator('#priv-places').check();
  await expect(app.locator('#private-sheet')).toContainText('Location in the background: not allowed');
  await expect(app.locator('#private-sheet')).toContainText('Android 11 and newer only allow it on the settings page');
  await expect(app.locator('#private-sheet')).toContainText('battery');
  await app.click('#priv-ask-bg');
  await expect(app.locator('#private-sheet')).toContainText('Location in the background: allowed');
  await closeSheets(app);

  await app.fill('#input', 'DOCALLS [["schedule_task",{"prompt":"Remind me to water the plants","when":{"place":{"lat":52.52,"lon":13.405,"radius_m":200,"on":"arrive","label":"Home"}}}]]');
  await app.click('#send-btn');
  await answer(app, 'When you arrive at Home (200 m)', 'Set it up');
  await settled(app);
  await expect.poll(() => app.evaluate(() => globalThis.__syncs.at(-1)?.length || 0)).toBe(1);
  const place = await app.evaluate(() => globalThis.__syncs.at(-1)[0]);
  expect(place).toMatchObject({ lat: 52.52, lon: 13.405, radius: 200, on: 'arrive', label: 'Home' });
  await app.click('#sched-btn');
  await expect(app.locator('#sched-list .sched-row')).toContainText('📍 place · arrive Home (200 m)');
  await closeSheets(app);
  await app.evaluate((p) => {
    globalThis.__events.push({ kind: 'place', taskId: p.id, convId: p.convId, on: 'arrive', at: Date.now() });
    globalThis.__wake({ due: [] });
  }, place);
  await expect(app.locator('.msg.user').last()).toContainText('The phone arrived at Home', { timeout: 15000 });
  await expect(app.locator('.msg.assistant').last()).toContainText('Reply #', { timeout: 15000 });
});
