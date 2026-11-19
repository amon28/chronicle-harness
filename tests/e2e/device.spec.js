import { test, expect } from './helpers.js';

test.use({ appSettings: { prefs: { tools: true } } });

test('calendar add asks with the time, then writes the event', async ({ app }) => {
  await app.addInitScript(() => {
    globalThis.__added = [];
    globalThis.__ocmDevice = { status: async () => ({ batteryFree: true, allFiles: false }), addEvent: async (e) => (globalThis.__added.push(e), { id: 9, calendar: 'Personal' }) };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.fill('#input', 'CALENDARME dentist friday 3pm');
  await app.click('#send-btn');
  await expect(app.locator('#ask-sheet')).toContainText('Add to your calendar?');
  await expect(app.locator('#ask-sheet')).toContainText('Fri 20 Nov 2026 15:00–16:00');
  await app.click('#ask-options .menu-item:has-text("Add it")');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 15000 });
  await expect(app.locator('.msg.assistant').last()).toContainText('Calendar: Added “Dentist”');
  const added = await app.evaluate(() => globalThis.__added);
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ title: 'Dentist', allDay: false, reminderMinutes: 30 });
  expect(added[0].end - added[0].start).toBe(3600e3);
});
